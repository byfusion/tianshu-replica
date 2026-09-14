import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeExecutionContract } from "../src/execution-contract.mjs";
import { TEXT_MODEL_PROFILES } from "../src/model-profiles.mjs";
import { DEFAULT_DRAIN_MAX_JOBS, enqueueJob, queueStatus, runWorkerDrain, runWorkerOnce } from "../src/queue.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-drain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const add = (runId, { model = "kimi", state = "approved", configured = true, bound = true } = {}) => {
    const runDir = path.join(root, "runs", runId), agentDir = path.join(root, "credentials", runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    if (configured) fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [TEXT_MODEL_PROFILES[model].provider]: { type: "api_key", key: "offline-test-key" } }));
    if (bound) writeExecutionContract(runDir, { model, agentDir, env: {} });
    const setState = (value) => fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ id: runId, state: value }));
    setState(state);
    enqueueJob(root, runId);
    return { runId, runDir, agentDir, setState };
  };
  const job = (runId) => queueStatus(root).jobs.find((entry) => entry.runId === runId);
  return { root, add, job };
}

test("drain isolates missing credentials and human review while routing each frozen text model", async (t) => {
  const { root, add, job } = fixture(t);
  const missing = add("a-kimi", { configured: false });
  const review = add("b-deepseek", { model: "deepseek" });
  const complete = add("c-gpt", { model: "gpt" });
  const calls = [];
  const result = await runWorkerDrain(root, {
    env: { TIANSHU_MODEL: "kimi", TIANSHU_MODEL_PROVIDER: "wrong-provider", TIANSHU_MODEL_ID: "wrong-model", PI_CODING_AGENT_DIR: "/wrong-account" },
    execute: async ({ runId, action, env }) => {
      calls.push(runId);
      const target = runId === review.runId ? review : complete;
      const family = runId === review.runId ? "deepseek" : "gpt";
      assert.equal(action, "run");
      assert.equal(env.TIANSHU_MODEL, family);
      assert.equal(env.TIANSHU_MODEL_PROVIDER, TEXT_MODEL_PROFILES[family].provider);
      assert.equal(env.TIANSHU_MODEL_ID, TEXT_MODEL_PROFILES[family].id);
      assert.equal(env.PI_CODING_AGENT_DIR, target.agentDir);
      target.setState(target === review ? "needs_human_review" : "delivered");
      return { code: 0 };
    },
  });
  assert.deepEqual(calls, [review.runId, complete.runId]);
  assert.equal(result.selected, 3);
  assert.equal(result.processed, 2);
  assert.equal(job(missing.runId).errorCode, "TIANSHU_MODEL_NOT_CONFIGURED");
  assert.equal(job(missing.runId).attempts, 0);
  assert.equal(job(review.runId).state, "needs_human_review");
  assert.equal(job(complete.runId).state, "awaiting_producer_review");
  await runWorkerDrain(root, { execute: async () => assert.fail("failed, human-review and delivered work must not repeat") });
  assert.equal(queueStatus(root).worker, null);
});

test("max-jobs bounds candidates, including configuration failure, and each snapshot job runs once", async (t) => {
  const { root, add, job } = fixture(t);
  add("a-missing", { configured: false });
  const second = add("b-complete");
  add("c-next");
  const calls = [];
  const result = await runWorkerDrain(root, { maxJobs: 2, execute: async ({ runId }) => {
    calls.push(runId);
    // New work is deliberately excluded from the current snapshot.
    add("d-new");
    second.setState("delivered");
    return { code: 0 };
  } });
  assert.deepEqual(calls, [second.runId]);
  assert.equal(result.selected, 2);
  assert.equal(result.limitReached, true);
  assert.equal(job("c-next").attempts, 0);
  assert.equal(job("d-new").attempts, 0);
});

test("one worker lock spans every drain job and existing run locks remain untouched", async (t) => {
  const { root, add, job } = fixture(t);
  const locked = add("a-locked");
  const first = add("b-first"), second = add("c-second");
  const lockFile = path.join(locked.runDir, ".lock");
  const lockContent = JSON.stringify({ pid: process.pid, startedAt: "2026-09-14T00:00:00.000Z" });
  fs.writeFileSync(lockFile, lockContent);
  let workerContent;
  const calls = [];
  await runWorkerDrain(root, { execute: async ({ runId }) => {
    calls.push(runId);
    const current = fs.readFileSync(path.join(root, ".queue", "worker.lock"), "utf8");
    if (workerContent) assert.equal(current, workerContent);
    workerContent = current;
    const overlap = await runWorkerOnce(root, { execute: async () => assert.fail("a second executor must not launch") });
    assert.equal(overlap.busy, true);
    assert.equal(overlap.owner.pid, process.pid);
    (runId === first.runId ? first : second).setState("delivered");
    return { code: 0 };
  } });
  assert.deepEqual(calls, [first.runId, second.runId]);
  assert.equal(job(locked.runId).state, "waiting_for_run_lock");
  assert.equal(fs.readFileSync(lockFile, "utf8"), lockContent);
  assert.equal(queueStatus(root).worker, null);
});

test("approval and user/account pauses are preserved without starving approved jobs", async (t) => {
  const { root, add, job } = fixture(t);
  add("a-outline", { state: "awaiting_approval" });
  add("b-human", { state: "needs_human_review" });
  add("c-user-pause");
  add("d-account-pause");
  for (const [runId, state] of [["c-user-pause", "paused"], ["d-account-pause", "account_paused"]]) {
    const file = path.join(root, ".queue", "jobs", `${runId}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...job(runId), state, error: "owner paused this job" }));
  }
  const approved = add("e-approved");
  const result = await runWorkerDrain(root, { maxJobs: 1, execute: async ({ runId }) => {
    assert.equal(runId, approved.runId);
    approved.setState("delivered");
    return { code: 0 };
  } });
  assert.equal(result.processed, 1);
  assert.equal(job("a-outline").state, "awaiting_outline_approval");
  assert.equal(job("b-human").state, "needs_human_review");
  assert.equal(job("c-user-pause").state, "paused");
  assert.equal(job("d-account-pause").state, "account_paused");
  assert.equal(job("d-account-pause").error, "owner paused this job");
});

test("interrupted usage and CLI failures require explicit retry while other jobs proceed", async (t) => {
  const { root, add, job } = fixture(t);
  add("a-unknown");
  const interruptedFile = path.join(root, ".queue", "jobs", "a-unknown.json");
  fs.writeFileSync(interruptedFile, JSON.stringify({ ...job("a-unknown"), state: "running", attempts: 1 }));
  add("b-failed");
  const complete = add("c-complete");
  const calls = [];
  await runWorkerDrain(root, { execute: async ({ runId }) => {
    calls.push(runId);
    if (runId === "b-failed") return { code: 1 };
    complete.setState("delivered");
    return { code: 0 };
  } });
  assert.deepEqual(calls, ["b-failed", "c-complete"]);
  assert.match(job("a-unknown").error, /usage may be unknown/);
  assert.equal(job("a-unknown").attempts, 1);
  assert.equal(job("b-failed").state, "failed");
  await runWorkerDrain(root, { execute: async () => assert.fail("UNKNOWN and failure must not automatically retry") });
});

test("pauses recorded during a drain survive its snapshot and the repair boundary", async (t) => {
  const { root, add, job } = fixture(t);
  const repair = add("a-repair", { state: "screenplay_repairing" });
  add("b-later");
  const complete = add("c-complete");
  const calls = [];
  await runWorkerDrain(root, { execute: async ({ runId, action }) => {
    calls.push([runId, action]);
    if (runId === repair.runId) {
      repair.setState("screenplay_producing");
      for (const id of [repair.runId, "b-later"]) {
        const file = path.join(root, ".queue", "jobs", `${id}.json`);
        fs.writeFileSync(file, JSON.stringify({ ...job(id), state: "paused", error: "user pause" }));
      }
    } else complete.setState("delivered");
    return { code: 0 };
  } });
  assert.deepEqual(calls, [[repair.runId, "repair"], [complete.runId, "run"]]);
  assert.equal(job(repair.runId).state, "paused");
  assert.equal(job("b-later").state, "paused");
  assert.equal(job("b-later").attempts, 0);
});

test("repair stops at a new approval or human handoff before continuing another job", async (t) => {
  for (const handoff of ["awaiting_approval", "needs_human_review"]) {
    const { root, add, job } = fixture(t);
    const repair = add("a-repair", { state: "screenplay_repairing" });
    const complete = add("b-complete");
    const calls = [];
    await runWorkerDrain(root, { execute: async ({ runId, action }) => {
      calls.push([runId, action]);
      (runId === repair.runId ? repair : complete).setState(runId === repair.runId ? handoff : "delivered");
      return { code: 0 };
    } });
    assert.deepEqual(calls, [[repair.runId, "repair"], [complete.runId, "run"]]);
    assert.equal(job(repair.runId).attempts, 1);
    assert.equal(job(repair.runId).state, handoff === "awaiting_approval" ? "awaiting_outline_approval" : handoff);
  }
});

test("a source-material failure remains local to its job", async (t) => {
  const { root, add, job } = fixture(t);
  add("a-missing-materials", { state: "draft" });
  const complete = add("b-complete");
  const result = await runWorkerDrain(root, { execute: async ({ runId }) => {
    if (runId === "a-missing-materials") throw new Error("missing canonical/source-characters.md");
    complete.setState("delivered");
    return { code: 0 };
  } });
  assert.equal(result.processed, 2);
  assert.equal(job("a-missing-materials").state, "failed");
  assert.match(job("a-missing-materials").error, /source-characters/);
  assert.equal(job(complete.runId).state, "awaiting_producer_review");
});

test("legacy-unbound work stops before execution instead of guessing the queue environment", async (t) => {
  const { root, add, job } = fixture(t);
  add("a-legacy", { bound: false });
  const complete = add("b-bound");
  await runWorkerDrain(root, { env: { TIANSHU_MODEL: "gpt" }, execute: async ({ runId }) => {
    assert.equal(runId, complete.runId);
    complete.setState("delivered");
    return { code: 0 };
  } });
  assert.equal(job("a-legacy").state, "stopped");
  assert.equal(job("a-legacy").errorCode, "TIANSHU_LEGACY_UNBOUND");
  assert.equal(job("a-legacy").attempts, 0);
  assert.match(job("a-legacy").error, /bind-model/);
});

test("drain validates its finite bound and actual CLI supports offline empty drains", async (t) => {
  const { root } = fixture(t);
  for (const maxJobs of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "2"]) {
    await assert.rejects(runWorkerDrain(root, { maxJobs }), /finite positive safe integer/);
  }
  const worker = fileURLToPath(new URL("../bin/tianshu-worker.mjs", import.meta.url));
  const env = { PATH: process.env.PATH };
  for (const args of [[], ["--max-jobs", "2"]]) {
    const result = JSON.parse(execFileSync(process.execPath, [worker, "--root", root, "drain", ...args], { encoding: "utf8", env }));
    assert.equal(result.processed, 0);
    assert.equal(result.selected, 0);
    assert.equal(result.maxJobs, args.length ? 2 : DEFAULT_DRAIN_MAX_JOBS);
  }
  assert.throws(() => execFileSync(process.execPath, [worker, "--root", root, "drain", "--max-jobs", "0"], { encoding: "utf8", env, stdio: "pipe" }), /finite positive safe integer/);
  assert.equal(queueStatus(root).worker, null);
});
