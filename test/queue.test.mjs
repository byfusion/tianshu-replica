import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { enqueueJob, queueStatus, resolveQueuedRun, retryJob, runWorkerOnce } from "../src/queue.mjs";
import { writeExecutionContract } from "../src/execution-contract.mjs";

function fixture(t, state = "approved", runId = "三集小样-1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-queue-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "runs", runId);
  fs.mkdirSync(directory, { recursive: true });
  const agentDir = path.join(root, "credentials");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "kimi-coding": { type: "api_key", key: "offline-test-key" } }));
  writeExecutionContract(directory, { model: "kimi", agentDir });
  const setState = (value) => fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ id: runId, state: value }));
  setState(state);
  return { root, runId, directory, agentDir, setState };
}

test("empty queue exits without a child or Pi configuration", async (t) => {
  const { root } = fixture(t);
  let calls = 0;
  const result = await runWorkerOnce(root, { env: {}, execute: async () => { calls++; } });
  assert.equal(result.processed, false);
  assert.equal(calls, 0);
  assert.equal(queueStatus(root).worker, null);
});

test("enqueue is idempotent and delivered runs become producer handoffs without a child", async (t) => {
  const { root, runId } = fixture(t, "delivered");
  assert.equal(enqueueJob(root, runId).enqueued, true);
  assert.equal(enqueueJob(root, runId).enqueued, false);
  await runWorkerOnce(root, { execute: async () => assert.fail("must not regenerate") });
  const [job] = queueStatus(root).jobs;
  assert.equal(job.state, "awaiting_producer_review");
  assert.equal(job.attempts, 0);
});

test("draft planning pauses for real approval, then automatically resumes generation", async (t) => {
  const { root, runId, setState } = fixture(t, "draft");
  enqueueJob(root, runId);
  const actions = [];
  const execute = async ({ action }) => {
    actions.push(action);
    setState(action === "plan" ? "awaiting_approval" : "delivered");
    return { code: 0 };
  };
  assert.equal((await runWorkerOnce(root, { execute })).job.state, "awaiting_outline_approval");
  await runWorkerOnce(root, { execute });
  assert.deepEqual(actions, ["plan"]);
  setState("approved");
  assert.equal((await runWorkerOnce(root, { execute })).job.state, "awaiting_producer_review");
  assert.deepEqual(actions, ["plan", "run"]);
});

test("CLI exit zero in a human state is waiting, not completed", async (t) => {
  for (const state of ["needs_human_review", "awaiting_delivery_approval"]) {
    const { root, runId, setState } = fixture(t);
    enqueueJob(root, runId);
    const result = await runWorkerOnce(root, { execute: async () => { setState(state); return { code: 0 }; } });
    assert.equal(result.job.state, state);
    assert.equal(result.job.attempts, 1);
  }
});

test("failed generation never automatically repeats and explicit retry preserves attempt count", async (t) => {
  const { root, runId, setState } = fixture(t);
  enqueueJob(root, runId);
  let calls = 0;
  const execute = async () => { calls++; return { code: 1 }; };
  assert.equal((await runWorkerOnce(root, { execute })).job.state, "failed");
  await runWorkerOnce(root, { execute });
  assert.equal(calls, 1);
  assert.equal(retryJob(root, runId).retried, true);
  const result = await runWorkerOnce(root, { execute: async () => { setState("delivered"); return { code: 0 }; } });
  assert.equal(result.job.attempts, 2);
  assert.equal(result.job.state, "awaiting_producer_review");
});

test("overlapping workers preserve the active owner and process only one queued run", async (t) => {
  const { root, runId, setState } = fixture(t, "approved", "a-run");
  const secondId = "z-run";
  fs.mkdirSync(path.join(root, "runs", secondId));
  fs.writeFileSync(path.join(root, "runs", secondId, "manifest.json"), JSON.stringify({ state: "approved" }));
  enqueueJob(root, runId);
  enqueueJob(root, secondId);
  let release;
  const active = runWorkerOnce(root, { execute: async () => { await new Promise((resolve) => { release = resolve; }); setState("delivered"); return { code: 0 }; } });
  const overlap = await runWorkerOnce(root, { execute: async () => assert.fail("second worker must not launch") });
  assert.equal(overlap.busy, true);
  assert.equal(overlap.owner.pid, process.pid);
  release();
  await active;
  assert.equal(queueStatus(root).jobs.find((job) => job.runId === secondId).attempts, 0);
});

test("existing run lock is retained and its owner is reported", async (t) => {
  const { root, runId, directory } = fixture(t);
  enqueueJob(root, runId);
  const file = path.join(directory, ".lock");
  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  fs.writeFileSync(file, content);
  await runWorkerOnce(root, { execute: async () => assert.fail("locked run must not launch") });
  const [job] = queueStatus(root).jobs;
  assert.equal(job.state, "waiting_for_run_lock");
  assert.equal(job.lockOwner.pid, process.pid);
  assert.equal(fs.readFileSync(file, "utf8"), content);
});

test("returned and unknown states stop; absent explicit company configuration cannot launch", async (t) => {
  for (const state of ["returned", "surprise_state"]) {
    const { root, runId } = fixture(t, state);
    enqueueJob(root, runId);
    await runWorkerOnce(root, { execute: async () => assert.fail("unsupported state must not launch") });
    assert.equal(queueStatus(root).jobs[0].state, "stopped");
  }
  for (const state of ["approved", "planning"]) {
    const { root, runId, agentDir } = fixture(t, state);
    fs.unlinkSync(path.join(agentDir, "auth.json"));
    enqueueJob(root, runId);
    const result = await runWorkerOnce(root, { env: {} });
    assert.equal(result.job.state, "failed");
    assert.equal(result.job.attempts, 0);
    assert.match(result.job.error, /PI_CODING_AGENT_DIR/);
  }
});

test("run IDs cannot traverse outside runs", (t) => {
  const { root } = fixture(t);
  for (const value of ["", ".", "..", "../elsewhere", "a/b", "a\\b", "a\0b"]) assert.throws(() => resolveQueuedRun(root, value), /one directory name/);
});

test("an interrupted worker requires explicit retry and never clears its run lock", async (t) => {
  const { root, runId, directory } = fixture(t);
  enqueueJob(root, runId);
  const exitedPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
  const jobFile = path.join(root, ".queue", "jobs", `${runId}.json`);
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  job.state = "running";
  job.attempts = 1;
  fs.writeFileSync(jobFile, JSON.stringify(job));
  fs.writeFileSync(path.join(root, ".queue", "worker.lock"), JSON.stringify({ pid: exitedPid, startedAt: new Date().toISOString() }));
  const runLock = path.join(directory, ".lock");
  fs.writeFileSync(runLock, JSON.stringify({ pid: exitedPid, startedAt: new Date().toISOString() }));
  const result = await runWorkerOnce(root, { execute: async () => assert.fail("interruption cannot trigger paid retry") });
  assert.equal(result.busy, true);
  assert.equal(result.owner.ownerStatus, "exited");
  assert.equal(retryJob(root, runId).retried, true);
  assert.equal(fs.existsSync(runLock), true);
  await runWorkerOnce(root, { execute: async () => assert.fail("run lock must still prevent execution") });
  assert.equal(queueStatus(root).jobs[0].state, "waiting_for_run_lock");
});

test("actual CLI accepts an explicit project root and performs an offline empty tick", (t) => {
  const { root } = fixture(t);
  const worker = fileURLToPath(new URL("../bin/tianshu-worker.mjs", import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [worker, "--root", root, "once"], { encoding: "utf8", env: { PATH: process.env.PATH } }));
  assert.equal(result.processed, false);
  assert.equal(queueStatus(root).worker, null);
});

test("manual review repairs mark targets stale before production within one job attempt", async (t) => {
  for (const stage of ["screenplay", "storyboard"]) {
    const { root, runId, directory, setState } = fixture(t, `${stage}_repairing`);
    const task = path.join(directory, "target-task.json");
    fs.writeFileSync(task, JSON.stringify({ state: "passed" }));
    enqueueJob(root, runId);
    const actions = [];
    const result = await runWorkerOnce(root, { execute: async ({ action }) => {
      actions.push(action);
      if (action === "repair") {
        fs.writeFileSync(task, JSON.stringify({ state: "stale" }));
        setState(`${stage}_producing`);
      } else {
        assert.equal(JSON.parse(fs.readFileSync(task, "utf8")).state, "stale");
        setState("delivered");
      }
      return { code: 0 };
    } });
    assert.deepEqual(actions, ["repair", "run"]);
    assert.equal(result.job.attempts, 1);
    assert.equal(result.job.state, "awaiting_producer_review");
  }
});

test("repair failure stops before generation", async (t) => {
  const { root, runId } = fixture(t, "screenplay_repairing");
  enqueueJob(root, runId);
  const actions = [];
  const result = await runWorkerOnce(root, { execute: async ({ action }) => { actions.push(action); return { code: 1 }; } });
  assert.deepEqual(actions, ["repair"]);
  assert.equal(result.job.state, "failed");
  assert.equal(result.job.attempts, 1);
});

test("planning recovery uses the actual intermediate planning state", async (t) => {
  const { root, runId, setState } = fixture(t, "planning");
  enqueueJob(root, runId);
  const result = await runWorkerOnce(root, { execute: async ({ action }) => {
    assert.equal(action, "plan");
    setState("awaiting_approval");
    return { code: 0 };
  } });
  assert.equal(result.job.state, "awaiting_outline_approval");
});
