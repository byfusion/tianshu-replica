import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as agents from "../src/agents.mjs";
import * as core from "../src/core.mjs";
import * as replication from "../src/replication.mjs";
import * as market from "../src/market.mjs";
import {
  canonicalReviewContext,
  episodePayload,
  planningPayload,
} from "../src/semantic-review.mjs";
import { Compile, readText } from "../src/experiments/lib.mjs";

const lastSource = {
  firstStart: "SOURCE32_A_START：电闸起火，林夏拿到绝缘钳。",
  firstEnd: "SOURCE32_A_END：她断开电闸，门外却传来求救。",
  secondStart: "SOURCE32_B_START：周舟发现后门被锁。",
  secondEnd: "SOURCE32_B_END：锁打开，来客身份仍未知。",
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-resegmentation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = Array.from(
    { length: 31 },
    (_, index) =>
      `## 第${index + 1}集\n源事件${index + 1}开始。林夏与周舟完成当前修理任务，保留既有因果和身份未知。源事件${index + 1}结束。`,
  );
  sources.push(`## 第32集\n${Object.values(lastSource).join("\n")}`);
  const materials = {
    creative: "合成离线素材：林夏与周舟修复街坊旧店，在险情中互相帮助。",
    characters: "林夏是店主，周舟是修理师；来客身份未知，不推断亲属关系。",
    outline: sources.join("\n\n"),
    provenance: { evidenceType: "synthetic-text-test", directVideoUnderstanding: false },
  };
  const input =
    "目标市场：中国。保留全部源事件，长源段按冲突和尾钩按60–90秒目标、75秒常态、100秒硬上限重分输出集。";
  const { dir } = core.createRun(root, {
    title: "长源段重分集离线验证",
    input,
    sourceMaterials: materials,
    sourceTotalEpisodes: 32,
  });
  const map = Array.from({ length: 31 }, (_, index) => ({
    sourceEpisodes: [index + 1],
    startEvent: `源事件${index + 1}开始。`,
    endEvent: `源事件${index + 1}结束。`,
    targetSeconds: 90,
  }));
  map.push(
    {
      sourceEpisodes: [32],
      startEvent: lastSource.firstStart,
      endEvent: lastSource.firstEnd,
      targetSeconds: 78,
    },
    {
      sourceEpisodes: [32],
      startEvent: lastSource.secondStart,
      endEvent: lastSource.secondEnd,
      targetSeconds: 88,
    },
  );
  const bundle = {
    market: {
      ...market.inferMarketIntent(input),
      setting: "中国街区的旧店与修理铺，原有商业与日常生活环境保持对应。",
      characterNaming: "保留林夏、周舟这两个已确认姓名，不给未确认来客新增身份。",
      socialContext: "中国街坊相互协作修复旧店，不新增超出原素材的制度关系。",
      culturalAnchors: ["街坊旧店", "修理铺"],
    },
    acts: `${"各阶段保留源事件的因果、人物状态和待解问题。".repeat(8)}\n需要精修的阶段句。`,
    design: "以当前冲突、转折与既有尾钩安排每集，不增加闲聊或重复反应填时长。".repeat(6),
    characters: "林夏是店主，周舟是修理师；来客身份仍未知，不新增或合并人物关系。".repeat(6),
    ledger: { names: ["林夏", "周舟"], facts: ["林夏经营旧店", "周舟负责修理", "来客身份未知"] },
    continuityContract:
      "保留已经发生的源事件与人物认知，按输出集逐集推进；后续事件未发生时不提前写成当前状态，未确认身份仍未知。".repeat(
        6,
      ),
    outline: map.map(
      (part, index) =>
        `输出第${index + 1}集：${part.startEvent}依照原有行动与因果推进，不重复上一部分结局，不提前兑现下一部分事件。${part.endEvent}`,
    ),
    episodeMap: map,
  };
  return { dir, bundle, materials, mapFile: path.join(dir, "canonical", "episode-map.json") };
}

// Use the production function and real tool schema/validators/promoter. Only the
// model session and transport are replaced; these tests cannot call a provider.
function offlinePlanner(action) {
  let sessions = 0;
  const dependencies = {
    createSession: async (options) => {
      sessions += 1;
      return {
        session: { options, dispose() {} },
        metrics: { prompts: 1, assistantMessages: 0, usage: [] },
      };
    },
    prompt: async (session, _metrics, prompt) =>
      action(
        session.options,
        async (name, args) => {
          const tool = session.options.customTools.find((item) => item.name === name);
          assert.ok(tool, `missing ${name}`);
          assert.ok(
            Compile(tool.parameters).Check(args),
            "offline submission must satisfy the real tool schema",
          );
          return tool.execute("offline-resegmentation", args);
        },
        prompt,
      ),
  };
  return {
    run: (dir, repair) => agents.generatePlanningBundle(dir, repair, dependencies),
    sessions: () => sessions,
  };
}

function offlinePlan(planner, review) {
  return (dir, options = {}) =>
    agents.plan(dir, { ...options, generateBundle: planner.run, review });
}

test("a long source can split into a later output episode and all production roles receive its actual source mapping", async (t) => {
  const f = fixture(t);
  assert.equal(core.loadManifest(f.dir).sourceEpisodes, 32);
  const planner = offlinePlanner(async (_settings, invoke) => {
    const invalid = structuredClone(f.bundle);
    invalid.episodeMap[0].sourceEpisodes = [2];
    const rejected = await invoke("submit_planning_bundle", invalid);
    assert.match(rejected.content[0].text, /^REJECTED/);
    assert.equal(fs.existsSync(f.mapFile), false);
    assert.equal(fs.existsSync(path.join(f.dir, "canonical", "outline.md")), false);
    assert.equal(core.loadManifest(f.dir).episodes, 32);
    const accepted = await invoke("submit_planning_bundle", f.bundle);
    assert.match(accepted.content[0].text, /^ACCEPTED/);
  });
  await offlinePlan(planner, async (dir, stage) => {
    assert.equal(stage, "planning");
    assert.equal(core.loadManifest(dir).episodes, 33);
    assert.ok(planningPayload(dir).includes(lastSource.secondStart));
    return { plan: { action: "pass" } };
  })(f.dir);
  const manifest = core.loadManifest(f.dir);
  assert.equal(manifest.episodes, 33);
  assert.equal(manifest.sourceEpisodes, 32);
  assert.equal(manifest.state, "awaiting_approval");
  assert.deepEqual(JSON.parse(readText(f.mapFile)), f.bundle.episodeMap);
  assert.equal(replication.readReplicationSource(f.dir).episodes.length, 32);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, "screenplay")), []);

  for (const context of [
    replication.replicationWriterContext(f.dir, 33),
    agents.storyboardSourceContext(f.dir, 33),
    episodePayload(f.dir, "screenplay", 33),
    episodePayload(f.dir, "storyboard", 33),
  ]) {
    assert.ok(context.includes(lastSource.secondStart));
    assert.ok(context.includes(lastSource.secondEnd));
    assert.match(context, /88/);
    assert.doesNotMatch(context, /源事件31开始/);
  }
  for (const context of [planningPayload(f.dir), canonicalReviewContext(f.dir)]) {
    assert.ok(context.includes("episode-map.json"));
    assert.ok(context.includes(lastSource.firstEnd));
    assert.ok(context.includes(lastSource.secondStart));
  }
  assert.equal(planner.sessions(), 1);
});

test("a local planning patch preserves the approved split map and output count", async (t) => {
  const f = fixture(t);
  const initial = offlinePlanner(async (_settings, invoke) =>
    assert.match((await invoke("submit_planning_bundle", f.bundle)).content[0].text, /^ACCEPTED/),
  );
  await offlinePlan(initial, async () => ({ plan: { action: "pass" } }))(f.dir);
  const mapBefore = readText(f.mapFile);
  const outlineBefore = readText(path.join(f.dir, "canonical", "outline.md"));
  const sourceBefore = readText(path.join(f.dir, "canonical", "source-outline.md"));
  const state = core.loadManifest(f.dir);
  state.state = "returned";
  core.saveManifest(f.dir, state);
  const patch = offlinePlanner(async (_settings, invoke, prompt) => {
    assert.ok(prompt.includes(lastSource.secondStart));
    const result = await invoke("submit_planning_patch", {
      replacements: [
        {
          file: "acts.md",
          old_text: "需要精修的阶段句。",
          new_text: "本阶段只处理已经发生的事件，来客身份仍未知。",
        },
      ],
    });
    assert.match(result.content[0].text, /^ACCEPTED/);
  });
  await offlinePlan(patch, async () => ({ plan: { action: "pass" } }))(f.dir, {
    operatorNote: "仅精修 acts.md 的指定句，保留现有分集。",
  });
  assert.equal(readText(f.mapFile), mapBefore);
  assert.equal(readText(path.join(f.dir, "canonical", "outline.md")), outlineBefore);
  assert.equal(readText(path.join(f.dir, "canonical", "source-outline.md")), sourceBefore);
  assert.match(readText(path.join(f.dir, "canonical", "acts.md")), /来客身份仍未知/);
  assert.equal(core.loadManifest(f.dir).episodes, 33);
  assert.equal(core.loadManifest(f.dir).sourceEpisodes, 32);
  assert.equal(core.loadManifest(f.dir).state, "awaiting_approval");
});

test("review reception failure resumes the completed mapped plan without another Planner call", async (t) => {
  const f = fixture(t);
  const planner = offlinePlanner(async (_settings, invoke) =>
    assert.match((await invoke("submit_planning_bundle", f.bundle)).content[0].text, /^ACCEPTED/),
  );
  let reviewCalls = 0;
  const run = offlinePlan(planner, async (dir) => {
    reviewCalls += 1;
    assert.equal(core.loadManifest(dir).episodes, 33);
    if (reviewCalls === 1) throw new Error("offline review reception interrupted");
    return { plan: { action: "pass" } };
  });
  await assert.rejects(run(f.dir), /offline review reception interrupted/);
  assert.equal(core.loadManifest(f.dir).state, "planning");
  const mapBefore = readText(f.mapFile);
  assert.equal(agents.completedPlanningMetrics(f.dir).outcome, "completed");
  await run(f.dir);
  assert.equal(planner.sessions(), 1);
  assert.equal(reviewCalls, 2);
  assert.equal(readText(f.mapFile), mapBefore);
  assert.equal(core.loadManifest(f.dir).state, "awaiting_approval");
  assert.equal(core.loadManifest(f.dir).episodes, 33);
});
