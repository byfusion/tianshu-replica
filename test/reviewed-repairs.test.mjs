import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyReviewedRepairs, assertReviewedRepairSources, loadReviewedRepairs, registerReviewedRepairs } from "../src/reviewed-repairs.mjs";

const row = (shot, visual, dialogue = "中：你好<br>EN: Hello") => `| ${shot} | ${visual} | ${dialogue} | 固定 | 人物：A | 连续性：接前镜 | 4 |`;
const markdown = `# 第 1 集｜测试\n\n${row("ep01-s01", "孩子在摇篮中")}\n${row("ep01-s02", "随后睡着")}\n`;
const repair = () => ({
  changes: [{ shot: "ep01-s01", column: 2, old: "孩子在摇篮中", new: "孩子在兄长臂弯中", findings: ["position"] }],
  decisions: { position: { decision: "accept", reason: "相邻镜位置明确" } },
  pendingSourceFindingIds: ["unconfirmed-speaker"],
});

test("no reviewed repair record preserves the exact original output", () => {
  assert.deepEqual(applyReviewedRepairs(markdown, null), { markdown, appliedCells: 0, affectedEpisodes: [], pendingSourceFindingIds: [] });
});

test("approved cell replacement preserves all other text and is repeatable from the source", () => {
  const record = repair();
  const output = applyReviewedRepairs(markdown, record);
  assert.equal(output.markdown, markdown.replace("孩子在摇篮中", "孩子在兄长臂弯中"));
  assert.equal(output.appliedCells, 1);
  assert.deepEqual(output.affectedEpisodes, [1]);
  assert.deepEqual(output.pendingSourceFindingIds, ["unconfirmed-speaker"]);
  assert.deepEqual(applyReviewedRepairs(markdown, record), output);
  assert.throws(() => applyReviewedRepairs(output.markdown, record), /ep01-s01 column 2: old text no longer matches/);
});

test("multiline repairs retain row whitespace and accepted visual formatting provenance", () => {
  const change = { shot: "ep01-s01", column: 3, old: "中：你好\nEN: Hello", new: "中：你好\nEN: Hello.\n表演：低声", findings: ["QA-line-break"] };
  const result = applyReviewedRepairs(markdown, { changes: [change], decisions: {}, postVisualCorrections: [change] });
  assert.equal(result.markdown, markdown.replace("中：你好<br>EN: Hello", "中：你好<br>EN: Hello.<br>表演：低声"));
});

test("export conflicts identify changed, missing, duplicated and malformed target rows", () => {
  assert.throws(() => applyReviewedRepairs(markdown.replace("孩子在摇篮中", "另一个位置"), repair()), /ep01-s01 column 2: old text no longer matches/);
  assert.throws(() => applyReviewedRepairs(markdown.replace("ep01-s01", "ep01-s03"), repair()), /ep01-s01 column 2: missing target row/);
  assert.throws(() => applyReviewedRepairs(markdown + row("ep01-s01", "重复"), repair()), /ep01-s01: duplicate row/);
  assert.throws(() => applyReviewedRepairs(markdown.replace("| 固定 |", "| 多余 | 固定 |"), repair()), /ep01-s01: malformed seven-column row/);
});

test("duplicate targets and first-column changes cannot silently reapply or renumber repairs", () => {
  const duplicate = repair(); duplicate.changes.push({ ...duplicate.changes[0] });
  assert.throws(() => applyReviewedRepairs(markdown, duplicate), /ep01-s01 column 2: duplicate target/);
  const firstColumn = repair(); firstColumn.changes[0].column = 1;
  assert.throws(() => applyReviewedRepairs(markdown, firstColumn), /editable columns are 2–7/);
});

test("pending source and rejected findings cannot become applied editorial changes", () => {
  const pending = repair(); pending.changes[0].findings = ["unconfirmed-speaker"];
  assert.throws(() => applyReviewedRepairs(markdown, pending), /still needs source confirmation/);
  const rejected = repair(); rejected.decisions.position.decision = "reject";
  assert.throws(() => applyReviewedRepairs(markdown, rejected), /finding position was rejected/);
});

test("EP10 final-position diffs are applied once without executing structural provenance again", () => {
  const input = `${row("ep10-s15", "反应")}\n${row("ep10-s16", "命令")}\n`;
  const record = {
    changes: [
      { shot: "ep10-s15", column: 2, old: "反应", new: "命令", sourceShotBeforeRenumber: "ep10-s16" },
      { shot: "ep10-s16", column: 2, old: "命令", new: "反应", sourceShotBeforeRenumber: "ep10-s15" },
    ],
    structuralRevision: { new_order: ["ep10-s16", "ep10-s15"], order_semantics: "原 ID 序列" },
  };
  assert.equal(applyReviewedRepairs(input, record).markdown, `${row("ep10-s15", "命令")}\n${row("ep10-s16", "反应")}\n`);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-reviewed-repairs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const kind of ["storyboard", "screenplay"]) {
    fs.mkdirSync(path.join(dir, kind));
    fs.writeFileSync(path.join(dir, kind, "ep-01.md"), kind === "storyboard" ? markdown : "已审核剧本\n前场：由兄长抱着孩子\n");
    fs.writeFileSync(path.join(dir, kind, "ep-02.md"), "未受修订的第二集\n");
  }
  const input = { ...repair(), acceptedAt: "2026-09-12T09:54:03Z", structuralRevision: { decision: "保留镜头顺序" } };
  const inputPath = path.join(dir, "editorial-review.json");
  fs.writeFileSync(inputPath, JSON.stringify(input));
  return { dir, input, inputPath };
}

test("registration captures only affected source episodes and retains independent review provenance", (t) => {
  const { dir, input, inputPath } = fixture(t);
  assert.equal(loadReviewedRepairs(dir), null);
  const result = registerReviewedRepairs(dir, inputPath, { baseMarkdown: markdown, sourceRunId: "run-test" });
  const record = loadReviewedRepairs(dir);
  assert.deepEqual(record, result.record);
  assert.equal(record.sourceRunId, "run-test");
  assert.equal(record.provenance.correctionRecord, inputPath);
  assert.equal(record.acceptedAt, input.acceptedAt);
  assert.deepEqual(record.decisions, input.decisions);
  assert.deepEqual(record.structuralRevision, input.structuralRevision);
  assert.deepEqual(record.sourceSnapshots.map((item) => item.episode), [1]);
  assertReviewedRepairSources(dir, record);
  fs.writeFileSync(path.join(dir, "screenplay", "ep-02.md"), "第二集改变不影响本补丁\n");
  assertReviewedRepairSources(dir, record);
});

test("source context changes invalidate editorial export even while the target old cell is unchanged", (t) => {
  const { dir, inputPath } = fixture(t);
  const { record } = registerReviewedRepairs(dir, inputPath, { baseMarkdown: markdown, sourceRunId: "run-test" });
  const boardPath = path.join(dir, "storyboard", "ep-01.md");
  fs.writeFileSync(boardPath, markdown.replace("随后睡着", "突然被抱走"));
  assert.equal(applyReviewedRepairs(fs.readFileSync(boardPath, "utf8"), record).appliedCells, 1);
  assert.throws(() => assertReviewedRepairSources(dir, record), /episode 1: storyboard source changed/);
  fs.writeFileSync(boardPath, markdown);
  fs.appendFileSync(path.join(dir, "screenplay", "ep-01.md"), "新的剧情上下文\n");
  assert.throws(() => assertReviewedRepairSources(dir, record), /episode 1: screenplay source changed/);
  assert.equal(fs.readFileSync(boardPath, "utf8"), markdown);
});

test("conflicted registration leaves the existing repair record untouched", (t) => {
  const { dir, inputPath } = fixture(t);
  registerReviewedRepairs(dir, inputPath, { baseMarkdown: markdown, sourceRunId: "run-test" });
  const before = fs.readFileSync(path.join(dir, "reviewed-repairs.json"), "utf8");
  assert.throws(() => registerReviewedRepairs(dir, inputPath, { baseMarkdown: markdown.replace("孩子在摇篮中", "改过的位置"), sourceRunId: "run-test" }), /old text no longer matches/);
  assert.equal(fs.readFileSync(path.join(dir, "reviewed-repairs.json"), "utf8"), before);
});
