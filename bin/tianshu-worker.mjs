#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DRAIN_MAX_JOBS, DEFAULT_DRAIN_CONCURRENCY, enqueueJob, queueStatus, retryJob, runWorkerOnce, runWorkerDrain } from "../src/queue.mjs";

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
    let maxJobs = DEFAULT_DRAIN_MAX_JOBS, concurrency = DEFAULT_DRAIN_CONCURRENCY;
    const seen = new Set();
    for (let index = 1; index < args.length; index += 2) {
      const option = args[index], value = args[index + 1];
      if (!["--max-jobs", "--concurrency"].includes(option) || seen.has(option)) throw new Error("drain accepts --max-jobs N and --concurrency N once each");
      seen.add(option);
      if (!/^[1-9]\d*$/.test(value ?? "")) throw new Error(option === "--max-jobs" ? "drain --max-jobs requires a finite positive safe integer" : "drain --concurrency requires an integer from 1 to 8");
      if (option === "--max-jobs") maxJobs = Number(value);
      else concurrency = Number(value);
    }
    result = await runWorkerDrain(root, { maxJobs, concurrency });
  }
  else if (command === "status" && args.length === 1) result = queueStatus(root);
  else throw new Error(`usage: tianshu-worker [--root data-directory] enqueue <run-id> | once | drain [--max-jobs N] [--concurrency N] | retry <run-id> | status; drain default: ${DEFAULT_DRAIN_MAX_JOBS} runnable candidates, concurrency ${DEFAULT_DRAIN_CONCURRENCY}, one attempt per job; data directory: --root > TIANSHU_ROOT > this repository`);
  console.log(JSON.stringify(result, null, 2));
  if (["failed", "stopped"].includes(result.job?.state) || result.results?.some(({ job }) => ["failed", "stopped"].includes(job.state))) process.exitCode = 1;
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
