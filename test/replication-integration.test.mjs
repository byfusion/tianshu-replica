import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { createRun, loadManifest, STORYBOARD_HEADER } from "../src/core.mjs";
import { planningSystemPrompt, planningTaskPrompt, screenplayChecks, storyboardChecks } from "../src/agents.mjs";
import { planningPayload } from "../src/semantic-review.mjs";
import { inferMarketIntent } from "../src/market.mjs";
import { productionContractMarkdown } from "../src/production-contract.mjs";
import { parseSourceOutline, readReplicationSource } from "../src/replication.mjs";
import { ROOT } from "../src/experiments/lib.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const fixture = path.join(repo, "fixtures", "replication-synthetic");
const source = fs.readFileSync(path.join(fixture, "source-outline.md"), "utf8");
const input = fs.readFileSync(path.join(fixture, "brief.txt"), "utf8");
const contract = JSON.parse(fs.readFileSync(path.join(fixture, "production-contract.json"), "utf8"));
function temporaryRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-replication-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("synthetic 60-episode outline survives init and reaches both planning and independent review", (t) => {
  const { dir } = createRun(temporaryRoot(t), { title: "离线合成大纲", episodes: 60, input, sourceOutline: source, productionContract: contract });
  assert.equal(loadManifest(dir).state, "draft");
  assert.equal(loadManifest(dir).productionRoute, "tianshu-replication");
  assert.equal(readReplicationSource(dir).markdown, source);
  const parsed = parseSourceOutline(source, 60);
  const planning = planningTaskPrompt(dir, contract, inferMarketIntent(input));
  const reviewing = planningPayload(dir);
  for (const item of parsed.episodes) {
    assert.ok(planning.includes(item.text), `Planner missing source EP${item.episode}`);
    assert.ok(reviewing.includes(item.text), `Reviewer missing source EP${item.episode}`);
  }
  assert.equal(planning.split(source).length - 1, 1);
  assert.equal(reviewing.split(source).length - 1, 1);
  assert.match(planning, /禁止自由重构情节/);
  assert.match(reviewing, /对照原始大纲/);
  const repair = planningTaskPrompt(dir, contract, inferMarketIntent(input), { findings: [{ evidence: "第2集尾钩被改写" }] });
  assert.ok(repair.includes(source));
  assert.match(repair, /第2集尾钩被改写/);
  assert.equal(fs.readdirSync(path.join(dir, "screenplay")).length, 0);
});

test("incomplete source fails before creating a run and the original route needs no source", (t) => {
  const root = temporaryRoot(t);
  assert.throws(() => createRun(root, { title: "缺集", episodes: 60, sourceTotalEpisodes: 60, input, sourceOutline: "## 第1集\n事件" }), /60/);
  assert.deepEqual(fs.readdirSync(root), []);
  const { dir, manifest } = createRun(root, { title: "原创", episodes: 30, input });
  assert.equal(manifest.productionRoute, "tianshu-original");
  assert.equal(readReplicationSource(dir), null);
  assert.doesNotMatch(planningTaskPrompt(dir, contract, inferMarketIntent(input)), /原始大纲参考数据/);
  assert.match(planningSystemPrompt(manifest), /Create a strong 30-episode/);
  assert.match(planningSystemPrompt(manifest), /active heroine/);
});

test("source protagonist and legitimate source plot devices are retained without relaxing structural checks", () => {
  assert.match(source, /监控回放/);
  const prompt = planningSystemPrompt({ episodes: 60, productionRoute: "tianshu-replication" });
  assert.match(prompt, /Preserve the source protagonist/);
  assert.doesNotMatch(prompt, /active heroine|no police\/court\/DNA\/surveillance shortcuts/);
  const markdown = `第2集\n监控回放显示母亲把坏校准仪交给周舟送修。\n${"动作推动既有冲突。".repeat(90)}\n林夏（中）：这是她交给你的。\n林夏（EN）：She gave this to you.\n【本集钩子】\n周舟拿着未结清的旧工时单站在门口。\n【连续性检查】\n林夏已拿回工具柜，周舟带回修好的校准仪。`;
  const original = screenplayChecks(markdown, 2, { anchors: [], bannedContext: [] }, [], contract);
  assert.ok(original.includes("禁止把监控或录像作为剧情证据"));
  assert.deepEqual(screenplayChecks(markdown, 2, { anchors: [], bannedContext: [] }, [], contract, "tianshu-replication"), []);
  assert.ok(screenplayChecks("第2集\n监控回放", 2, { anchors: [], bannedContext: [] }, [], contract, "tianshu-replication").includes("剧本过短"));
});

test("custom source contract does not describe an unspecified audience as female", () => {
  const rendered = productionContractMarkdown(contract);
  assert.match(rendered, /受众未指定/);
  assert.match(rendered, /60–75 秒/);
  assert.doesNotMatch(rendered, /女频/);
});

test("source plot devices survive storyboard and delivery checks while malformed boards still fail", () => {
  const rows = Array.from({ length: 12 }, (_, i) => `| ep02-s${String(i + 1).padStart(2, "0")} | 监控回放显示母亲把校准仪交给周舟 | 无台词 | 固定 / 特写 | 场景：修理店 | 音效：播放键声 | 5 |`);
  const board = `| ${STORYBOARD_HEADER.join(" | ")} |\n| ${STORYBOARD_HEADER.map(() => "---").join(" | ")} |\n${rows.join("\n")}`;
  const market = { anchors: [], bannedContext: [] };
  assert.ok(storyboardChecks(board, market, [], contract).includes("禁止把监控或录像作为剧情证据"));
  assert.deepEqual(storyboardChecks(board, market, [], contract, "tianshu-replication"), []);
  assert.ok(storyboardChecks(board.replace("中英双语台词", "缺失列"), market, [], contract, "tianshu-replication").includes("missing exact 7-column header"));
});

test("Pi runtime resolves the actual workspace when its path contains spaces and Chinese", () => {
  assert.equal(ROOT, repo);
  assert.ok(fs.existsSync(path.join(ROOT, "package.json")));
});

test("CLI imports the synthetic outline offline, reports unknown usage, and stops an unapproved run", (t) => {
  const cli = path.join(repo, "bin", "tianshu.mjs");
  const result = JSON.parse(execFileSync(process.execPath, [cli, "init", path.join(fixture, "brief.txt"), "--title", "离线CLI验证", "--episodes", "60", "--source-outline", path.join(fixture, "source-outline.md"), "--contract", path.join(fixture, "production-contract.json")], { encoding: "utf8", timeout: 30_000 }));
  const dir = path.join(repo, "runs", result.id);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(result.productionRoute, "tianshu-replication");
  assert.equal(fs.readFileSync(path.join(dir, "canonical", "source-outline.md"), "utf8"), source);
  const metrics = JSON.parse(execFileSync(process.execPath, [cli, "metrics", result.id], { encoding: "utf8", timeout: 30_000 }));
  assert.equal(metrics.attemptCount, 0);
  assert.equal(metrics.usageTotal.totalTokens, null);
  const run = spawnSync(process.execPath, [cli, "run", result.id], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /draft/);
  assert.equal(loadManifest(dir).state, "draft");
  assert.equal(fs.readdirSync(path.join(dir, "metrics")).length, 0);
});
