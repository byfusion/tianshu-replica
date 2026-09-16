import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { textModelForRun } from "./execution-contract.mjs";
import { credentialsForTextModel } from "./model-profiles.mjs";
import { mapConcurrent } from "./concurrency.mjs";

const CLI_ENTRY = fileURLToPath(new URL("../bin/tianshu.mjs", import.meta.url));

const RUNNABLE = new Set(["approved", "screenplay_producing", "screenplay_reviewing", "screenplay_passed", "storyboard_producing", "storyboard_reviewing", "final_review"]);
const PAUSED = new Map([["awaiting_approval", "awaiting_outline_approval"], ["needs_human_review", "needs_human_review"], ["awaiting_delivery_approval", "awaiting_delivery_approval"], ["delivered", "awaiting_producer_review"]]);
const RESUMABLE_JOBS = new Set(["queued", "waiting_for_run_lock", "awaiting_outline_approval", "needs_human_review", "awaiting_delivery_approval"]);
export const DEFAULT_DRAIN_MAX_JOBS = 10;
export const DEFAULT_DRAIN_CONCURRENCY = 8;
const now = () => new Date().toISOString();
const queueDir = (root) => path.join(path.resolve(root), ".queue");
const lockFile = (root) => path.join(queueDir(root), "worker.lock");

export function resolveQueuedRun(root, runId) {
  if (typeof runId !== "string" || !runId || [".", ".."].includes(runId) || /[\\/\0]/u.test(runId)) throw new Error("run ID must be one directory name inside runs");
  return path.join(path.resolve(root), "runs", runId);
}

function manifest(root, runId) {
  return JSON.parse(fs.readFileSync(path.join(resolveQueuedRun(root, runId), "manifest.json"), "utf8"));
}

function jobFile(root, runId) {
  resolveQueuedRun(root, runId);
  return path.join(queueDir(root), "jobs", `${runId}.json`);
}

function writeJob(root, job) {
  const file = jobFile(root, job.runId), temporary = `${file}.${process.pid}.tmp`;
  job.updatedAt = now();
  fs.writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return job;
}

function readJobs(root) {
  const directory = path.join(queueDir(root), "jobs");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
}

function ownerStatus(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return "unknown";
  try { process.kill(owner.pid, 0); return "running"; }
  catch (error) { if (error.code === "ESRCH") return "exited"; if (error.code === "EPERM") return "running"; return "unknown"; }
}

function readLock(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, ...owner, ownerStatus: ownerStatus(owner) };
  } catch { return { file, ownerStatus: "unknown" }; }
}

function acquireWorker(root) {
  fs.mkdirSync(queueDir(root), { recursive: true, mode: 0o700 });
  const file = lockFile(root), owner = { pid: process.pid, startedAt: now() };
  try {
    const handle = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(owner)}\n`);
    fs.closeSync(handle);
    return { acquired: true, owner };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return { acquired: false, owner: readLock(file) };
  }
}

function releaseWorker(root) {
  fs.unlinkSync(lockFile(root));
}

export function enqueueJob(root, runId) {
  const current = manifest(root, runId), file = jobFile(root, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const timestamp = now();
  const job = { runId, state: "queued", manifestState: current.state, createdAt: timestamp, updatedAt: timestamp, attempts: 0, error: null };
  try { fs.writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    return { enqueued: false, job: JSON.parse(fs.readFileSync(file, "utf8")) };
  }
  return { enqueued: true, job };
}

export function queueStatus(root) {
  return { root: path.resolve(root), worker: readLock(lockFile(root)), jobs: readJobs(root) };
}

export function retryJob(root, runId) {
  const file = jobFile(root, runId);
  if (!fs.existsSync(file)) throw new Error("run is not enqueued");
  // An explicit retry can recover an exited worker, but never removes a run lock.
  const previousLock = readLock(lockFile(root));
  if (previousLock?.ownerStatus === "exited") fs.unlinkSync(lockFile(root));
  const lock = acquireWorker(root);
  if (!lock.acquired) return { retried: false, busy: true, owner: lock.owner };
  try {
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    if (job.state === "running" && !previousLock) throw new Error("running job has no worker owner; inspect its run lock before retrying");
    if (!["failed", "stopped", "waiting_for_run_lock", "running"].includes(job.state)) throw new Error(`retry requires failed, stopped, or interrupted work; got ${job.state}`);
    job.manifestState = manifest(root, runId).state;
    job.state = "queued";
    job.error = null;
    delete job.errorCode;
    delete job.lockOwner;
    writeJob(root, job);
    return { retried: true, job };
  } finally { releaseWorker(root); }
}

function classify(job, current) {
  job.manifestState = current.state;
  job.error = null;
  delete job.errorCode;
  delete job.lockOwner;
  if (PAUSED.has(current.state)) { job.state = PAUSED.get(current.state); return null; }
  if (current.state === "ready_to_deliver") { job.state = "queued"; return "deliver"; }
  if (["draft", "planning"].includes(current.state)) { job.state = "queued"; return "plan"; }
  if (["screenplay_repairing", "storyboard_repairing"].includes(current.state)) { job.state = "queued"; return "repair"; }
  if (RUNNABLE.has(current.state)) { job.state = "queued"; return "run"; }
  job.state = "stopped";
  job.error = `run cannot continue from ${current.state}`;
  return null;
}

async function executeCli({ root, runId, action, env }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, "--root", root, action, runId], { cwd: root, env, stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function failJob(job, error) {
  job.state = error.code === "TIANSHU_LEGACY_UNBOUND" ? "stopped" : "failed";
  job.error = error.message;
  if (error.code) job.errorCode = error.code;
}

function environmentForJob(root, job, env) {
  const selected = textModelForRun(resolveQueuedRun(root, job.runId));
  const credentials = credentialsForTextModel(selected);
  if (!credentials.configured) {
    const error = new Error(`frozen ${selected.provider}/${selected.id} credentials are not configured in PI_CODING_AGENT_DIR ${selected.agentDir || "(unbound)"}; configure this run's account before explicit retry`);
    error.code = "TIANSHU_MODEL_NOT_CONFIGURED";
    throw error;
  }
  return { ...env, TIANSHU_ROOT: path.resolve(root), TIANSHU_MODEL: selected.family, TIANSHU_MODEL_PROVIDER: selected.provider, TIANSHU_MODEL_ID: selected.id, PI_CODING_AGENT_DIR: selected.agentDir };
}

async function processQueuedJob(root, job, { execute, env, onSelected = () => {} }) {
  if (job.state === "running") {
    job.state = "failed";
    job.error = "worker ended before recording a result; usage may be unknown; explicit retry required";
    writeJob(root, job);
    return { selected: false, processed: false, job };
  }
  // Only known resumable states are eligible. User/account pauses and unknown
  // queue states remain intact until their owner explicitly resolves them.
  if (!RESUMABLE_JOBS.has(job.state)) return null;
  let action;
  try { action = classify(job, manifest(root, job.runId)); }
  catch (error) { failJob(job, error); }
  writeJob(root, job);
  if (!action) return { selected: false, processed: false, job };
  const runLock = readLock(path.join(resolveQueuedRun(root, job.runId), ".lock"));
  if (runLock) {
    job.state = "waiting_for_run_lock";
    job.lockOwner = runLock;
    job.error = "run lock is preserved; use lock-status and the existing unlock-stale procedure";
    writeJob(root, job);
    return { selected: false, processed: false, job };
  }
  let jobEnv;
  // Delivery runs the native local gate/export only; historical output can be
  // exported without binding a future model or configuring paid generation.
  try { jobEnv = action === "deliver" ? { ...env, TIANSHU_ROOT: path.resolve(root) } : environmentForJob(root, job, env); }
  catch (error) {
    onSelected();
    failJob(job, error);
    writeJob(root, job);
    return { selected: true, processed: false, action, job };
  }
  onSelected();
  job.state = "running";
  job.startedAt = now();
  job.attempts += 1;
  writeJob(root, job);
  try {
    // Manual review leaves passed tasks intact until repair marks its targets
    // stale. Re-read its resulting state before starting any generation.
    const commands = action === "repair" ? ["repair", "run"] : [action];
    for (const command of commands) {
      if (command === "run" && action === "repair") {
        const next = classify(job, manifest(root, job.runId));
        if (!next) break;
        if (next !== "run") throw new Error(`CLI repair returned without a runnable or handoff state (${job.manifestState}); explicit retry required`);
        job.state = "running";
        writeJob(root, job);
      }
      const result = await execute({ root, runId: job.runId, action: command, env: jobEnv });
      const recorded = JSON.parse(fs.readFileSync(jobFile(root, job.runId), "utf8"));
      if (recorded.state !== "running") {
        // A pause recorded while the child was active controls subsequent
        // work, including repair -> run. Do not overwrite its owner's state.
        recorded.finishedAt = now();
        writeJob(root, recorded);
        return { selected: true, processed: true, action, job: recorded };
      }
      if (result?.code !== 0) throw new Error(`CLI ${command} failed (${result?.signal || `exit ${result?.code ?? "unknown"}`}); no automatic retry`);
    }
    const next = classify(job, manifest(root, job.runId));
    if (next) throw new Error(`CLI ${action} returned without reaching a handoff state (${job.manifestState}); explicit retry required`);
  } catch (error) { failJob(job, error); }
  job.finishedAt = now();
  writeJob(root, job);
  return { selected: true, processed: true, action, job };
}

async function withWorker(root, work) {
  root = path.resolve(root);
  const lock = acquireWorker(root);
  if (!lock.acquired) return { busy: true, owner: lock.owner, action: "inspect the exact worker owner; explicit retry is required after an exited worker" };
  try { return await work(root); }
  finally { releaseWorker(root); }
}

export async function runWorkerOnce(root, { execute = executeCli, env = process.env } = {}) {
  return withWorker(root, async (resolvedRoot) => {
    root = resolvedRoot;
    for (const job of readJobs(root)) {
      const result = await processQueuedJob(root, job, { execute, env });
      if (result?.selected) {
        const { selected, ...once } = result;
        return once;
      }
    }
    return { processed: false, jobs: readJobs(root) };
  });
}

export async function runWorkerDrain(root, { maxJobs = DEFAULT_DRAIN_MAX_JOBS, concurrency = DEFAULT_DRAIN_CONCURRENCY, execute = executeCli, env = process.env } = {}) {
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1) throw new Error("--max-jobs must be a finite positive safe integer");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("--concurrency must be an integer from 1 to 8");
  return withWorker(root, async (resolvedRoot) => {
    // This snapshot bounds the drain and gives each job at most one attempt.
    // Newly enqueued jobs belong to the next invocation.
    const snapshot = readJobs(resolvedRoot), results = new Array(snapshot.length);
    let next = 0, selected = 0, processed = 0;
    await mapConcurrent(Array.from({ length: Math.min(concurrency, snapshot.length) }), concurrency, async () => {
      while (selected < maxJobs && next < snapshot.length) {
        const index = next++, { runId } = snapshot[index];
        // Re-read at dispatch so pauses recorded while other jobs run survive.
        const job = JSON.parse(fs.readFileSync(jobFile(resolvedRoot, runId), "utf8"));
        const result = await processQueuedJob(resolvedRoot, job, {
          execute, env,
          // Selection is reserved synchronously before execute's first await;
          // concurrent lanes cannot spend the same remaining maxJobs budget.
          onSelected: () => { selected++; },
        });
        if (!result) continue;
        results[index] = result;
        if (result.processed) processed++;
      }
    });
    return { processed, selected, maxJobs, concurrency, limitReached: selected >= maxJobs, results: results.filter(Boolean), jobs: readJobs(resolvedRoot) };
  });
}
