import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { createPiExperimentSession, promptWithWatchdog } from "../src/experiments/lib.mjs";
import { writeExecutionContract } from "../src/execution-contract.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const { streamSimple: codexStream } = await import(path.join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js"));
const token = `offline.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" } })).toString("base64url")}.fixture`;
const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra", baseUrl: "https://offline.invalid", reasoning: true, input: ["text"], contextWindow: 400000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context = { messages: [{ role: "user", content: "Offline request boundary fixture", timestamp: 0 }] };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function slots(limit = 8) {
  const state = { active: 0, maxActive: 0, acquired: 0, released: 0, queue: [], options: [] };
  const drain = () => {
    while (state.active < limit && state.queue.length) {
      const next = state.queue.shift();
      next.signal?.removeEventListener("abort", next.cancel);
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      const requestId = `offline-${++state.acquired}`;
      let released = false;
      next.resolve({ requestId, slot: state.active - 1, release() {
        if (released) return;
        released = true;
        state.active -= 1;
        state.released += 1;
        drain();
      } });
    }
  };
  state.acquire = ({ signal, ...options }) => new Promise((resolve, reject) => {
    state.options.push(options);
    const next = { signal, resolve, cancel() {
      state.queue = state.queue.filter((item) => item !== next);
      reject(new Error("Request slot wait aborted"));
    } };
    if (signal?.aborted) return next.cancel();
    signal?.addEventListener("abort", next.cancel, { once: true });
    state.queue.push(next);
    drain();
  });
  return state;
}

function heldResponse(onCancel = () => {}) {
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; }, cancel() { onCancel(); } }), { headers: { "content-type": "text/event-stream" } });
  return { response, finish() {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response: { id: "offline-response", status: "completed", output: [{ type: "message", id: "offline-message", role: "assistant", content: [{ type: "output_text", text: "offline complete" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`));
    controller.close();
  } };
}

async function fixture(t, pool, fetch, { family = "gpt", role = "storyboard-batch-1", runtimeOptions = {}, root: sharedRoot } = {}) {
  const root = sharedRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-model-request-"));
  if (!sharedRoot) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runDir = path.join(root, "runs", `offline-${role}`), agentDir = path.join(root, `account-${role}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [family === "gpt" ? "openai-codex" : "deepseek"]: { type: "api_key", key: token } }));
  writeExecutionContract(runDir, { model: family, agentDir, env: {} });
  const original = (_model, ctx, options) => codexStream(model, ctx, { apiKey: token, transport: "sse", maxRetries: 0, fetch, ...runtimeOptions, ...options });
  const runtime = { getModel: () => family === "gpt" ? model : { ...model, provider: "deepseek", id: "deepseek-flash" }, streamSimple: original };
  const session = { subscribe() {}, dispose() {} };
  const result = await createPiExperimentSession({ runDir, role, systemPrompt: "Offline fixture", customTools: [], toolNames: [] }, {
    ModelRuntime: { create: async () => runtime },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({ session }),
    acquireRequestSlot: pool.acquire,
  });
  return { ...result, runtime, original, root, runDir };
}

test("nine native Codex SSE streams across stages send at most eight requests and release only on stream completion", async (t) => {
  const pool = slots(), responses = [];
  const fetch = async () => { const response = heldResponse(); responses.push(response); return response.response; };
  const s = await fixture(t, pool, fetch);
  const sessions = [s, await fixture(t, pool, fetch, { role: "planner-cycle-1", root: s.root }), await fixture(t, pool, fetch, { role: "window-review", root: s.root })];
  const streams = Array.from({ length: 9 }, (_, index) => sessions[index % sessions.length].runtime.streamSimple(model, context));
  for (const stream of streams) assert.equal(typeof stream.result, "function", "ModelRuntime remains synchronous");
  await settle();
  assert.equal(responses.length, 8);
  assert.equal(pool.active, 8);
  assert.equal(pool.queue.length, 1);
  responses[0].finish();
  assert.equal((await streams[0].result()).stopReason, "stop");
  await settle();
  assert.equal(responses.length, 9);
  for (const response of responses.slice(1)) response.finish();
  assert.ok((await Promise.all(streams.map((stream) => stream.result()))).every((message) => message.stopReason === "stop"));
  await settle();
  assert.equal(pool.maxActive, 8);
  assert.equal(pool.released, 9);
  assert.equal(pool.active, 0);
  const events = sessions.flatMap(({ metrics }) => metrics.requestSlots.events);
  assert.equal(events.filter((event) => event.type === "granted").length, 9);
  assert.equal(events.filter((event) => event.type === "released").length, 9);
  assert.equal(pool.options[0].root, process.env.TIANSHU_ROOT || s.root);
  assert.equal(pool.options[0].limit, 8);
  assert.equal(pool.options[0].runId, path.basename(s.runDir));
  assert.equal(new Set(pool.options.map((options) => options.runId)).size, 3);
});

test("a cancelled queued native request never reaches fetch or the original payload callback", async (t) => {
  const pool = slots(), blockers = await Promise.all(Array.from({ length: 8 }, () => pool.acquire({})));
  let fetches = 0, callbacks = 0;
  const s = await fixture(t, pool, async () => { fetches++; throw new Error("must stay offline"); });
  const controller = new AbortController();
  const stream = s.runtime.streamSimple(model, context, { signal: controller.signal, onPayload() { callbacks++; } });
  await settle();
  assert.equal(pool.queue.length, 1);
  controller.abort();
  assert.equal((await stream.result()).stopReason, "aborted");
  assert.equal(fetches, 0);
  assert.equal(callbacks, 0);
  assert.equal(pool.queue.length, 0);
  assert.equal(s.metrics.requestSlots.waitingSince, null);
  for (const blocker of blockers) blocker.release();
});

test("native SSE abort cleans up its reader before releasing the active request lease", async (t) => {
  const pool = slots();
  let cancelled = false;
  const s = await fixture(t, pool, async () => heldResponse(() => { assert.equal(pool.active, 1); cancelled = true; }).response);
  const controller = new AbortController();
  const stream = s.runtime.streamSimple(model, context, { signal: controller.signal });
  await settle();
  assert.equal(pool.active, 1);
  controller.abort();
  assert.equal((await stream.result()).stopReason, "aborted");
  await settle();
  assert.equal(cancelled, true);
  assert.equal(pool.active, 0);
  assert.equal(pool.released, 1);
});

test("native payload replacement and payload rejection preserve callback semantics and release leases", async (t) => {
  const pool = slots();
  let fetches = 0, observed;
  const s = await fixture(t, pool, async (_url, init) => {
    fetches++;
    const bytes = init.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(init.body) : init.body;
    observed = JSON.parse(bytes.toString());
    const response = heldResponse(); response.finish(); return response.response;
  });
  let callbacks = 0;
  const stream = s.runtime.streamSimple(model, context, { async onPayload(payload, selectedModel) {
    callbacks++;
    assert.equal(pool.active, 1);
    assert.equal(selectedModel, model);
    return { ...payload, instructions: "replacement from original callback" };
  } });
  assert.equal((await stream.result()).stopReason, "stop");
  assert.equal(observed.instructions, "replacement from original callback");
  const rejected = s.runtime.streamSimple(model, context, { onPayload() { throw new Error("offline callback rejection"); } });
  assert.match((await rejected.result()).errorMessage, /offline callback rejection/);
  await settle();
  assert.equal(callbacks, 1);
  assert.equal(fetches, 1);
  assert.equal(pool.released, 2);
});

test("native HTTP retry stays serial under one lease and non-GPT runtimes remain unchanged", async (t) => {
  const pool = slots();
  let fetches = 0;
  const s = await fixture(t, pool, async () => {
    assert.equal(pool.active, 1);
    if (++fetches === 1) return new Response("transient fixture", { status: 503, headers: { "retry-after": "0" } });
    const response = heldResponse(); response.finish(); return response.response;
  }, { runtimeOptions: { maxRetries: 1 } });
  assert.equal((await s.runtime.streamSimple(model, context).result()).stopReason, "stop");
  await settle();
  assert.equal(fetches, 2);
  assert.equal(pool.acquired, 1);
  assert.equal(pool.released, 1);
  const other = await fixture(t, pool, () => { throw new Error("not called"); }, { family: "deepseek" });
  assert.equal(other.runtime.streamSimple, other.original);
  assert.equal(other.metrics.requestSlots, undefined);
});

test("watchdog excludes only new queue wait and keeps its original zero-wait timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let finish, aborts = 0;
  const metrics = { prompts: 0, modelErrors: [], requestSlots: { waitMs: 0, waitingSince: null } };
  const session = { prompt: () => new Promise((resolve) => { finish = resolve; }), abort() { aborts++; finish(); } };
  const pending = promptWithWatchdog(session, metrics, "queued", 100);
  void pending.catch(() => {});
  t.mock.timers.tick(20);
  metrics.requestSlots.waitingSince = Date.now();
  t.mock.timers.tick(80);
  assert.equal(aborts, 0);
  t.mock.timers.tick(20);
  metrics.requestSlots.waitMs = 100;
  metrics.requestSlots.waitingSince = null;
  t.mock.timers.tick(60);
  t.mock.timers.tick(19);
  assert.equal(aborts, 0);
  t.mock.timers.tick(1);
  await assert.rejects(pending, /100ms watchdog/);
  assert.equal(aborts, 1);
  assert.equal(metrics.promptAttempts[0].requestSlotWaitMs, 100);
  const noWait = promptWithWatchdog(session, metrics, "not queued", 100);
  t.mock.timers.tick(99);
  assert.equal(aborts, 1);
  t.mock.timers.tick(1);
  await assert.rejects(noWait, /100ms watchdog/);
  assert.equal(aborts, 2);
});
