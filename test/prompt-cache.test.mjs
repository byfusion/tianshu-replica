import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPiExperimentSession, promptWithWatchdog } from "../src/experiments/lib.mjs";
import { writeExecutionContract } from "../src/execution-contract.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const { streamSimple: codexStream } = await import(path.join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js"));
const token = `offline.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-cache-fixture" } })).toString("base64url")}.fixture`;
const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra", baseUrl: "https://offline.invalid", reasoning: true, input: ["text"], contextWindow: 400000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-prompt-cache-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: token } }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  async function create(role, { runName = "offline-story", systemPrompt = "Preserve the approved story and submit the complete episode." } = {}) {
    const runDir = path.join(root, "runs", runName);
    if (!fs.existsSync(runDir)) writeExecutionContract(runDir, { model: "gpt", agentDir, env: {} });
    const runtime = {
      getModel: () => model,
      hasConfiguredAuth: () => true,
      getAuth: async () => ({ auth: { apiKey: token } }),
      streamSimple: (selected, context, options) => codexStream(selected, context, {
        ...options, apiKey: token, transport: "sse", maxRetries: 0,
        fetch: async (_url, init) => {
          const bytes = init.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(init.body) : init.body;
          requests.push({ body: JSON.parse(bytes.toString()), sessionId: init.headers.get("session-id") });
          // Synthetic usage verifies accounting only; it is not a provider cache hit.
          return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "offline-response", status: "completed", output: [{ type: "message", id: "offline-message", role: "assistant", content: [{ type: "output_text", text: "complete" }] }], usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 2, total_tokens: 1202 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        },
      }),
    };
    const settingsManager = SettingsManager.inMemory({ transport: "sse", retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const created = await createPiExperimentSession({ runDir, role, systemPrompt, customTools: [], toolNames: [] }, {
      ModelRuntime: { create: async () => runtime }, SessionManager,
      createAgentSession: (options) => createAgentSession({ ...options, settingsManager, resourceLoader }),
      acquireRequestSlot: async () => ({ requestId: "offline-slot", slot: 0, release() {} }),
    });
    t.after(() => created.session.dispose());
    return { ...created, runtime };
  }
  return { create, requests };
}

test("native SDK storyboard lanes, rotations and legacy batches share one cache key with independent session IDs and high reasoning", async (t) => {
  const f = await fixture(t);
  const first = await f.create("storyboard-1-5");
  const second = await f.create("storyboard-lane-1-session-1");
  const rotated = await f.create("storyboard-lane-8-session-2");
  const resumed = await f.create("storyboard-1-5");
  for (const current of [first, second, rotated, resumed]) await promptWithWatchdog(current.session, current.metrics, "Produce the assigned episode.");
  assert.equal(new Set(f.requests.map((request) => request.sessionId)).size, 4);
  assert.equal(new Set(f.requests.map((request) => request.body.prompt_cache_key)).size, 1);
  assert.deepEqual(f.requests[0].body.input, f.requests[1].body.input);
  assert.equal(f.requests[0].body.instructions, f.requests[1].body.instructions);
  assert.equal(f.requests[0].body.reasoning.effort, "high");
  assert.equal(first.metrics.promptCache.kind, "routing_hint");
  assert.equal(first.metrics.usage[0].cacheRead, 1000, "only the synthetic SDK usage populates the cache count");
  assert.match(f.requests[0].body.input[0].content[0].text, /Preserve the approved story/);
});

test("review cycles reuse routing groups, changed task text stays in the payload, and other runs and roles stay separate", async (t) => {
  const f = await fixture(t);
  const windows = [await f.create("screenplay-window-review-1-5-cycle-1"), await f.create("screenplay-window-review-6-10-cycle-2")];
  const final = await f.create("screenplay-series-review-cycle-2");
  const otherRun = await f.create("screenplay-window-review-1-5-cycle-1", { runName: "other-story" });
  for (const [index, current] of [...windows, final, otherRun].entries()) await promptWithWatchdog(current.session, current.metrics, `Review current artifacts ${index}.`);
  const keys = f.requests.map((request) => request.body.prompt_cache_key);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.notEqual(keys[0], keys[3]);
  assert.notDeepEqual(f.requests[0].body.input, f.requests[1].body.input, "routing hints never reuse a prior response or replace current artifacts");
  assert.ok(keys.every((key) => Array.from(key).length <= 64));
});

test("native cache opt-out and existing payload callbacks keep their SDK semantics", async (t) => {
  const f = await fixture(t);
  const current = await f.create("storyboard-1-5", { runName: "long-story-name-that-still-needs-a-bounded-cache-routing-key" });
  const context = { messages: [{ role: "user", content: "Current episode", timestamp: 0 }] };
  await current.runtime.streamSimple(model, context, { sessionId: "isolated-native-session", cacheRetention: "none" }).result();
  assert.equal(f.requests[0].body.prompt_cache_key, undefined);
  await current.runtime.streamSimple(model, context, { sessionId: "isolated-native-session", onPayload(payload) {
    assert.equal(Array.from(payload.prompt_cache_key).length <= 64, true);
    return { ...payload, instructions: "Existing payload callback remains effective" };
  } }).result();
  assert.equal(f.requests[1].body.instructions, "Existing payload callback remains effective");
  assert.equal(f.requests[1].sessionId, "isolated-native-session");
});
