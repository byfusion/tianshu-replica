import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TEXT_MODEL_PROFILES, resolveTextModel, credentialsForTextModel, isNonRetryableModelError, modelRedactionKeys } from "../src/model-profiles.mjs";
import { promptWithWatchdog } from "../src/experiments/lib.mjs";

function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-models-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test("three fixed text model pairs and the ds alias resolve without stage mixing", () => {
  for (const [family, expected] of Object.entries(TEXT_MODEL_PROFILES)) {
    assert.deepEqual(resolveTextModel({ model: family, agentDir: "/tmp/config", env: {} }), { ...expected, agentDir: "/tmp/config" });
  }
  assert.equal(resolveTextModel({ model: "ds", env: {} }).family, "deepseek");
  assert.equal(resolveTextModel({ model: "gpt", env: { TIANSHU_MODEL_PROVIDER: "deepseek", TIANSHU_MODEL_ID: "deepseek-flash" } }).provider, "openai-codex");
  assert.throws(() => resolveTextModel({ env: { TIANSHU_MODEL_PROVIDER: "deepseek", TIANSHU_MODEL_ID: "gpt-6-astra" } }), /unsupported.*pair/);
  assert.throws(() => resolveTextModel({ env: { TIANSHU_MODEL_PROVIDER: "deepseek" } }), /supplied together/);
  assert.throws(() => resolveTextModel({ model: "gemini", env: {} }), /unknown.*family/);
});

test("credentials check reads the selected directory without exposing credentials", (t) => {
  const agentDir = fixture(t), selected = { agentDir, provider: "openai-codex" };
  assert.equal(credentialsForTextModel(selected).configured, false);
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: "test-oauth-access", refresh: "test-oauth-refresh" } }));
  assert.deepEqual(credentialsForTextModel(selected), { configured: true, source: "auth.json", ...selected });
  assert.ok(!JSON.stringify(credentialsForTextModel(selected)).includes("test-oauth"));
  assert.ok(modelRedactionKeys(agentDir, {}).includes("test-oauth-access"));
  assert.ok(modelRedactionKeys(agentDir, {}).includes("test-oauth-refresh"));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { deepseek: { apiKey: "DS_TEST_KEY" } } }));
  assert.equal(credentialsForTextModel({ agentDir, provider: "deepseek" }).source, "models.json");
  fs.writeFileSync(path.join(agentDir, "auth.json"), "invalid");
  assert.throws(() => credentialsForTextModel(selected), { code: "TIANSHU_MODEL_CONFIG_INVALID" });
});

test("installed SDK registers the required GPT text model without model refresh or requests", async (t) => {
  const dir = fixture(t);
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const model = runtime.getModel("openai-codex", "gpt-6-astra");
  assert.equal(model?.api, "openai-codex-responses");
  assert.equal(runtime.getModel("kimi-coding", "k3-256k")?.provider, "kimi-coding");
});

test("confirmed auth, payment and quota refusal make one attempt; transient 429 is not misclassified", async () => {
  for (const reason of ["401 invalid_api_key", "HTTP 402 payment required", "403 forbidden", "429 insufficient_quota", "monthly usage limit reached", "credit balance too low"]) {
    assert.equal(isNonRetryableModelError(reason), true);
    let calls = 0;
    const metrics = { prompts: 0, modelErrors: [] };
    await assert.rejects(promptWithWatchdog({ prompt: async () => { calls++; metrics.modelErrors.push({ errorMessage: reason }); }, abort() {} }, metrics, "offline", 1000), /Pi request rejected/);
    assert.equal(calls, 1);
  }
  assert.equal(isNonRetryableModelError("429 rate limit temporarily exceeded"), false);
});
