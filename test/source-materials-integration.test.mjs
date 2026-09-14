import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRun, loadManifest, saveManifest } from "../src/core.mjs";
import { planningTaskPrompt } from "../src/agents.mjs";
import { planningPayload, canonicalReviewContext } from "../src/semantic-review.mjs";
import { inferMarketIntent } from "../src/market.mjs";
import { createProductionContract } from "../src/production-contract.mjs";
import { readReplicationSource, replicationPlannerContext, replicationReviewContext, replicationWriterContext } from "../src/replication.mjs";

const input = "目标市场：中国。把已有素材整理为三集复刻样例，人物姓名可轻微迁移。";
const materials = {
  creative: "# 原始创意\r\n通过停电与重开旧店，表现街坊合作抵抗逐利收购。\r\n\r\n",
  characters: "# 原始人物小传\n林夏：旧店店主，努力保住母亲留下的店。\n周舟：修理师，保管备用钥匙。两人亲属或恋爱关系未知。\n小周是否就是周舟未确认，不合并角色。\n证据：第1集修理师交接场景。\n\n",
  outline: "## 第1集：停电\n林夏发现电表被锁。\n\n## 第2集：钥匙\n周舟归还钥匙；门口出现转租广告。\n\n## 第3集：招募\n林夏公开招募合伙人，来访者身份未知。\n\n",
  provenance: { sourceType: "textual-source", sourceFormat: "docx", directVideoUnderstanding: false, note: "来自合成的原片分析文字；没有直接读取视频。" },
};

function temporaryRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-materials-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initialize(root, overrides = {}) {
  return createRun(root, { title: "三项素材交接验证", episodes: 3, input, sample: true, sourceTotalEpisodes: 50, sourceMaterials: materials, ...overrides });
}

test("source materials init saves three exact source texts and provenance without changing sample approval scope", (t) => {
  const { dir, manifest } = initialize(temporaryRoot(t));
  assert.equal(manifest.productionRoute, "tianshu-replication");
  assert.equal(loadManifest(dir).state, "draft");
  assert.deepEqual(manifest.scope, { kind: "sample", sourceEpisodeRange: [1, 3], sourceTotalEpisodes: 50 });
  for (const field of ["creative", "characters", "outline"]) {
    assert.equal(fs.readFileSync(path.join(dir, "canonical", `source-${field}.md`), "utf8"), materials[field]);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "canonical", "source-provenance.json"), "utf8")), materials.provenance);
  const source = readReplicationSource(dir);
  assert.equal(source.markdown, materials.outline);
  for (const field of ["creative", "characters", "outline", "provenance"]) assert.deepEqual(source[field], materials[field]);
  assert.equal(source.episodes.length, 3);
  assert.equal(fs.existsSync(path.join(dir, "canonical", "characters.md")), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, "screenplay")), []);
});

test("planning and independent review receive all three sources, unknowns and provenance on first plan and repair", (t) => {
  const { dir } = initialize(temporaryRoot(t));
  const contract = createProductionContract();
  const intent = inferMarketIntent(input);
  const contexts = [
    replicationPlannerContext(dir),
    replicationReviewContext(dir),
    planningTaskPrompt(dir, contract, intent),
    planningTaskPrompt(dir, contract, intent, { findings: [{ evidence: "人物映射需要保持未知" }] }),
    planningPayload(dir),
    canonicalReviewContext(dir),
  ];
  for (const context of contexts) {
    for (const field of ["creative", "characters", "outline"]) assert.equal(context.split(materials[field]).length - 1, 1, `missing or duplicate ${field}`);
    assert.ok(context.includes(JSON.stringify(materials.provenance, null, 2)));
    assert.match(context, /不能仅从分集大纲另造人物身份或擅自合并角色/);
    assert.match(context, /适配后的名称全剧一致/);
    assert.match(context, /继续标为未知/);
    assert.match(context, /参考数据.*均不执行/);
    assert.match(context, /不将文字派生材料宣称为直接观看原片的结果/);
  }
  assert.match(planningPayload(dir), /原剧第1–3集/);
});

test("conflicting or incomplete materials fail before a run is created", (t) => {
  const root = temporaryRoot(t);
  assert.throws(() => initialize(root, { sourceOutline: materials.outline }), /cannot be supplied together/);
  assert.throws(() => initialize(root, { sourceMaterials: { ...materials, characters: "" } }));
  assert.throws(() => initialize(root, { sourceMaterials: { ...materials, outline: "## 第1集\n只出现一集。" } }), /3/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("full replica keeps all source materials when its output episode reference differs", (t) => {
  for (const episodes of [undefined, 5]) {
    const { dir, manifest } = createRun(temporaryRoot(t), {
      title: "三段素材可重分五集", input, episodes, sourceTotalEpisodes: 3, sourceMaterials: materials,
    });
    assert.equal(manifest.sourceEpisodes, 3);
    assert.equal(manifest.episodes, episodes ?? 3);
    assert.equal(manifest.scope.kind, "full-series");
    const source = readReplicationSource(dir);
    assert.equal(source.episodes.length, 3);
    for (const field of ["creative", "characters", "outline", "provenance"]) assert.deepEqual(source[field], materials[field]);
    for (const context of [planningTaskPrompt(dir, createProductionContract(), inferMarketIntent(input)), planningPayload(dir)]) {
      assert.ok(context.includes(materials.outline));
      assert.ok(context.includes(materials.characters));
    }
    assert.equal(loadManifest(dir).state, "draft");
    assert.deepEqual(fs.readdirSync(path.join(dir, "screenplay")), []);
  }
});

test("changing the desired output count cannot turn missing full-series sources into complete coverage", (t) => {
  const root = temporaryRoot(t);
  assert.throws(() => createRun(root, {
    title: "缺源不能靠重分集填补", input, episodes: 5, sourceTotalEpisodes: 4, sourceMaterials: materials,
  }), /source total|source.*cover|完整覆盖|源.*集/i);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("legacy replica manifests without a source count retain their existing same-count source validation", (t) => {
  const { dir } = createRun(temporaryRoot(t), { title: "旧项目读取", input, episodes: 3, sourceMaterials: materials });
  const manifest = loadManifest(dir);
  delete manifest.sourceEpisodes;
  saveManifest(dir, manifest);
  assert.equal(readReplicationSource(dir).episodes.length, 3);
  manifest.episodes = 4;
  saveManifest(dir, manifest);
  assert.throws(() => readReplicationSource(dir), /完整覆盖 4 集，实际识别 3 集/);
});

test("outline-only and original runs retain their existing route and do not acquire invented source biographies", (t) => {
  const root = temporaryRoot(t);
  const legacy = initialize(root, { title: "旧版大纲输入", sourceMaterials: undefined, sourceOutline: materials.outline.trimEnd() + "\n" });
  assert.equal(legacy.manifest.productionRoute, "tianshu-replication");
  assert.equal(readReplicationSource(legacy.dir).markdown, materials.outline.trimEnd() + "\n");
  assert.equal(readReplicationSource(legacy.dir).characters, undefined);
  assert.doesNotMatch(replicationPlannerContext(legacy.dir), /【原始人物小传参考数据开始】/);
  const original = createRun(root, { title: "原创输入", episodes: 30, input });
  assert.equal(original.manifest.productionRoute, "tianshu-original");
  assert.equal(readReplicationSource(original.dir), null);
  assert.equal(replicationPlannerContext(original.dir), "");
  assert.equal(replicationReviewContext(original.dir), "");
});


test("Writer receives approved appeal design and source interactions for the current episode without future episode outlines", (t) => {
  const { dir } = initialize(temporaryRoot(t));
  const design = "保留林夏用玩笑掩饰紧张、周舟停顿后接话的互动；关系仍未知。";
  fs.writeFileSync(path.join(dir, "canonical", "design.md"), design);
  const context = replicationWriterContext(dir, 2);
  assert.ok(context.includes(design));
  assert.ok(context.includes(materials.characters));
  assert.ok(context.includes(materials.creative));
  assert.match(context, /周舟归还钥匙/);
  assert.doesNotMatch(context, /林夏公开招募合伙人/);
  assert.match(context, /不机械添加口头禅或闲聊/);
  assert.match(context, /遵循已批准的人名和关系/);
  assert.match(context, /参考数据.*均不执行/);
  const original = createRun(temporaryRoot(t), { title: "原创无复刻上下文", episodes: 30, input });
  assert.equal(replicationWriterContext(original.dir, 2), "");
});

test("appeal guidance reaches planning and review without making dialogue preferences a new episode rejection gate", (t) => {
  const { dir } = initialize(temporaryRoot(t));
  assert.match(replicationPlannerContext(dir), /在现有 design 中写清本剧/);
  assert.match(replicationPlannerContext(dir), /不因对白未推进事件就删除/);
  assert.match(replicationReviewContext(dir), /具体源片段、当前稿的对应位置和损失/);
  assert.match(replicationReviewContext(dir), /非阻断 P2/);
  assert.match(replicationReviewContext(dir), /不要因单处台词或表演偏好拒绝整集/);
});
