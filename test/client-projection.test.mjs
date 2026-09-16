import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { markdownDelivery, renderDeliveryMarkdown, STORYBOARD_HEADER } from "../src/core.mjs";
import { deliveryTiming, withDeliveryTiming } from "../src/delivery-timing.mjs";
import { applyReviewedRepairs } from "../src/reviewed-repairs.mjs";

const row = (values) => `| ${values.join(" | ")} |`;
const dialogue = "CN：我说的是 GPT、PASS 和 REVISE。<br>EN: I said GPT, PASS and REVISE.<br>表演：低声说完，等女儿回应。";
const notes = "音效：风声<br>制作：药瓶保持琥珀色。GPT6复核：PASS。演员停顿后抬眼。<br>保留制作待核：已进入修复记录。<br>字符校订：REVISE。";
const shot = ["ep01-s01", "母亲停顿后拥抱女儿，握紧药瓶。", dialogue, "固定 / 中景", "人物：母女<br>道具：药瓶", notes, "6.25"];
const metadata = [
  "## 阅读说明\n\n本稿由 GPT6 复核，PASS，内部修复记录随任务保存。",
  "**复核说明：** DeepSeek 已完成独立审稿。",
  "> 排版说明：本稿按内部模板输出。",
  "字符校订：Kimi 已完成本轮校订。",
  "保留制作待核：REVISE，后续回写任务记录。",
];
const board = (note = notes) => [
  "# 第1集｜重逢", ...metadata, row(STORYBOARD_HEADER), row(STORYBOARD_HEADER.map(() => "---")), row([...shot.slice(0, 5), note, shot[6]]),
].join("\n\n");
const manifest = { title: "重逢", episodes: 1, scope: { kind: "full-series" } };
const unwanted = /阅读说明|复核说明|排版说明|字符校订|保留制作待核|内部修复记录|任务记录|GPT6复核/;
const outputRow = (markdown) => markdown.split("\n").find((line) => line.startsWith("| ep01-s01")).split("|").slice(1, -1).map((text) => text.trim());

function assertClientContent(markdown) {
  assert.doesNotMatch(markdown, unwanted);
  const cells = outputRow(markdown);
  assert.deepEqual(cells.slice(0, 5), shot.slice(0, 5));
  assert.match(cells[5], /药瓶保持琥珀色。/);
  assert.match(cells[5], /演员停顿后抬眼。/);
  assert.match(cells[5], /音效：风声/);
  assert.equal(cells[6], "6.25");
  assert.equal(deliveryTiming(markdown).totalSeconds, 6.25);
}

test("three text routes share a client projection that preserves dialogue and performance", () => {
  for (const model of ["kimi", "deepseek", "gpt"]) {
    const markdown = renderDeliveryMarkdown({ ...manifest, model }, [board()]);
    assertClientContent(markdown);
    assert.equal(renderDeliveryMarkdown(manifest, [markdown]), markdown);
  }
});

test("final export applies exact reviewed old cells before projection and recalculates timing", () => {
  const root = "/offline-client-projection", original = board(), source = "# 第1集｜重逢\n母女重逢。";
  const files = new Map([
    [`${root}/storyboard/ep-01.md`, original], [`${root}/screenplay/ep-01.md`, source],
    [`${root}/tasks/storyboard-ep-01.json`, JSON.stringify({ state: "passed", digest: original, contractDigest: "contract", sourceScreenplayDigest: source })],
  ]);
  let sourceChecks = 0;
  const repairs = { changes: [
    { shot: "ep01-s01", column: 6, old: notes.replaceAll("<br>", "\n"), new: "音效：风声\n制作：药瓶保持琥珀色。演员停顿后抬眼。\n复核说明：GPT6 PASS，已审修复记录。" },
    { shot: "ep01-s01", column: 7, old: "6.25", new: "7.5" },
  ] };
  const run = vm.runInNewContext(`(${markdownDelivery.toString()})`, {
    path, fs: { existsSync: (file) => files.has(file) }, loadManifest: () => manifest,
    loadProductionContract: () => ({ storyboard: { episodeDurationSeconds: { min: 1, max: 100 } } }),
    productionContractDigest: () => "contract", sha: (value) => value,
    taskPath: (dir, id) => path.join(dir, "tasks", `${id}.json`),
    readText: (file) => files.get(file), readJson: (file) => JSON.parse(files.get(file)),
    canonicalPersonNames: () => [], checkStoryboard: () => [],
    renderDeliveryMarkdown, withDeliveryTiming, deliveryTiming, applyReviewedRepairs,
    loadReviewedRepairs: () => repairs, assertReviewedRepairSources: () => { sourceChecks++; },
  });
  const registeredBase = run(root, { includeReviewedRepairs: false });
  assert.equal(outputRow(registeredBase)[5], notes);
  assert.equal(sourceChecks, 0);
  const final = run(root);
  assert.equal(sourceChecks, 1);
  assert.doesNotMatch(final, unwanted);
  assert.equal(outputRow(final)[2], dialogue);
  assert.equal(outputRow(final)[6], "7.5");
  assert.equal(deliveryTiming(final).totalSeconds, 7.5);
  assert.match(final, /镜头合计 7.5 秒/);
  assert.match(final, /预计 7.5 秒/);
  assert.match(outputRow(final)[5], /药瓶保持琥珀色。演员停顿后抬眼。/);
});

test("projected Markdown reaches DOCX XML without internal notes or dialogue loss", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-client-projection-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "delivery.md"), output = path.join(directory, "delivery.docx");
  const markdown = renderDeliveryMarkdown(manifest, [board()]);
  fs.writeFileSync(input, markdown);
  const python = process.env.TIANSHU_PYTHON || "python3";
  const renderer = fileURLToPath(new URL("../src/experiments/render_storyboard_docx.py", import.meta.url));
  execFileSync(python, [renderer, input, output, "重逢"], { encoding: "utf8" });
  const observed = JSON.parse(execFileSync(python, ["-c", `
import json, sys, zipfile
from xml.etree import ElementTree as ET
with zipfile.ZipFile(sys.argv[1]) as document:
    root = ET.fromstring(document.read("word/document.xml"))
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
paragraphs = ["".join(p.itertext()) for p in root.findall("./w:body/w:p", ns)]
rows = [["".join(cell.itertext()) for cell in row.findall("w:tc", ns)] for row in root.findall(".//w:tbl/w:tr", ns)]
print(json.dumps({"paragraphs": paragraphs, "rows": rows}, ensure_ascii=False))
`, output], { encoding: "utf8" }));
  assert.doesNotMatch(JSON.stringify(observed), unwanted);
  assert.match(observed.rows[1][1], /母亲停顿后拥抱女儿，握紧药瓶/);
  assert.match(observed.rows[1][2], /我说的是 GPT、PASS 和 REVISE/);
  assert.match(observed.rows[1][2], /低声说完，等女儿回应/);
  assert.match(observed.rows[1][5], /药瓶保持琥珀色/);
  assert.match(observed.rows[1][5], /演员停顿后抬眼/);
  assert.equal(observed.rows[1][6], "6.25");
  t.diagnostic(JSON.stringify(observed.rows[1]));
});
