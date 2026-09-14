#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DRAIN_MAX_JOBS, enqueueJob, queueStatus, retryJob, runWorkerOnce, runWorkerDrain } from "../src/queue.mjs";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let root = path.resolve(process.env.TIANSHU_ROOT || CODE_ROOT);
try {
  if (rootIndex >= 0) {
    if (!args[rootIndex + 1]?.trim() || args[rootIndex + 1].startsWith("--")) throw new Error("--root requires a run data directory");
    root = path.resolve(args[rootIndex + 1]);
    args.splice(rootIndex, 2);
  }
  const [command, runId] = args;
  let result;
  if (command === "enqueue" && args.length === 2) result = enqueueJob(root, runId);
  else if (command === "retry" && args.length === 2) result = retryJob(root, runId);
  else if (command === "once" && args.length === 1) result = await runWorkerOnce(root);
  else if (command === "drain") {
    let maxJobs = DEFAULT_DRAIN_MAX_JOBS;
    if (args.length !== 1) {
      if (args.length !== 3 || args[1] !== "--max-jobs" || !/^[1-9]\d*$/.test(args[2])) throw new Error("drain --max-jobs requires a finite positive safe integer");
      maxJobs = Number(args[2]);
    }
    result = await runWorkerDrain(root, { maxJobs });
  }
  else if (command === "status" && args.length === 1) result = queueStatus(root);
  else throw new Error(`usage: tianshu-worker [--root data-directory] enqueue <run-id> | once | drain [--max-jobs N] | retry <run-id> | status; drain default: ${DEFAULT_DRAIN_MAX_JOBS} runnable candidates, one attempt per job; data directory: --root > TIANSHU_ROOT > this repository`);
  console.log(JSON.stringify(result, null, 2));
  if (["failed", "stopped"].includes(result.job?.state) || result.results?.some(({ job }) => ["failed", "stopped"].includes(job.state))) process.exitCode = 1;
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
