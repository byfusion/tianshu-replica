import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../scripts/provider_slots.py", import.meta.url));
const abortError = () => Object.assign(new Error("Request slot acquisition was cancelled"), { name: "AbortError" });

export async function acquireRequestSlot({ root, limit = 8, runId, role, signal }) {
  if (!root || !runId || !role) throw new Error("Request slots require root, runId and role");
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("GPT request slot limit must be an integer from 1 to 8");
  const directory = path.join(path.resolve(root), ".provider-slots", "gpt-requests");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const requestId = randomUUID();
  const metadata = { requestId, runId, role, pid: process.pid };
  const audit = (event, slot = null) => fs.appendFileSync(path.join(directory, "audit.jsonl"),
    `${JSON.stringify({ ...metadata, event, at: new Date().toISOString(), slot })}\n`, { mode: 0o600 });
  if (signal?.aborted) { audit("cancelled"); throw abortError(); }
  const descriptors = [];
  const closeAll = () => { for (const fd of descriptors.splice(0)) fs.closeSync(fd); };
  try {
    for (let slot = 0; slot < limit; slot++) descriptors.push(fs.openSync(path.join(directory, `slot-${slot}.lock`), "a+", 0o600));
  } catch (error) { closeAll(); throw error; }
  let cancelled = false;
  let child;
  const cancel = () => { cancelled = true; child?.stdin.end(); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    child = spawn(process.env.TIANSHU_PYTHON || "python3", [helper, "--root", path.resolve(root),
      "--limit", String(limit), "--request-id", requestId, "--run-id", runId, "--role", role,
      "--pid", String(process.pid)], { stdio: ["pipe", "pipe", "pipe", ...descriptors] });
    child.stdin.on("error", () => {}); // The helper may finish just before cancellation closes stdin.
    if (signal?.aborted) cancel();
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve(status));
    });
    const reply = stdout.trim() ? JSON.parse(stdout) : null;
    if (cancelled || reply?.status === "cancelled") {
      if (reply?.status !== "cancelled") {
        if (reply?.status === "granted") fs.rmSync(path.join(directory, `slot-${reply.slot}.owner.json`));
        audit("cancelled", reply?.slot ?? null);
      }
      throw abortError();
    }
    if (code !== 0 || reply?.status !== "granted" || reply.requestId !== requestId
        || !Number.isInteger(reply.slot) || reply.slot < 0 || reply.slot >= limit) {
      throw new Error(`Request slot helper failed (${code}): ${stderr.trim().slice(0, 500)}`);
    }
    const chosen = descriptors[reply.slot];
    for (let slot = 0; slot < descriptors.length; slot++) if (slot !== reply.slot) fs.closeSync(descriptors[slot]);
    descriptors.length = 0;
    let released = false;
    return { requestId, slot: reply.slot, release() {
      if (released) return;
      released = true;
      try {
        audit("released", reply.slot);
        fs.rmSync(path.join(directory, `slot-${reply.slot}.owner.json`));
      } finally { fs.closeSync(chosen); }
    } };
  } catch (error) {
    child?.stdin.end();
    closeAll();
    throw error;
  } finally {
    // Active requests retain their lease until the stream owner calls release.
    signal?.removeEventListener("abort", cancel);
  }
}
