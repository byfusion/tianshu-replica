import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const moduleUrl = new URL("../src/request-slots.mjs", import.meta.url).href;
const scripts = fileURLToPath(new URL("../scripts", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out: ${message}`);
}

const workerSource = `
import readline from 'node:readline';
const {acquireRequestSlot}=await import(process.argv[1]);
const [root,runId,limit]=process.argv.slice(2);
const controller=new AbortController();
let finish;const ended=new Promise(resolve=>{finish=resolve});
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{if(line==='abort')controller.abort();if(line==='release')finish()});
input.on('close',()=>{controller.abort();finish()});
try{
 const lease=await acquireRequestSlot({root,limit:Number(limit),runId,role:'offline-request',signal:controller.signal});
 console.log(JSON.stringify({event:'granted',requestId:lease.requestId,slot:lease.slot}));
 await ended;lease.release();lease.release();
 console.log(JSON.stringify({event:'released'}));
}catch(error){console.log(JSON.stringify({event:'failed',name:error.name,message:error.message}));process.exitCode=error.name==='AbortError'?0:1}
finally{input.close();process.stdin.pause()}
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-request-slots-"));
  const workers = [];
  t.after(async () => {
    for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.stdin.end();
    await Promise.race([Promise.all(workers.map((worker) => worker.done)), delay(1500)]);
    for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    await Promise.all(workers.map((worker) => worker.done));
    fs.rmSync(root, { recursive: true, force: true });
  });
  function launch(runId, limit = 8) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", workerSource, moduleUrl, root, runId, String(limit)], { stdio: ["pipe", "pipe", "pipe"] });
    const worker = { child, runId, messages: [], stderr: "" };
    let pending = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n"); pending = lines.pop();
      for (const line of lines) if (line.trim()) worker.messages.push(JSON.parse(line));
    });
    child.stderr.on("data", (chunk) => { worker.stderr += chunk; });
    worker.done = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    worker.granted = () => worker.messages.find((message) => message.event === "granted");
    worker.send = (value) => child.stdin.write(`${value}\n`);
    workers.push(worker);
    return worker;
  }
  const audit = () => {
    const file = path.join(root, ".provider-slots/gpt-requests/audit.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  };
  const queued = (runId) => audit().some((event) => event.event === "queued" && event.runId === runId);
  return { root, workers, launch, audit, queued };
}

test("eight Node-owned slots survive helper exit, preserve FIFO and cancel queued requests", async (t) => {
  const f = fixture(t);
  const active = Array.from({ length: 8 }, (_, i) => f.launch(`A-active-${i}`));
  await until(() => active.every((worker) => worker.granted()), "all eight active leases");
  assert.equal(new Set(active.map((worker) => worker.granted().slot)).size, 8);
  // acquireRequestSlot resolves only after its Python helper has exited. The
  // ninth process must still wait: the Node descriptors own these eight locks.
  const otherDrama = f.launch("B-waiting");
  await until(() => f.queued(otherDrama.runId), "B entered FIFO");
  const refill = f.launch("A-refill");
  await until(() => f.queued(refill.runId), "later A refill entered FIFO");
  const cancelled = f.launch("C-cancelled");
  await until(() => f.queued(cancelled.runId), "C entered FIFO");
  cancelled.send("abort");
  assert.equal((await cancelled.done).code, 0);
  assert.equal(cancelled.messages.at(-1).name, "AbortError");
  assert.equal(cancelled.granted(), undefined);
  assert.ok(f.audit().some((event) => event.event === "cancelled" && event.runId === cancelled.runId));
  active[1].send("abort");
  await delay(120);
  assert.equal(otherDrama.granted(), undefined, "active abort must not release before the stream owner finishes");
  assert.equal(refill.granted(), undefined);
  active[0].send("release");
  await until(() => otherDrama.granted(), "oldest waiting drama gets the next slot");
  assert.equal(refill.granted(), undefined, "later same-drama request must not overtake B");
  otherDrama.send("release");
  await until(() => refill.granted(), "later request enters after B");
  for (const worker of [...active.slice(1), refill]) worker.send("release");
  for (const worker of f.workers) assert.equal((await worker.done).code, 0, worker.stderr);
  let live = 0, peak = 0;
  for (const event of f.audit()) {
    if (event.event === "granted") live++;
    if (event.event === "released") live--;
    peak = Math.max(peak, live);
    assert.ok(live >= 0 && live <= 8);
    assert.deepEqual(Object.keys(event).sort(), ["at", "event", "pid", "requestId", "role", "runId", "slot"]);
  }
  assert.equal(peak, 8);
  assert.equal(live, 0);
  assert.equal(fs.readdirSync(path.join(f.root, ".provider-slots/gpt-requests/queue")).length, 0);
});

test("terminating a Node holder frees its kernel lease for the queued process", async (t) => {
  const f = fixture(t), holder = f.launch("holder", 1);
  await until(() => holder.granted(), "holder acquired its lease");
  const waiting = f.launch("waiting", 1);
  await until(() => f.queued(waiting.runId), "second process queued");
  assert.equal(waiting.granted(), undefined);
  holder.child.kill("SIGTERM");
  assert.equal((await holder.done).signal, "SIGTERM");
  await until(() => waiting.granted(), "kernel releases the terminated holder's lock");
  assert.ok(f.audit().some((event) => event.event === "released" && event.requestId === holder.granted().requestId));
  waiting.send("release");
  assert.equal((await waiting.done).code, 0);
});

test("two legacy reservations leave exactly six of the shared eight slots available", async (t) => {
  const f = fixture(t);
  const code = "import sys;from pathlib import Path;from contextlib import ExitStack;sys.path.insert(0,sys.argv[1]);from provider_slots import acquire_slot\nwith ExitStack() as stack:\n for _ in range(2):stack.enter_context(acquire_slot(Path(sys.argv[2]),'gpt-requests',8))\n print('reserved',flush=True)\n sys.stdin.readline()\n";
  const legacy = spawn(process.env.TIANSHU_PYTHON || "python3", ["-c", code, scripts, f.root], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  legacy.stdout.on("data", (chunk) => { stdout += chunk; });
  legacy.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => legacy.once("close", (exitCode) => resolve(exitCode)));
  t.after(async () => { legacy.stdin.end(); await done; });
  await until(() => stdout.includes("reserved"), "legacy reservations ready");
  const active = Array.from({ length: 6 }, (_, i) => f.launch(`new-${i}`));
  await until(() => active.every((worker) => worker.granted()), "six new leases alongside legacy holders");
  const seventh = f.launch("new-seventh");
  await until(() => f.queued(seventh.runId), "seventh new process queued");
  await delay(120);
  assert.equal(seventh.granted(), undefined);
  assert.deepEqual(active.map((worker) => worker.granted().slot).sort(), [2, 3, 4, 5, 6, 7]);
  legacy.stdin.end();
  assert.equal(await done, 0, stderr);
  await until(() => seventh.granted(), "new request proceeds after legacy release");
  for (const worker of [...active, seventh]) worker.send("release");
  for (const worker of f.workers) assert.equal((await worker.done).code, 0, worker.stderr);
});
