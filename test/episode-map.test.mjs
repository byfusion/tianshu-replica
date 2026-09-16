import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { episodeMapContext, isResegmentedReplication, loadEpisodeMap, validateEpisodeMap } from "../src/episode-map.mjs";
import { parseSourceOutline, readReplicationSource, replicationPlannerContext, replicationReviewContext, replicationWriterContext } from "../src/replication.mjs";
import { normalizeSourceMaterials } from "../src/source-materials.mjs";
import { createProductionContract } from "../src/production-contract.mjs";

const entry = (sourceEpisodes, startEvent = "发现问题", endEvent = "作出决定", targetSeconds = 90) => ({ sourceEpisodes, startEvent, endEvent, targetSeconds });
const options = { sourceEpisodes: 4, outputEpisodes: 5, episodeDurationSeconds: { min: 60, max: 120 } };
const splitAndMerge = () => [entry([1]), entry([1]), entry([2, 3]), entry([3]), entry([4])];
const pacedContract = () => createProductionContract({
  screenplay: { episodeDurationSeconds: { min: 60, max: 100 } },
  storyboard: { episodeDurationSeconds: { min: 60, max: 100 } },
  pacing: { targetDurationSeconds: { min: 60, max: 90 }, preferredDurationSeconds: 75 },
});

function makeRun(t, manifest, map) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-episode-map-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "canonical"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  const sourceCount = manifest.sourceEpisodes ?? manifest.episodes;
  const outline = Array.from({ length: sourceCount }, (_, i) => `## 第${i + 1}集\n源事件${i + 1}开始，源事件${i + 1}结束。`).join("\n\n");
  fs.writeFileSync(path.join(dir, "canonical", "source-outline.md"), outline);
  fs.writeFileSync(path.join(dir, "canonical", "design.md"), "保留人物关系与未知身份，允许自然分集。");
  if (map !== undefined) fs.writeFileSync(path.join(dir, "canonical", "episode-map.json"), JSON.stringify(map));
  return { dir, outline };
}

test("episode map supports splitting a source and merging adjacent sources without requiring literal event matches", () => {
  const map = splitAndMerge();
  map[0].startEvent = "起点说明由Planner判断，源材料可使用不同措辞";
  assert.deepEqual(validateEpisodeMap(map, options), []);
  assert.deepEqual(validateEpisodeMap([entry([1], "起", "止", 60), entry([1], "续", "终", 120)], { sourceEpisodes: 1, outputEpisodes: 2 }), []);
});

test("episode map rejects uncovered, invalid, repeated, non-adjacent, and backwards source references", () => {
  const cases = [
    { map: [entry([1]), entry([1])], config: { sourceEpisodes: 2, outputEpisodes: 2 }, pattern: /cover all source episodes/ },
    { map: [entry([0]), entry([1, 2])], config: { sourceEpisodes: 2, outputEpisodes: 2 }, pattern: /invalid source episode 0/ },
    { map: [entry([1, 1])], config: { sourceEpisodes: 1, outputEpisodes: 1 }, pattern: /consecutive and non-repeating/ },
    { map: [entry([1, 3])], config: { sourceEpisodes: 3, outputEpisodes: 1 }, pattern: /consecutive and non-repeating/ },
    { map: [entry([1, 2]), entry([1])], config: { sourceEpisodes: 2, outputEpisodes: 2 }, pattern: /backwards/ },
    { map: [entry([1, "2"])], config: { sourceEpisodes: 2, outputEpisodes: 1 }, pattern: /invalid source episode 2/ },
  ];
  for (const { map, config, pattern } of cases) assert.match(validateEpisodeMap(map, config).join("; "), pattern);
});

test("episode map validates output count, meaningful boundary fields, and integer duration budgets", () => {
  assert.match(validateEpisodeMap({}, options).join("; "), /must be an array/);
  assert.match(validateEpisodeMap([], options).join("; "), /contain 5 output episodes/);
  assert.match(validateEpisodeMap([null], { sourceEpisodes: 1, outputEpisodes: 1 }).join("; "), /must be an object/);
  for (const field of ["startEvent", "endEvent"]) {
    assert.match(validateEpisodeMap([{ ...entry([1]), [field]: " " }], { sourceEpisodes: 1, outputEpisodes: 1 }).join("; "), new RegExp(field));
  }
  for (const duration of [59, 121, 90.5, "90"]) {
    assert.match(validateEpisodeMap([entry([1], "起", "止", duration)], { sourceEpisodes: 1, outputEpisodes: 1 }).join("; "), /integer from 60 to 120/);
  }
  assert.match(validateEpisodeMap([entry([1], "起", "止", 80)], { sourceEpisodes: 1, outputEpisodes: 1, episodeDurationSeconds: { min: 90, max: 100 } }).join("; "), /production contract range/);
});

test("a planned target must fit both the preferred target range and the hard duration range", () => {
  const config = { sourceEpisodes: 1, outputEpisodes: 1, episodeDurationSeconds: { min: 60, max: 100 }, targetDurationSeconds: { min: 60, max: 90 } };
  assert.deepEqual(validateEpisodeMap([entry([1], "起", "止", 90)], config), []);
  assert.match(validateEpisodeMap([entry([1], "起", "止", 95)], config).join("; "), /planning target range 60–90/);
  assert.match(validateEpisodeMap([entry([1], "起", "止", 101)], config).join("; "), /production contract range 60–100/);
});

test("saved pacing policy controls map validation and every replication context", (t) => {
  const { dir } = makeRun(t, { productionRoute: "tianshu-replication", sourceEpisodes: 1, episodes: 1 }, [entry([1])]);
  fs.writeFileSync(path.join(dir, "canonical", "production-contract.json"), JSON.stringify(pacedContract()));
  assert.equal(loadEpisodeMap(dir)[0].targetSeconds, 90);
  for (const context of [replicationPlannerContext(dir), replicationReviewContext(dir), replicationWriterContext(dir, 1)]) {
    assert.match(context, /规划目标60–90秒，通常75秒/);
    assert.match(context, /硬范围60–100秒/);
    assert.doesNotMatch(context, /60–120秒/);
  }
  fs.writeFileSync(path.join(dir, "canonical", "episode-map.json"), JSON.stringify([entry([1], "起", "止", 95)]));
  assert.throws(() => loadEpisodeMap(dir, { required: false }), /planning target range 60–90/);
});

test("a frozen contract without pacing still accepts its original 120-second plan without being rewritten", (t) => {
  const { dir } = makeRun(t, { productionRoute: "tianshu-replication", sourceEpisodes: 1, episodes: 1 }, [entry([1], "起", "止", 120)]);
  const contract = createProductionContract({
    screenplay: { episodeDurationSeconds: { min: 60, max: 120 } },
    storyboard: { episodeDurationSeconds: { min: 60, max: 120 } },
  });
  delete contract.pacing;
  const file = path.join(dir, "canonical", "production-contract.json"), frozen = JSON.stringify(contract);
  fs.writeFileSync(file, frozen);
  assert.equal(loadEpisodeMap(dir)[0].targetSeconds, 120);
  for (const context of [replicationPlannerContext(dir), replicationReviewContext(dir), replicationWriterContext(dir, 1)]) {
    assert.match(context, /规划目标60–120秒/);
    assert.match(context, /硬范围60–120秒/);
    assert.doesNotMatch(context, /通常75秒|60–90秒/);
  }
  assert.equal(fs.readFileSync(file, "utf8"), frozen);
});

test("source count inference preserves ordered nonempty episodes and unmodified source materials", () => {
  const outline = "# 原作\n\n第1集\n发现针。\n\n第2集\n拿出物证。";
  assert.deepEqual(parseSourceOutline(outline).episodes.map((item) => item.episode), [1, 2]);
  assert.throws(() => parseSourceOutline("无分集正文"), /没有可识别/);
  assert.throws(() => parseSourceOutline("第1集\n\n第2集\n事件"), /正文为空/);
  assert.throws(() => parseSourceOutline("第2集\n事件"), /连续有序/);
  assert.throws(() => parseSourceOutline(outline, 3), /实际识别 2 集/);
  const materials = { creative: "原始创意", characters: "身份未知，不改成已确认。", outline, provenance: { evidenceType: "synthetic-text" } };
  assert.deepEqual(normalizeSourceMaterials(materials), materials);
  assert.throws(() => normalizeSourceMaterials(materials, 3), /实际识别 2 集/);
});

test("legacy, original and sample runs do not acquire a resegmentation requirement", (t) => {
  for (const manifest of [
    { productionRoute: "tianshu-original", episodes: 3 },
    { productionRoute: "tianshu-replication", episodes: 3 },
    { productionRoute: "tianshu-replication", episodes: 3, sourceEpisodes: 3, scope: { kind: "sample" } },
  ]) {
    const { dir } = makeRun(t, manifest);
    assert.equal(isResegmentedReplication(manifest), false);
    assert.equal(loadEpisodeMap(dir), null);
    assert.equal(episodeMapContext(dir, 1), "");
    if (manifest.productionRoute === "tianshu-replication") {
      assert.match(replicationPlannerContext(dir), /不合并、拆分、调序/);
      const writer = replicationWriterContext(dir, 2);
      assert.match(writer, /源事件2开始/);
      assert.doesNotMatch(writer, /源事件3开始/);
    }
  }
});

test("new planning may begin without a map, while writing requires the map", (t) => {
  const manifest = { productionRoute: "tianshu-replication", sourceEpisodes: 2, episodes: 3, scope: { kind: "full-series" } };
  const { dir } = makeRun(t, manifest);
  assert.equal(isResegmentedReplication(manifest), true);
  assert.equal(readReplicationSource(dir).episodes.length, 2);
  assert.equal(loadEpisodeMap(dir, { required: false }), null);
  assert.throws(() => loadEpisodeMap(dir), /requires canonical\/episode-map.json/);
  assert.throws(() => replicationWriterContext(dir, 1), /requires canonical\/episode-map.json/);
  const planner = replicationPlannerContext(dir);
  assert.match(planner, /源材料：2 集；输出规划：3 集/);
  assert.match(planner, /当前尚无已保存分集映射/);
  assert.match(planner, /允许按自然冲突/);
  assert.doesNotMatch(planner, /不合并、拆分、调序/);
});

test("32 source episodes can supply 54 outputs, including output 33 and final output without source-index overflow", (t) => {
  const map = Array.from({ length: 32 }, (_, i) => {
    const source = i + 1;
    return source <= 22
      ? [entry([source], `源${source}前段起`, `源${source}中间决定`), entry([source], `源${source}后段起`, `源${source}结束`)]
      : [entry([source], `源${source}开始`, `源${source}结束`)];
  }).flat();
  const { dir, outline } = makeRun(t, { productionRoute: "tianshu-replication", sourceEpisodes: 32, episodes: 54 }, map);
  fs.writeFileSync(path.join(dir, "canonical", "production-contract.json"), JSON.stringify(pacedContract()));
  fs.writeFileSync(path.join(dir, "canonical", "source-creative.md"), "创意内容");
  fs.writeFileSync(path.join(dir, "canonical", "source-characters.md"), "人物身份与关系未知项");
  fs.writeFileSync(path.join(dir, "canonical", "source-provenance.json"), JSON.stringify({ evidenceType: "synthetic-text" }));
  assert.equal(readReplicationSource(dir).markdown, outline);
  assert.deepEqual(loadEpisodeMap(dir), map);
  const writer33 = replicationWriterContext(dir, 33);
  assert.match(writer33, /本输出集 33/);
  assert.match(writer33, /源事件17开始/);
  assert.doesNotMatch(writer33, /源事件18开始/);
  assert.match(writer33, /上一输出集 32/);
  assert.match(writer33, /下一输出集 34/);
  assert.match(writer33, /不复述上一段已完成的事件/);
  assert.match(writer33, /本输出集预算：90 秒/);
  assert.match(replicationWriterContext(dir, 54), /源事件32开始/);
  assert.throws(() => replicationWriterContext(dir, 55), /invalid output episode 55/);
  const writer2 = replicationWriterContext(dir, 2);
  assert.match(writer2, /从“源1后段起”推进到“源1结束”/);
  assert.match(writer2, /源事件1开始/);
  assert.doesNotMatch(writer2, /源事件2开始/);
  for (const context of [replicationPlannerContext(dir), replicationReviewContext(dir)]) {
    assert.match(context, /源材料：32 集；输出规划：54 集/);
    assert.ok(context.includes(JSON.stringify(map, null, 2)));
    assert.ok(context.includes(outline));
    assert.match(context, /身份和关系|身份、关系/);
  }
});

test("saved maps are checked even during planning, including the actual production contract range", (t) => {
  const { dir } = makeRun(t, { productionRoute: "tianshu-replication", sourceEpisodes: 1, episodes: 1 }, [entry([1], "起", "止", 80)]);
  const contract = createProductionContract({ storyboard: { episodeDurationSeconds: { min: 90, max: 100 } } });
  fs.writeFileSync(path.join(dir, "canonical", "production-contract.json"), JSON.stringify(contract));
  assert.throws(() => loadEpisodeMap(dir, { required: false }), /production contract range/);
  fs.writeFileSync(path.join(dir, "canonical", "episode-map.json"), JSON.stringify([entry([2])]));
  assert.throws(() => loadEpisodeMap(dir), /invalid source episode 2/);
});

test("interrupted planning can read a complete candidate map before its output count reaches the manifest", (t) => {
  const map = [entry([1], "发现问题", "决定调查"), entry([1], "继续调查", "揭开答案")];
  const { dir } = makeRun(t, { state: "planning", productionRoute: "tianshu-replication", sourceEpisodes: 1, episodes: 1 }, map);
  fs.writeFileSync(path.join(dir, "canonical", "production-contract.json"), JSON.stringify(pacedContract()));
  assert.deepEqual(loadEpisodeMap(dir, { required: false }), map);
  const context = replicationPlannerContext(dir);
  assert.match(context, /输出规划：2 集/);
  assert.match(context, /规划候选.*manifest参考集数：1/);
  assert.throws(() => loadEpisodeMap(dir), /contain 1 output episodes; found 2/);
  fs.writeFileSync(path.join(dir, "canonical", "episode-map.json"), JSON.stringify([entry([2]), entry([2])]));
  assert.throws(() => loadEpisodeMap(dir, { required: false }), /invalid source episode 2/);
});

test("candidate count recovery remains unavailable after approval or when screenplay output already exists", (t) => {
  const map = [entry([1]), entry([1])];
  const approved = makeRun(t, { state: "approved", productionRoute: "tianshu-replication", sourceEpisodes: 1, episodes: 1 }, map);
  assert.throws(() => loadEpisodeMap(approved.dir, { required: false }), /contain 1 output episodes; found 2/);
  const produced = makeRun(t, { state: "planning", productionRoute: "tianshu-replication", sourceEpisodes: 1, episodes: 1 }, map);
  fs.mkdirSync(path.join(produced.dir, "screenplay"));
  fs.writeFileSync(path.join(produced.dir, "screenplay", "ep-01.md"), "已有正式剧本，不改写。");
  assert.throws(() => loadEpisodeMap(produced.dir, { required: false }), /contain 1 output episodes; found 2/);
  assert.equal(fs.readFileSync(path.join(produced.dir, "screenplay", "ep-01.md"), "utf8"), "已有正式剧本，不改写。");
});
