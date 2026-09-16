"""Batch-scoped flock slots and FIFO admission for Node-owned GPT requests."""
import argparse
import asyncio
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import select
import sys
import time


def _slot_paths(root, provider, limit):
    if limit < 1:
        raise ValueError('Provider slot limit must be positive')
    directory = Path(root) / '.provider-slots' / provider
    directory.mkdir(parents=True, exist_ok=True)
    return [directory / f'slot-{index}.lock' for index in range(limit)]


def _try_acquire(paths):
    for path in paths:
        handle = path.open('a+b')
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.close()
        except BaseException:
            handle.close()
            raise
        else:
            return handle
    return None


@contextmanager
def acquire_slot(root, provider, limit, *, on_wait=None):
    """Legacy reservations reuse these slots. Close only; never LOCK_UN."""
    paths = _slot_paths(root, provider, limit)
    handle = _try_acquire(paths)
    if handle is None and on_wait is not None:
        on_wait()
    while handle is None:
        time.sleep(0.1)
        handle = _try_acquire(paths)
    try:
        yield handle
    finally:
        handle.close()


@asynccontextmanager
async def acquire_slot_async(root, provider, limit, *, on_wait=None):
    paths = _slot_paths(root, provider, limit)
    handle = _try_acquire(paths)
    if handle is None and on_wait is not None:
        on_wait()
    while handle is None:
        await asyncio.sleep(0.1)
        handle = _try_acquire(paths)
    try:
        yield handle
    finally:
        handle.close()


def _audit(directory, event, metadata, slot=None):
    record = {**metadata, 'event': event, 'at': datetime.now(timezone.utc).isoformat(), 'slot': slot}
    fd = os.open(directory / 'audit.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, (json.dumps(record, ensure_ascii=False) + '\n').encode())
    finally:
        os.close(fd)


@contextmanager
def _queue_guard(directory):
    with (directory / 'queue.lock').open('a') as guard:
        fcntl.flock(guard.fileno(), fcntl.LOCK_EX)
        yield


def _cancelled():
    ready, _, _ = select.select([sys.stdin], [], [], 0)
    return bool(ready) and os.read(sys.stdin.fileno(), 1) == b''


def _oldest_live_ticket(directory, own_ticket):
    for path in sorted((directory / 'queue').glob('*.ticket')):
        if path == own_ticket:
            return path
        with path.open('r+') as probe:
            try:
                fcntl.flock(probe.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return path
            metadata = json.load(probe)
            path.unlink()
            _audit(directory, 'cancelled', metadata)
    return None


def request_main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--limit', type=int, default=8, choices=range(1, 9))
    parser.add_argument('--request-id', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--role', required=True)
    parser.add_argument('--pid', type=int, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    directory = args.root / '.provider-slots' / 'gpt-requests'
    (directory / 'queue').mkdir(parents=True, exist_ok=True)
    metadata = {'requestId': args.request_id, 'runId': args.run_id, 'role': args.role, 'pid': args.pid}
    ticket = None
    ticket_handle = None
    try:
        if _cancelled():
            _audit(directory, 'cancelled', metadata)
            print(json.dumps({'status': 'cancelled', 'requestId': args.request_id}), flush=True)
            return 130
        with _queue_guard(directory):
            counter = directory / 'next-ticket'
            number = int(counter.read_text()) + 1 if counter.exists() else 1
            counter.write_text(str(number))
            ticket = directory / 'queue' / f'{number:020d}.ticket'
            ticket_handle = ticket.open('x+')
            fcntl.flock(ticket_handle.fileno(), fcntl.LOCK_EX)
            json.dump(metadata, ticket_handle)
            ticket_handle.flush()
            _audit(directory, 'queued', metadata)
        while True:
            if _cancelled():
                with _queue_guard(directory):
                    ticket.unlink(missing_ok=True)
                    _audit(directory, 'cancelled', metadata)
                print(json.dumps({'status': 'cancelled', 'requestId': args.request_id}), flush=True)
                return 130
            with _queue_guard(directory):
                if _oldest_live_ticket(directory, ticket) == ticket:
                    for slot in range(args.limit):
                        try:
                            fcntl.flock(3 + slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        except BlockingIOError:
                            continue
                        owner_file = directory / f'slot-{slot}.owner.json'
                        if owner_file.exists():
                            _audit(directory, 'released', json.loads(owner_file.read_text()), slot)
                        owner_file.write_text(json.dumps(metadata))
                        ticket.unlink()
                        _audit(directory, 'granted', metadata, slot)
                        print(json.dumps({'status': 'granted', 'requestId': args.request_id, 'slot': slot}), flush=True)
                        return 0
            time.sleep(0.05)
    finally:
        if ticket is not None and ticket.exists():
            with _queue_guard(directory):
                ticket.unlink(missing_ok=True)
        if ticket_handle is not None:
            ticket_handle.close()
        # These descriptors share open-file descriptions with the Node parent.
        # Its chosen descriptor retains the flock after this helper exits.
        for slot in range(args.limit):
            os.close(3 + slot)


if __name__ == '__main__':
    raise SystemExit(request_main())
