import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeExecutionContract } from "../src/execution-contract.mjs";
import {
  completedPlanningMetrics,
  generatePlanningBundle,
  plan,
  planningTaskPrompt,
} from "../src/agents.mjs";
import { createProductionContract } from "../src/production-contract.mjs";
import { inferMarketIntent, marketContractMarkdown } from "../src/market.mjs";
import { loadManifest, saveManifest } from "../src/core.mjs";
import {
  Compile,
  readText,
  writeText,
  writeJson,
  collectModelError,
  createPiExperimentSession,
  createSubmissionTrace,
  promptWithWatchdog,
} from "../src/experiments/lib.mjs";

function patchFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-planning-patch-")),
    canonical = path.join(dir, "canonical");
  const oldDirectory = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (oldDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDirectory;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "credentials");
  writeJson(path.join(process.env.PI_CODING_AGENT_DIR, "auth.json"), {
    deepseek: { type: "api_key", key: "test-only-patch-key" },
  });
  writeExecutionContract(dir, { model: "deepseek", agentDir: process.env.PI_CODING_AGENT_DIR });
  const bundle = {
    market: {
      ...inferMarketIntent("目标市场：龙族奇幻世界"),
      locale: "en-GB",
      setting: "Western fantasy dragon palace and nursery",
      characterNaming: "Keep the established English source character names",
      socialContext: "Independent dragon clans govern their own fantasy palaces",
      culturalAnchors: ["Dragon palace", "Clan council"],
    },
    acts: `${"已确认的剧情阶段保持原样。".repeat(20)}\n旧判决归属句。`,
    design: "已确认的设计保持原样。".repeat(20),
    characters: `${"已确认的人物关系保持原样。".repeat(20)}\n旧身份归属句。\n旧气味主语句。`,
    ledger: { names: ["Ava", "Kael"], facts: ["fact one", "fact two", "fact three"] },
    continuityContract: "只保留已确认的连续性状态与来源证据。".repeat(30),
    outline: Array.from(
      { length: 32 },
      (_, i) => `第${i + 1}集原事件：${"原有因果顺序、人物状态和结尾钩子保持原样。".repeat(4)}`,
    ),
  };
  writeJson(path.join(dir, "manifest.json"), {
    episodes: 32,
    state: "planning",
    productionRoute: "tianshu-replication",
    reviewCycles: { planning: 4 },
    revision: 3,
  });
  writeText(path.join(canonical, "input.md"), "目标市场：龙族奇幻世界");
  for (const [field, file] of [
    ["acts", "acts.md"],
    ["design", "design.md"],
    ["characters", "characters.md"],
    ["continuityContract", "continuity-contract.md"],
  ])
    writeText(path.join(canonical, file), bundle[field]);
  writeJson(path.join(canonical, "market.json"), bundle.market);
  writeJson(path.join(canonical, "ledger.json"), bundle.ledger);
  writeText(path.join(canonical, "market-contract.md"), marketContractMarkdown(bundle.market));
  writeText(
    path.join(canonical, "outline.md"),
    bundle.outline.map((text, i) => `## 第${i + 1}集\n${text}`).join("\n\n"),
  );
  for (const [field, file] of [
    ["acts", "source-creative.md"],
    ["characters", "source-characters.md"],
  ])
    writeText(path.join(canonical, file), bundle[field]);
  writeText(
    path.join(canonical, "source-outline.md"),
    readText(path.join(canonical, "outline.md")),
  );
  writeJson(path.join(canonical, "source-provenance.json"), {
    evidenceType: "synthetic-text-test",
  });
  return {
    dir,
    canonical,
    bundle,
    snapshot: () =>
      Object.fromEntries(
        fs.readdirSync(canonical).map((name) => [name, readText(path.join(canonical, name))]),
      ),
  };
}

function offlinePlanner(fixture, action) {
  let trace;
  const dependencies = {
    createSession: async (options) => {
      trace = createSubmissionTrace(fixture.dir, options.role, "submit_planning_bundle");
      return { session: { options, dispose() {} }, metrics: {} };
    },
    prompt: async (session, _metrics, prompt) =>
      action(
        session.options,
        async (name, args) => {
          const tool = session.options.customTools.find((item) => item.name === name);
          assert.ok(tool, `missing ${name}`);
          assert.ok(
            Compile(tool.parameters).Check(args),
            "test input must pass the real tool schema",
          );
          trace.record({
            type: "tool_execution_start",
            toolCallId: "patch-test",
            toolName: name,
            args,
          });
          const result = await tool.execute("patch-test", args);
          trace.record({
            type: "tool_execution_end",
            toolCallId: "patch-test",
            toolName: name,
            result,
            isError: false,
          });
          return result;
        },
        prompt,
      ),
  };
  return {
    run: (repair) => generatePlanningBundle(fixture.dir, repair, dependencies),
    trace: () => trace,
  };
}

test("Planner applies three exact repairs while preserving every other canonical file and its review cycle", async (t) => {
  const f = patchFixture(t),
    before = f.snapshot();
  const replacements = [
    { file: "acts.md", old_text: "旧判决归属句。", new_text: "白发角男的判决，二叔映射待确认。" },
    { file: "characters.md", old_text: "旧身份归属句。", new_text: "两名角色身份映射仍待确认。" },
    { file: "characters.md", old_text: "旧气味主语句。", new_text: "黑鳞幼龙作出本句气味指认。" },
  ];
  const planner = offlinePlanner(f, async (_settings, invoke, prompt) => {
    assert.match(prompt, /submit_planning_patch/);
    const result = await invoke("submit_planning_patch", { replacements });
    assert.match(result.content[0].text, /^ACCEPTED/);
  });
  await planner.run({
    findings: [{ repairInstruction: "仅对acts.md与characters.md做局部精确片段替换。" }],
  });
  const expected = { ...before };
  for (const patch of replacements)
    expected[patch.file] = expected[patch.file].replace(patch.old_text, patch.new_text);
  assert.deepEqual(f.snapshot(), expected);
  assert.equal(loadManifest(f.dir).reviewCycles.planning, 4);
  const candidate = JSON.parse(
    readText(path.join(f.dir, "work", "planner-cycle-5", "patch-candidate.json")),
  );
  assert.equal(candidate.bundle.outline.length, 32);
  assert.equal(candidate.bundle.market.locale, "en-GB");
  const trace = readText(planner.trace().file).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    trace.map((event) => event.toolName),
    ["submit_planning_patch", "submit_planning_patch"],
  );
  assert.deepEqual(trace[0].args.replacements, replacements);
  assert.match(trace[1].result.content[0].text, /^ACCEPTED/);
});

test("missing or non-unique patch text rejects the entire submission before any canonical write", async (t) => {
  for (const old_text of ["不存在的片段", "已确认的人物关系保持原样。"]) {
    const f = patchFixture(t),
      before = f.snapshot();
    const planner = offlinePlanner(f, async (_settings, invoke) => {
      const result = await invoke("submit_planning_patch", {
        replacements: [
          { file: "acts.md", old_text: "旧判决归属句。", new_text: "此项虽匹配也不能提前保存。" },
          { file: "characters.md", old_text, new_text: "新句。" },
        ],
      });
      assert.match(result.content[0].text, /old_text must match exactly once/);
    });
    await assert.rejects(planner.run({ findings: [] }), /planner did not submit/);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(
      fs.existsSync(path.join(f.dir, "work", "planner-cycle-5", "patch-candidate.json")),
      false,
    );
  }
});

test("patch candidates must pass the original full bundle schema and market gate", async (t) => {
  for (const failure of ["schema", "market"]) {
    const f = patchFixture(t);
    if (failure === "market")
      writeJson(path.join(f.canonical, "market.json"), {
        ...f.bundle.market,
        country: "Other country",
      });
    const before = f.snapshot();
    const planner = offlinePlanner(f, async (_settings, invoke) => {
      const replacement =
        failure === "schema"
          ? { file: "acts.md", old_text: before["acts.md"], new_text: "太短" }
          : { file: "acts.md", old_text: "旧判决归属句。", new_text: "修正归属，未知仍保留。" };
      const result = await invoke("submit_planning_patch", { replacements: [replacement] });
      assert.match(
        result.content[0].text,
        failure === "schema" ? /REJECTED.*acts/ : /REJECTED.*market country/,
      );
    });
    await assert.rejects(planner.run({ findings: [] }), /planner did not submit/);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("initial planning exposes only the unchanged full bundle submission interface", async (t) => {
  const f = patchFixture(t);
  const planner = offlinePlanner(f, async (settings, invoke) => {
    assert.deepEqual(Array.from(settings.toolNames), ["submit_planning_bundle"]);
    assert.equal(settings.customTools[0].parameters.type, "object");
    const result = await invoke("submit_planning_bundle", f.bundle);
    assert.match(result.content[0].text, /^ACCEPTED/);
  });
  await planner.run(null);
});

test("Planner traces retain submitted parameters and validation rejections without retrying them as model errors", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-planner-trace-"));
  const oldDirectory = process.env.PI_CODING_AGENT_DIR,
    oldKey = process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (oldDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDirectory;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldKey;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const credentials = path.join(dir, "credentials"),
    configuredKey = "test-only-planner-configured-key",
    environmentKey = "test-only-planner-env-key";
  fs.mkdirSync(credentials);
  fs.writeFileSync(
    path.join(credentials, "auth.json"),
    JSON.stringify({ deepseek: { type: "api_key", key: configuredKey } }),
  );
  process.env.PI_CODING_AGENT_DIR = credentials;
  process.env.DEEPSEEK_API_KEY = environmentKey;
  const trace = createSubmissionTrace(dir, "planner-cycle-1", "submit_planning_bundle");
  const outline = Array.from(
    { length: 32 },
    (_, index) => `第${index + 1}集完整草稿：${"保留因果与人物状态。".repeat(40)}`,
  );
  const args = {
    market: { country: "United States" },
    outline,
    design: `参考字符串 ${configuredKey} / ${environmentKey}`,
  };
  const rejected = {
    content: [
      { type: "text", text: "Validation failed: missing required property continuityContract" },
    ],
    details: { field: "continuityContract" },
  };
  const events = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Planner response is outside its submission-only trace" }],
        stopReason: "stop",
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: "planner-call-1",
      toolName: "submit_planning_bundle",
      args,
    },
    {
      type: "tool_execution_end",
      toolCallId: "planner-call-1",
      toolName: "submit_planning_bundle",
      result: rejected,
      isError: true,
    },
    {
      type: "tool_execution_end",
      toolCallId: "writer-call-1",
      toolName: "submit_screenplay",
      result: { ignored: true },
      isError: false,
    },
  ];
  const metrics = { modelErrors: [] };
  let prompts = 0;
  await promptWithWatchdog(
    {
      async prompt() {
        prompts++;
        for (const event of events) {
          trace.record(event);
          collectModelError(metrics, event);
        }
      },
      async abort() {},
    },
    metrics,
    "offline Planner trace",
    1000,
  );
  assert.equal(prompts, 1);
  assert.deepEqual(metrics.modelErrors, []);
  assert.equal(metrics.promptAttempts[0].status, "succeeded");
  const text = fs.readFileSync(trace.file, "utf8"),
    records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].toolCallId, "planner-call-1");
  assert.deepEqual(records[0].args.outline, outline);
  assert.equal(records[0].args.design, "参考字符串 [REDACTED] / [REDACTED]");
  assert.deepEqual(records[1].result, rejected);
  assert.equal(records[1].isError, true);
  assert.equal(fs.statSync(trace.file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(dir, "canonical")), false);
  const resumedTrace = createSubmissionTrace(dir, "planner-cycle-1", "submit_planning_bundle");
  assert.notEqual(resumedTrace.file, trace.file);
  assert.equal(fs.readFileSync(trace.file, "utf8"), text);
});

test("series Reviewer session cap and assistant trace leave registered models and other role defaults unchanged", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-series-trace-"));
  const oldDirectory = process.env.PI_CODING_AGENT_DIR,
    oldKey = process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (oldDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDirectory;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldKey;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  delete process.env.PI_CODING_AGENT_DIR;
  const key = "test-only-series-trace-key";
  process.env.DEEPSEEK_API_KEY = key;
  const agentDir = path.join(dir, "credentials");
  writeJson(path.join(agentDir, "auth.json"), { deepseek: { type: "api_key", key } });
  writeExecutionContract(dir, { model: "deepseek", agentDir });
  const registeredModel = Object.freeze({
    provider: "deepseek",
    id: "deepseek-flash",
    maxTokens: 32768,
    contextWindow: 1048576,
  });
  const created = [];
  const sdk = {
    ModelRuntime: { create: async () => ({ getModel: () => registeredModel }) },
    createAgentSession: async (options) => {
      const entry = { options };
      created.push(entry);
      return {
        session: {
          subscribe(listener) {
            entry.listener = listener;
          },
          dispose() {},
        },
      };
    },
    SessionManager: { inMemory: () => ({}) },
  };
  const offlineCreate = (options) => createPiExperimentSession(options, sdk);
  const base = { runDir: dir, systemPrompt: "offline role", customTools: [] };
  const review = await offlineCreate({
    ...base,
    role: "planning-series-review-cycle-2",
    thinkingLevel: "high",
    toolNames: ["submit_series_review"],
    maxOutputTokens: 65536,
  });
  assert.equal(created[0].options.model.maxTokens, 65536);
  assert.notEqual(created[0].options.model, registeredModel);
  assert.equal(review.metrics.maxOutputTokens, 65536);
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: `实际审查内容 ${key}` }],
    stopReason: "length",
    rawStopReason: "length",
    usage: { output: 32768 },
  };
  const args = { summary: "完成实际独立审查。", findings: [] };
  const toolResult = {
    content: [{ type: "text", text: "ACCEPTED 0 final findings" }],
    details: { accepted: true },
  };
  for (const event of [
    { type: "message_end", message },
    {
      type: "tool_execution_start",
      toolCallId: "review-call",
      toolName: "submit_series_review",
      args,
    },
    {
      type: "tool_execution_end",
      toolCallId: "review-call",
      toolName: "submit_series_review",
      result: toolResult,
      isError: false,
    },
    { type: "message_end", message: { role: "user", content: "not recorded" } },
  ])
    created[0].listener(event);
  const traceFile = path.join(dir, review.metrics.seriesReviewTrace);
  const records = fs
    .readFileSync(traceFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 3);
  assert.equal(records[0].message.stopReason, "length");
  assert.equal(records[0].message.rawStopReason, "length");
  assert.equal(records[0].message.content[0].thinking, "实际审查内容 [REDACTED]");
  assert.equal(message.content[0].thinking, `实际审查内容 ${key}`);
  assert.deepEqual(records[1].args, args);
  assert.deepEqual(records[2].result, toolResult);
  assert.equal(review.metrics.modelErrors.length, 0);
  assert.equal(fs.statSync(traceFile).mode & 0o777, 0o600);
  for (const [role, toolName] of [
    ["planner-cycle-2", "submit_planning_bundle"],
    ["writer-1-5", "submit_screenplay"],
    ["planning-window-review-1-5", "submit_review"],
  ]) {
    const other = await offlineCreate({ ...base, role, toolNames: [toolName] });
    assert.equal(created.at(-1).options.model.maxTokens, 32768);
    assert.equal(other.metrics.maxOutputTokens, 32768);
    assert.equal(other.metrics.seriesReviewTrace, undefined);
  }
  assert.equal(registeredModel.maxTokens, 32768);
  assert.deepEqual(fs.readdirSync(path.join(dir, "canonical")), ["execution-contract.json"]);
});

test("completed planning remains reusable after a review reception failure", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-planning-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "canonical"));
  fs.mkdirSync(path.join(dir, "metrics"));
  const saveState = (state, planning = 0) =>
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ state, reviewCycles: { planning } }),
    );
  const metricsFile = path.join(dir, "metrics", "planner-cycle-1.json");
  fs.writeFileSync(metricsFile, JSON.stringify({ outcome: "completed", prompts: 1 }));
  saveState("planning");
  assert.equal(completedPlanningMetrics(dir), null);
  for (const name of [
    "acts.md",
    "design.md",
    "outline.md",
    "characters.md",
    "ledger.json",
    "continuity-contract.md",
    "market.json",
    "market-contract.md",
  ])
    fs.writeFileSync(path.join(dir, "canonical", name), "已有已提交产物");
  assert.equal(completedPlanningMetrics(dir).prompts, 1);
  saveState("returned");
  assert.equal(completedPlanningMetrics(dir), null);
  saveState("planning", 1);
  assert.equal(completedPlanningMetrics(dir), null);
  saveState("planning");
  fs.writeFileSync(metricsFile, JSON.stringify({ outcome: "failed", prompts: 1 }));
  assert.equal(completedPlanningMetrics(dir), null);
});

test("a directed planning repair sends the current bundle and operator note to Planner and Reviewer", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-planning-note-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "canonical"));
  const input = "目标市场：美国\n只修复当前小样的源事实偏差。";
  fs.writeFileSync(path.join(dir, "canonical", "input.md"), input);
  const bundle = [
    "acts.md",
    "design.md",
    "outline.md",
    "characters.md",
    "ledger.json",
    "continuity-contract.md",
  ];
  for (const name of bundle) fs.writeFileSync(path.join(dir, "canonical", name), `CURRENT ${name}`);
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ state: "returned", episodes: 3 }),
  );
  const operatorNote = "只纠正救其他人鱼、保留姓名未知、恢复原有台词顺序。";
  saveManifest(dir, { state: "returned", episodes: 3, reviewCycles: { planning: 3 }, revision: 3 });
  let plannerCalls = 0,
    reviewerCalls = 0;
  await plan(dir, {
    operatorNote,
    generateBundle: async (runDir, repair) => {
      plannerCalls += 1;
      assert.equal(repair.findings[0].repairInstruction, operatorNote);
      const prompt = planningTaskPrompt(
        runDir,
        createProductionContract(),
        inferMarketIntent(input),
        repair,
      );
      assert.ok(prompt.includes(operatorNote));
      for (const name of bundle) assert.ok(prompt.includes(`CURRENT ${name}`));
      return { prompts: 1 };
    },
    review: async (runDir, stage, options) => {
      reviewerCalls += 1;
      assert.equal(runDir, dir);
      assert.equal(stage, "planning");
      assert.equal(options.operatorNote, operatorNote);
      assert.equal(loadManifest(dir).reviewCycles.planning, 3);
      return { plan: { action: "pass" } };
    },
  });
  assert.equal(plannerCalls, 1);
  assert.equal(reviewerCalls, 1);
  assert.equal(loadManifest(dir).state, "awaiting_approval");
  assert.equal(loadManifest(dir).reviewCycles.planning, 3);
});
