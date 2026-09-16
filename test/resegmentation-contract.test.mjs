import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createProductionContract, createReplicationProductionContract, loadProductionContract } from "../src/production-contract.mjs";
import { checkStoryboard, createRun, markdownDelivery, renderDeliveryMarkdown, storyboardWarnings, STORYBOARD_HEADER } from "../src/core.mjs";
import { deliveryTiming, withDeliveryTiming } from "../src/delivery-timing.mjs";
import { applyReviewedRepairs } from "../src/reviewed-repairs.mjs";

test("new full replicas use short episodes and reject the former 330-second workaround before creating a run", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-short-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { title: "时长回归", sourceOutline: "## 第1集\n出示证物，守卫开始怀疑此前的口供。", input: "复刻完整剧情。" };
  const contract = createProductionContract({
    screenplay: { episodeDurationSeconds: { min: 70, max: 330 } },
    storyboard: { episodeDurationSeconds: { min: 70, max: 330 }, shotCount: { min: 12, max: 110 } },
  });
  assert.throws(() => createRun(root, { ...input, productionContract: contract }), /60–100.*split the source/);
  assert.equal(fs.existsSync(path.join(root, "runs")), false);
  const run = createRun(root, input);
  const actual = loadProductionContract(run.dir);
  assert.deepEqual(actual.screenplay.episodeDurationSeconds, { min: 60, max: 100 });
  assert.deepEqual(actual.storyboard.episodeDurationSeconds, { min: 60, max: 100 });
  assert.deepEqual(actual.storyboard.shotCount, { min: 8, max: 32 });
  assert.equal(run.manifest.sourceEpisodes, 1);
  assert.deepEqual(actual.pacing, { targetDurationSeconds: { min: 60, max: 90 }, preferredDurationSeconds: 75 });
  assert.deepEqual(createProductionContract().storyboard.episodeDurationSeconds, { min: 90, max: 100 });
});

test("storyboard budget and export use the same fractional seconds", () => {
  const contract = createReplicationProductionContract();
  const markdown = (duration) => [
    "# 第1集｜预算边界", `| ${STORYBOARD_HEADER.join(" | ")} |`, `| ${STORYBOARD_HEADER.map(() => "---").join(" | ")} |`,
    ...Array.from({ length: 13 }, (_, i) => `| ep01-s${String(i + 1).padStart(2, "0")} | 核对证物 | 无台词 | 固定 / 中景 | 人物：无 | 音效：脚步 | ${duration} |`),
  ].join("\n");
  assert.deepEqual(checkStoryboard(markdown("7.5s"), [], contract), []);
  assert.equal(deliveryTiming(markdown("7.5s")).totalSeconds, 97.5);
  assert.ok(checkStoryboard(markdown("7.75"), [], contract).some((error) => error === "total duration 100.75"));
  assert.equal(deliveryTiming(markdown("7.75")).totalSeconds, 100.75);
  assert.ok(checkStoryboard(markdown("9–10"), [], contract).some((error) => error.startsWith("invalid duration")));
});

test("formal export recalculates and enforces the budget after approved duration-cell corrections", () => {
  const root = "/offline-final-timing", contract = createReplicationProductionContract();
  const markdown = ["# 第1集｜预算边界", `| ${STORYBOARD_HEADER.join(" | ")} |`, `| ${STORYBOARD_HEADER.map(() => "---").join(" | ")} |`,
    ...Array.from({ length: 13 }, (_, i) => `| ep01-s${String(i + 1).padStart(2, "0")} | 核对证物 | 无台词 | 固定 / 中景 | 人物：无 | 音效：脚步 | 7.5 |`),
  ].join("\n");
  const source = "# 第1集｜预算边界\n完整已审定剧本。";
  const files = new Map([
    [`${root}/storyboard/ep-01.md`, markdown], [`${root}/screenplay/ep-01.md`, source],
    [`${root}/tasks/storyboard-ep-01.json`, JSON.stringify({ state: "passed", digest: markdown, contractDigest: "contract", sourceScreenplayDigest: source })],
  ]);
  let changes = [];
  const run = vm.runInNewContext(`(${markdownDelivery.toString()})`, {
    path, fs: { existsSync: (p) => files.has(p) },
    loadManifest: () => ({ episodes: 1, title: "预算边界" }),
    loadProductionContract: () => contract, productionContractDigest: () => "contract",
    taskPath: (dir, id) => path.join(dir, "tasks", `${id}.json`),
    readText: (p) => files.get(p), readJson: (p) => JSON.parse(files.get(p)),
    sha: (value) => value, canonicalPersonNames: () => [], checkStoryboard,
    renderDeliveryMarkdown, withDeliveryTiming, deliveryTiming, applyReviewedRepairs,
    loadReviewedRepairs: () => ({ changes }), assertReviewedRepairSources: () => {},
  });
  changes = [{ shot: "ep01-s01", column: 7, old: "7.5", new: "8" }];
  assert.match(run(root), /预计 98 秒/);
  changes = Array.from({ length: 4 }, (_, i) => ({ shot: `ep01-s${String(i + 1).padStart(2, "0")}`, column: 7, old: "7.5", new: "8.5" }));
  assert.throws(() => run(root), /total duration 101.5 after reviewed corrections/);
});


test("90 seconds is the target boundary while 100 is the separate acceptance boundary", () => {
  const contract = createReplicationProductionContract();
  const board = (seconds) => [
    "# 第1集｜自然收尾", `| ${STORYBOARD_HEADER.join(" | ")} |`, `| ${STORYBOARD_HEADER.map(() => "---").join(" | ")} |`,
    ...seconds.map((duration, i) => `| ep01-s${String(i + 1).padStart(2, "0")} | 双方交换证物并看向门口 | 无台词 | 固定 / 中景 | 人物：无 | 功能：情绪停留 | ${duration} |`),
  ].join("\n");
  const target = board([8,8,8,8,8,8,7,7,7,7,7,7]);
  assert.deepEqual(checkStoryboard(target, [], contract), []);
  assert.deepEqual(storyboardWarnings(target, contract), []);
  const margin = board([9,9,9,9,8,8,8,8,8,8,8,8]);
  assert.deepEqual(checkStoryboard(margin, [], contract), []);
  assert.ok(storyboardWarnings(margin, contract).some((warning) => /超过创作目标 60–90.*硬上限 100/.test(warning)));
  const over = board([9,9,9,9,9,8,8,8,8,8,8,8]);
  assert.ok(checkStoryboard(over, [], contract).some((error) => error === "total duration 101"));
  const frozen = createProductionContract({ screenplay: { episodeDurationSeconds: { min: 60, max: 120 } }, storyboard: { episodeDurationSeconds: { min: 60, max: 120 } } });
  assert.deepEqual(checkStoryboard(over, [], frozen), []);
  assert.deepEqual(storyboardWarnings(over, frozen), []);
});
