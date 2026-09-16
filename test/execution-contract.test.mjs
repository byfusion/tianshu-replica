import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRun } from "../src/core.mjs";
import { executionContractPath, executionContractStatus, textModelForRun, textModelForSession, bindRunModel, writeExecutionContract } from "../src/execution-contract.mjs";
import { createPiExperimentSession, collectModelError, createSubmissionTrace } from "../src/experiments/lib.mjs";

const cli = fileURLToPath(new URL("../bin/tianshu.mjs", import.meta.url));
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-contract-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function save(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
function agentDirectory(root, provider, key) { const dir = path.join(root, "agent"); save(path.join(dir, "auth.json"), { [provider]: { type: "api_key", key } }); return dir; }

test("new runs freeze model and configuration reference outside the production contract", (t) => {
  const root = temporary(t), agentDir = path.join(root, "config");
  const { dir } = createRun(root, { title: "frozen", input: "story", model: "ds", agentDir, modelEnv: {} });
  const selected = textModelForRun(dir);
  assert.equal(selected.family, "deepseek");
  assert.equal(selected.provider, "deepseek");
  assert.equal(selected.agentDir, agentDir);
  assert.equal(selected.binding, "created");
  const before = fs.readFileSync(executionContractPath(dir), "utf8");
  const previous = process.env.TIANSHU_MODEL;
  process.env.TIANSHU_MODEL = "gpt";
  t.after(() => { if (previous === undefined) delete process.env.TIANSHU_MODEL; else process.env.TIANSHU_MODEL = previous; });
  assert.deepEqual(textModelForSession(dir), selected);
  assert.equal(fs.readFileSync(executionContractPath(dir), "utf8"), before);
  assert.ok(!fs.readFileSync(path.join(dir, "canonical", "production-contract.json"), "utf8").includes("executionModel"));
});

test("legacy status remains unknown until explicit subsequent-execution binding, with historical files unchanged", (t) => {
  const dir = temporary(t), manifest = { id: "old", episodes: 32, productionRoute: "tianshu-replication", state: "approved" };
  save(path.join(dir, "manifest.json"), manifest);
  save(path.join(dir, "canonical", "production-contract.json"), { frozenOldContract: true });
  const original = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
  assert.deepEqual(executionContractStatus(dir), { status: "legacy-unbound", historicalModel: "unknown" });
  assert.throws(() => textModelForSession(dir), { code: "TIANSHU_LEGACY_UNBOUND" });
  assert.throws(() => bindRunModel(dir, {}), /requires --model/);
  const bound = bindRunModel(dir, { model: "gpt", agentDir: path.join(dir, "gpt-config"), effectiveAt: "2026-09-14T00:00:00.000Z" });
  assert.equal(bound.historicalModel, "unknown");
  assert.equal(bound.appliesTo, "subsequent-execution-only");
  assert.equal(textModelForRun(dir).effectiveAt, "2026-09-14T00:00:00.000Z");
  assert.equal(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"), original);
  assert.throws(() => bindRunModel(dir, { model: "kimi" }), /EEXIST/);
});

test("frozen mixed provider/model contracts are rejected before a session", (t) => {
  const dir = temporary(t);
  writeExecutionContract(dir, { model: "kimi", env: {} });
  const contract = JSON.parse(fs.readFileSync(executionContractPath(dir), "utf8"));
  contract.id = "gpt-6-astra";
  save(executionContractPath(dir), contract);
  assert.throws(() => textModelForRun(dir), /invalid.*contract/);
});

test("session factory resolves runtime, credentials and error trace from the same frozen directory", async (t) => {
  for (const [family, provider, id] of [["kimi", "kimi-coding", "k3-256k"], ["deepseek", "deepseek", "deepseek-flash"], ["gpt", "openai-codex", "gpt-6-astra"]]) {
    const root = temporary(t), key = `offline-${family}-credential`, agentDir = agentDirectory(root, provider, key);
    const { dir } = createRun(root, { title: family, input: "story", model: family, agentDir, modelEnv: {} });
    let runtimeOptions, sessionOptions, subscribed;
    const model = Object.freeze({ provider, id, maxTokens: 32768 });
    const sdk = {
      ModelRuntime: { create: async (options) => { runtimeOptions = options; return { getModel(p, m) { assert.equal(p, provider); assert.equal(m, id); return model; } }; } },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async (options) => { sessionOptions = options; return { session: { subscribe(listener) { subscribed = listener; }, dispose() {} } }; },
    };
    const result = await createPiExperimentSession({ runDir: dir, role: "series-review", systemPrompt: "story", customTools: [], toolNames: ["submit_series_review"], maxOutputTokens: 65536 }, sdk);
    assert.deepEqual(runtimeOptions, { authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    assert.equal(sessionOptions.agentDir, agentDir);
    assert.equal(sessionOptions.model.id, id);
    assert.equal(sessionOptions.thinkingLevel, family === "gpt" ? "high" : "off");
    assert.equal(model.maxTokens, 32768);
    assert.equal(sessionOptions.model.maxTokens, 65536);
    subscribed({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: `401 invalid key: ${key}` } });
    assert.equal(result.metrics.modelErrors[0].errorMessage, "401 invalid key: [REDACTED]");
    const trace = fs.readFileSync(path.join(dir, result.metrics.seriesReviewTrace), "utf8");
    assert.ok(!trace.includes(key));
    assert.ok(trace.includes("[REDACTED]"));
  }
});

test("missing frozen credentials and legacy runs cannot create a production session", async (t) => {
  const root = temporary(t), { dir } = createRun(root, { title: "missing", input: "story", model: "gpt", agentDir: path.join(root, "absent"), modelEnv: {} });
  const options = { runDir: dir, role: "writer", customTools: [], toolNames: [] };
  await assert.rejects(createPiExperimentSession(options), { code: "TIANSHU_MODEL_CREDENTIALS_MISSING" });
  fs.unlinkSync(executionContractPath(dir));
  await assert.rejects(createPiExperimentSession(options), { code: "TIANSHU_LEGACY_UNBOUND" });
});

test("CLI GPT initialization accepts existing three materials and does not start source extraction", (t) => {
  const root = temporary(t), brief = path.join(root, "brief.txt"), materialsFile = path.join(root, "materials.json"), agentDir = path.join(root, "gpt-agent");
  fs.writeFileSync(brief, "保留人物互动和感情变化。");
  const materials = { creative: "店主追回钥匙。", characters: "林夏是店主；周舟是修理师。", outline: "## 第1集\n钥匙丢失。\n## 第2集\n周舟送还钥匙。\n## 第3集\n二人和解。", provenance: { evidenceType: "synthetic-text-test", directVideoUnderstanding: false } };
  save(materialsFile, materials);
  const result = spawnSync(process.execPath, [cli, "--root", root, "init", brief, "--title", "三材料GPT", "--model", "gpt", "--agent-dir", agentDir, "--source-materials", materialsFile, "--sample"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const created = JSON.parse(result.stdout), dir = path.join(root, "runs", created.id);
  assert.equal(created.executionModel.provider, "openai-codex");
  assert.equal(created.state, "draft");
  for (const key of ["creative", "characters", "outline"]) assert.equal(fs.readFileSync(path.join(dir, "canonical", `source-${key}.md`), "utf8"), materials[key]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "metrics")), []);
  assert.ok(!fs.existsSync(`${materialsFile}.extraction`));
  const status = spawnSync(process.execPath, [cli, "--root", root, "status", created.id], { encoding: "utf8" });
  assert.equal(JSON.parse(status.stdout).executionModel.id, "gpt-6-astra");
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /bind-model/);
  assert.match(help.stdout, /GPT text runs never invoke Gemini/);
});
