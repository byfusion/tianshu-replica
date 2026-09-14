import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planningTaskPrompt, storyboardSourceContext } from "../src/agents.mjs";
import { planningPayload, canonicalReviewContext, reviewPrompt } from "../src/semantic-review.mjs";
import { replicationPlannerContext, replicationWriterContext } from "../src/replication.mjs";
import { createReplicationProductionContract } from "../src/production-contract.mjs";
import { inferMarketIntent } from "../src/market.mjs";

const cases = [
  {
    genre: "亲情",
    creative: "看点是照顾逐渐赢得信任；误吞的危机不能覆盖照顾者接住孩子目光的情绪回报。",
    characters: "Ava 是照顾者；Knox 是幼龙。Ava 与 Knox 的血缘未确认。",
    event: "Ava 先伸手又停下，等 Knox 主动抓住她的袖口才抱起他；Knox 无声张口，随后靠在她肩上。",
    design: "保留伸手、犹豫、等待孩子回应和终于依靠的关系变化。已批准身份：照顾者与幼龙，血缘未知。",
  },
  {
    genre: "悬疑",
    creative: "看点是双方知情差：观众先见信封，角色尚不知道信里的消息。",
    characters: "Mira 保管信封；Rowan 不知道信封内容，两人是否亲属未知。",
    event: "Mira 问 Rowan 是否回来取信；Rowan 停在门口没有回答。Mira 把信封压在书下，暂不揭示消息。",
    design: "保留提问对象和未得到回答的反应；信息延迟维持知情差，不能为了快节奏立即拆信。",
  },
  {
    genre: "言情",
    creative: "看点是误会后重新回应对方，而非再制造一次争执。",
    characters: "Lena 与 Theo 曾因误会分开，现已说清误会；没有结婚事实。",
    event: "Lena 对 Theo 说“我会等你”，Theo 抬眼接住她的目光；晚些时候 Theo 回来，对 Lena 再说“我会等你”。这是两次真实发声。",
    design: "保留试探得到回应以及后续呼应形成的和解；同句承诺由不同人物在不同时间说出，关系才从回避走向接纳。",
  },
];

function fixture(t, story) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-narrative-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "canonical"));
  const manifest = { productionRoute: "tianshu-replication", scope: { kind: "full-series" }, sourceEpisodes: 1, episodes: 1, state: "approved" };
  const contract = createReplicationProductionContract();
  const input = `目标市场：美国。保留这部${story.genre}剧的具体人物互动与情绪。`;
  const records = {
    "source-creative.md": story.creative,
    "source-characters.md": story.characters,
    "source-outline.md": `## 第1集\n${story.event}`,
    "source-provenance.json": JSON.stringify({ sourceType: "textual-source", directVideoUnderstanding: false }),
    "design.md": story.design,
    "characters.md": story.characters,
    "outline.md": `## 第1集\n${story.event}`,
    "input.md": input,
    "episode-map.json": JSON.stringify([{ sourceEpisodes: [1], startEvent: "本段互动开始", endEvent: "本段回应结束", targetSeconds: 75 }]),
    "production-contract.json": JSON.stringify(contract),
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [name, value] of Object.entries(records)) fs.writeFileSync(path.join(dir, "canonical", name), value);
  return { dir, manifest, contract, input, records };
}

for (const story of cases) {
  test(`${story.genre} source interactions and approved design reach planning, writing, storyboarding and independent review unchanged`, (t) => {
    const { dir, contract, input, records } = fixture(t, story);
    const contexts = [
      replicationPlannerContext(dir),
      planningTaskPrompt(dir, contract, inferMarketIntent(input)),
      replicationWriterContext(dir, 1),
      storyboardSourceContext(dir, 1),
      planningPayload(dir),
      canonicalReviewContext(dir),
    ];
    for (const context of contexts) {
      for (const evidence of [story.creative, story.characters, story.event]) assert.ok(context.includes(evidence));
      assert.match(context, /参考数据/);
      assert.match(context, /未知/);
    }
    for (const context of contexts.slice(2)) assert.ok(context.includes(story.design));
    const planner = contexts[0];
    assert.match(planner, /谁在回应谁/);
    assert.match(planner, /互动前后的关系或情绪如何变化/);
    assert.match(planner, /不能按题材标签补造/);
    for (const context of contexts.slice(2, 4)) {
      assert.match(context, /不能仅凭“未推进事件”删除互动/);
      assert.match(context, /同一次连续发声跨镜/);
      assert.match(context, /不按字面相同批量去重/);
      assert.match(context, /无声口型、沉默或纯动作不附加同一角色有声台词/);
      assert.match(context, /身份、职衔或关系的改变须有已批准大纲中的事件依据/);
    }
    // Context construction must not rewrite the approved texts or their duration contract.
    for (const [name, value] of Object.entries(records)) assert.equal(fs.readFileSync(path.join(dir, "canonical", name), "utf8"), value);
  });
}

test("all review stages use evidence and local scope for narrative issues without imposing a new episode rejection rule", (t) => {
  const { manifest, contract } = fixture(t, cases[0]);
  for (const stage of ["planning", "screenplay", "storyboard"]) {
    const prompt = reviewPrompt(stage, "Frozen contract", manifest, contract);
    assert.match(prompt, /人物身份、职衔或关系变化是否由已批准大纲支持/);
    assert.match(prompt, /真实第二次发声、回忆或后续呼应/);
    assert.match(prompt, /明确无声动作与同一角色有声台词是否冲突/);
    assert.match(prompt, /scope 只覆盖必须修复的局部或相邻集/);
    assert.match(prompt, /缺少源证据时说明无法判断/);
    assert.match(prompt, /非阻断 P2 建议/);
    assert.match(prompt, /不要因单处台词或表演偏好拒绝整集/);
    assert.match(prompt, /目标 60–90 秒，常态 75 秒；硬范围 60–100 秒/);
    assert.match(prompt, /不通过加速口播、只缩数字或删核心戏压时长/);
  }
});
