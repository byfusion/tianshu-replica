import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { planningTaskPrompt, storyboardSourceContext } from "../src/agents.mjs";
import * as agentPrompts from "../src/agent-prompts.mjs";
import * as attraction from "../src/attraction.mjs";
import * as replication from "../src/replication.mjs";
import { observedSnapshotReferences, reviewContinuityUpdate } from "../src/continuity.mjs";
import { episodeMapContext } from "../src/episode-map.mjs";
import { readJson, readText } from "../src/core.mjs";
import { Type, defineTool } from "../src/experiments/lib.mjs";
import { inferMarketIntent, marketContractMarkdown } from "../src/market.mjs";
import { createReplicationProductionContract } from "../src/production-contract.mjs";
import { semanticRepairPlan } from "../src/review.mjs";
import { planningPayload, reviewSeries, seriesReviewSubmissionTool } from "../src/semantic-review.mjs";
import { agentFixture, invokeAgentTool } from "./helpers/agent-fixtures.mjs";

// Entirely synthetic evidence. These tests audit evidence transport and repair
// scope, not a model's ability to identify people or judge a performance.
const sourceIdentity = "源人物依据：段1名牌确认 Milo Reed；他抱起妹妹 Nia Reed。段2无切换地接住同一抱持动作，Nia叫他Milo，故‘黑衣男子’仍为Milo，不要求每段重新亮名牌。";
const separatePerson = "反例：桥下送货人 Leon Pike 也穿黑雨衣，与Milo同框、分别应答；服装相同不能合并两人，远处未应答的旁观者身份仍未知。";
const approvedIdentity = "批准迁移：Milo Reed对应Evan Cole，Nia Reed对应Tessa Cole；段2黑衣男子继续使用Evan Cole的制作身份。Leon Pike对应Owen Hart，不能并入Evan。观众暂不知道旁观者是谁。";
const visualAnchor = "源视觉锚点：Nora Vale坐在董事会主位，亲手签下撤资决定，众董事停止交谈等她落笔；此可见行为建立她有实际决策权，不能只剩‘她是董事长’的身份旁白。";
const approvedVisual = "批准视觉处理：Nora Vale迁移为Nora Quinn；保留她作出撤资决定、他人等待她决定的权力关系。可以改成她合上项目文件、众人随她示意停止会议，不要求复刻座椅、机位或同一笔。";
const sourceEpisodes = [
  `${visualAnchor}\n名牌确认Milo Reed后，他在桥下抱起Nia Reed。`,
  `紧接桥下抱持动作，黑衣男子被Nia叫作Milo；送货人Leon从一旁递来雨披。${separatePerson}`,
];
const drafts = {
  weakened: "# 第 1 集｜董事长\nNora坐在家中沙发，旁白说‘她是董事长’；画面没有决定或他人回应。随后Evan在雨中抱起Tessa。",
  equivalent: "# 第 1 集｜撤资\n会议室里Nora合上项目文件，说不再投资；众人停下讨论等待她示意，随后按她决定散会。随后Evan在雨中抱起Tessa。",
  anonymous: "# 第 2 集｜雨披\n承接上集抱持姿势，黑衣男子抱着倒地女子；人物栏仅写黑衣男子、倒地女子。Owen站在一旁递雨披，未与男子合并。",
};

function evidenceFixture(t) {
  const fixture = agentFixture(t, { episodes: 2, provider: "openai-codex" });
  const manifest = { ...JSON.parse(fixture.read("manifest.json")), sourceEpisodes: 2, scope: { kind: "full-series" } };
  const contract = createReplicationProductionContract();
  const market = inferMarketIntent("目标市场：美国");
  fixture.write("manifest.json", manifest);
  fixture.write("canonical/production-contract.json", contract);
  fixture.write("canonical/market.json", market);
  fixture.write("canonical/market-contract.md", marketContractMarkdown(market));
  fixture.write("canonical/input.md", "目标市场：美国。依据合成素材保留人物身份和权力关系，允许自然表演与市场适配。");
  fixture.write("canonical/source-creative.md", "看点是可见的决策权与雨夜的兄妹照护；身份旁白不能替代权力动作。");
  fixture.write("canonical/source-characters.md", `${sourceIdentity}\n${separatePerson}\n${visualAnchor}`);
  fixture.write("canonical/source-outline.md", sourceEpisodes.map((text, i) => `## 第${i + 1}集\n${text}`).join("\n\n"));
  fixture.write("canonical/characters.md", `${approvedIdentity}\n${approvedVisual}`);
  fixture.write("canonical/design.md", approvedVisual);
  fixture.write("canonical/acts.md", "董事会决定之后切到雨夜，第二集延续抱持与递雨披；不新增身份反转。");
  fixture.write("canonical/outline.md", "## 第1集\nNora做出撤资决定；Evan在桥下抱起Tessa。\n\n## 第2集\n连续抱持后Owen递雨披；不重演上一集决定或抱起动作。");
  // Keep the source/approved identity evidence out of this abbreviated baseline:
  // Continuity must receive the actual character records, not guess from it.
  fixture.write("canonical/continuity-contract.md", "已发生事件按输出集推进，保持人物关系和未决旁观者身份，不提前发生后集事件。");
  fixture.write("canonical/ledger.json", { names: ["Evan Cole", "Tessa Cole", "Owen Hart", "Nora Quinn"] });
  fixture.write("canonical/episode-map.json", [
    { sourceEpisodes: [1], startEvent: "会议开始", endEvent: "抱起妹妹", targetSeconds: 75 },
    { sourceEpisodes: [2], startEvent: "保持抱持", endEvent: "收到雨披", targetSeconds: 75 },
  ]);
  fixture.write("screenplay/ep-01.md", drafts.weakened);
  fixture.write("screenplay/ep-02.md", drafts.anonymous);
  return { ...fixture, manifest, contract };
}

async function captureContinuity(fixture) {
  let captured;
  const stop = new Error("offline: captured Continuity request before model submission");
  const context = {
    contract: fixture.read("canonical/continuity-contract.md"),
    current: { lastEpisode: 1, snapshot: "Evan仍在桥下抱着Tessa，Nora已作出撤资决定；送货人尚未递出雨披。" },
  };
  // Existing Continuity tests use this seam: execute the production function
  // itself, retaining real source/context builders, and replace only I/O.
  const run = vm.runInNewContext(`(${reviewContinuityUpdate.toString()})`, {
    fs, path, process: { env: {} }, Type, defineTool, readJson, readText,
    parseSourceOutline: replication.parseSourceOutline,
    episodeMapContext,
    observedSnapshotReferences,
    continuityContext: () => context,
    replicationCharacterContext: replication.replicationCharacterContext,
    buildContinuityTaskPrompt: agentPrompts.buildContinuityTaskPrompt,
    characterIdentityGuidance: attraction.characterIdentityGuidance,
    ep: (number) => String(number).padStart(2, "0"),
    createPiExperimentSession: async ({ systemPrompt }) => ({
      session: { systemPrompt, dispose() {} }, metrics: {},
    }),
    promptWithWatchdog: async (session, _metrics, prompt) => {
      captured = { systemPrompt: session.systemPrompt, prompt };
      throw stop;
    },
    commitContinuityReview: () => assert.fail("capture must not commit a fabricated semantic result"),
    appendMetrics: () => {},
  });
  await assert.rejects(run(fixture.dir, {
    episode: 2, screenplay: drafts.anonymous,
    proposedUpdate: "黑衣男子继续抱着女子，收到另一人的雨披。",
  }), (error) => error === stop);
  return captured;
}

test("continuous named-to-functional labels retain source and approved identity evidence at the actual Continuity boundary", async (t) => {
  const fixture = evidenceFixture(t);
  const captured = await captureContinuity(fixture);
  // This fails on the old implementation: it sends only outline/baseline/state,
  // leaving both confirmed name linkage and the distinct same-clothes person out.
  for (const evidence of [sourceIdentity, approvedIdentity, separatePerson]) {
    assert.ok(captured.prompt.includes(evidence), `Continuity is missing evidence: ${evidence}`);
  }
  assert.ok(captured.prompt.includes(drafts.anonymous));
  assert.ok(captured.prompt.includes(attraction.characterIdentityGuidance));
  assert.equal(fixture.exists("continuity/ep-02.json"), false);
});

test("planning, writing and storyboard contexts preserve both the confirmed linkage and its same-clothes counterexample", (t) => {
  const fixture = evidenceFixture(t);
  const writerPrompt = agentPrompts.buildWriterTaskPrompt({
    sample: "", budgetGuidance: "", episode: 2, marketContract: "", contractText: "",
    continuity: { contract: fixture.read("canonical/continuity-contract.md"), current: { snapshot: "上集已完成抱持。" } },
    outline: fixture.read("canonical/outline.md"), characters: fixture.read("canonical/characters.md"),
    ledger: fixture.read("canonical/ledger.json"), nearby: "",
    sourceContext: replication.replicationWriterContext(fixture.dir, 2), repair: "",
  });
  const contexts = [
    replication.replicationPlannerContext(fixture.dir),
    planningTaskPrompt(fixture.dir, fixture.contract, inferMarketIntent(fixture.read("canonical/input.md"))),
    writerPrompt,
    storyboardSourceContext(fixture.dir, 2),
    planningPayload(fixture.dir),
  ];
  for (const context of contexts) {
    assert.ok(context.includes(sourceIdentity));
    assert.ok(context.includes(separatePerson));
    assert.ok(context.includes(visualAnchor));
    assert.ok(context.includes(attraction.characterIdentityGuidance));
  }
  assert.match(attraction.characterIdentityGuidance, /服装.*不能单独证明同一人/);
  for (const context of contexts.slice(2)) assert.ok(context.includes(approvedIdentity));
});

test("independent Reviewer receives visual evidence and actual prose for both a narration-only loss and an equivalent visible action", async (t) => {
  const fixture = evidenceFixture(t);
  for (const current of [drafts.weakened, drafts.equivalent]) {
    fixture.write("screenplay/ep-01.md", current);
    let captured;
    const stop = new Error("offline: captured Reviewer evidence before model submission");
    await assert.rejects(reviewSeries(fixture.dir, "screenplay", [], "Frozen synthetic contract", 1, {
      createSession: async (settings) => ({
        session: { settings, dispose() {} }, metrics: {},
      }),
      prompt: async (session, _metrics, prompt) => {
        const read = session.settings.customTools.find((tool) => tool.name === "read_review_episodes");
        const result = await read.execute("offline-read", { episodes: [1, 2] });
        captured = { systemPrompt: session.settings.systemPrompt, prompt, official: result.content[0].text };
        throw stop;
      },
    }), (error) => error === stop);
    for (const evidence of [sourceIdentity, approvedIdentity, separatePerson, visualAnchor, approvedVisual]) {
      assert.ok(captured.prompt.includes(evidence));
    }
    assert.ok(captured.official.includes(current));
    assert.ok(captured.official.includes(drafts.anonymous));
    assert.match(captured.systemPrompt, /只有身份旁白.*替掉有据展示/);
    assert.match(captured.systemPrompt, /等效视觉改编可以接受/);
    assert.match(captured.systemPrompt, /局部修订/);
    assert.match(captured.systemPrompt, /非阻断 P2/);
  }
  assert.equal(fixture.exists("reviews/screenplay-final.json"), false);
});

test("evidenced identity and visual losses use the existing local repair route without rejecting unrelated episodes", async () => {
  // These are explicit editorial findings for tool/routing validation, not
  // fabricated model verdicts or a claim that a model detected the fixture.
  const findings = [
    { id: "visual-decision-lost", episode: 1, evidence: drafts.weakened,
      reason: "可见撤资决定与众人等待回应被删除，只剩身份旁白。",
      acceptance: "恢复Nora作出决定及他人回应，等效可见动作可接受，不锁定机位。" },
    { id: "confirmed-person-anonymized", episode: 2, evidence: drafts.anonymous,
      reason: "已批准的连续人物对应未进入制作人物栏；观众未知不能清空制作身份。",
      acceptance: "制作人物栏绑定Evan/Tessa，保留Owen为独立人物及旁观者未知。" },
  ].map((finding) => ({
    ...finding, severity: "P1", scope: "local", category: "source_fidelity", disposition: "repair",
    repairInstruction: finding.acceptance,
    preserve: ["兄妹关系、剧情顺序与已批准市场适配"],
    doNotChange: ["不得按黑雨衣合并Owen，不得凭空确认旁观者身份"],
  }));
  let submitted;
  const tool = seriesReviewSubmissionTool({
    stage: "screenplay", totalEpisodes: 8, candidates: [], readEpisodes: new Set([1, 2]),
    onSubmit: (params) => { submitted = params; },
  });
  await invokeAgentTool({ tools: [tool] }, "submit_series_review", {
    summary: "两处有源证据的局部改动，修复不需要修改其它集或批准的剧情。", findings,
  });
  assert.deepEqual(submitted.findings, findings);
  const plan = semanticRepairPlan(submitted.findings, {
    stage: "screenplay", totalEpisodes: 8, cycle: 1, maxCycles: 3,
  });
  assert.equal(plan.action, "repair");
  assert.deepEqual(plan.episodes, [1, 2]);
});
