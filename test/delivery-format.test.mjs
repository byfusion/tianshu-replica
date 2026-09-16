import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderDeliveryMarkdown, STORYBOARD_HEADER } from "../src/core.mjs";
import { deliveryTiming, withDeliveryTiming } from "../src/delivery-timing.mjs";
import { applyReviewedRepairs } from "../src/reviewed-repairs.mjs";

const renderer = fileURLToPath(new URL("../src/experiments/render_storyboard_docx.py", import.meta.url));
const python = process.env.TIANSHU_PYTHON || "python3";
const row = (values) => `| ${values.join(" | ")} |`;

test("sample delivery keeps episode titles identical across Markdown and Word without treating the document preface as episode 1", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-delivery-format-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const episodeTitles = ["第 1 集｜针在背上", "第 2 集｜一天", "第 3 集｜一滴"];
  const expectedTitles = episodeTitles.map((title) => `${title}｜预计 5 秒`);
  const sourceHeadings = ["# 第1集｜针在背上 · 分镜表", "", "# 第3集｜一滴 分镜表"];
  const sourceRows = expectedTitles.map((_, index) => [
    `ep0${index + 1}-s01`, "她回头。", "CN：回来。<br>EN: Come back.<br>表演：低声",
    "近景<br>走位：门口", "人物：她<br>场景：门口", "音效：脚步<br>连续性：承接前镜<br>制作：保留动作", "5",
  ]);
  const episodes = sourceHeadings.map((heading, index) => [
    heading, "创作设定：保持已批准的世界设定。", row(STORYBOARD_HEADER),
    row(STORYBOARD_HEADER.map(() => "---")), row(sourceRows[index]), "制作说明：这行仍保留在 Markdown。",
  ].filter(Boolean).join("\n\n"));
  const screenplays = episodeTitles.map((heading) => `# ${heading}\n\n已批准剧本正文。\n`);
  const manifest = {
    title: "全剧名称不得被当成第一集集名", episodes: 3,
    scope: { kind: "sample", sourceEpisodeRange: [1, 3], sourceTotalEpisodes: 32 },
  };
  const markdown = withDeliveryTiming(renderDeliveryMarkdown(manifest, episodes, screenplays));
  assert.deepEqual([...markdown.matchAll(/^# (第 .*集｜.*)$/gm)].map((match) => match[1]), expectedTitles);
  assert.match(markdown, /【原剧第1–3集样例】全剧名称不得被当成第一集集名/);
  assert.match(markdown, /交付范围：原剧第1–3集样例/);
  const summary = "交付统计：共 3 集、3 镜；镜头合计 15 秒；单集范围 5–5 秒，平均 5 秒。";
  assert.ok(markdown.includes(summary));
  assert.equal(withDeliveryTiming(markdown), markdown);
  for (const text of ["创作设定：保持已批准的世界设定。", "制作说明：这行仍保留在 Markdown。"]) {
    assert.equal(markdown.split(text).length - 1, 3);
  }
  for (const sourceRow of sourceRows) assert.ok(markdown.includes(row(sourceRow)));
  const input = path.join(directory, "delivery.md");
  const output = path.join(directory, "delivery.docx");
  fs.writeFileSync(input, markdown);
  execFileSync(python, [renderer, input, output, "样例迁移分镜脚本"], { encoding: "utf8" });
  const result = JSON.parse(execFileSync(python, ["-c", `
import json, sys
from docx import Document
doc = Document(sys.argv[1])
print(json.dumps({
    "headings": [p.text for p in doc.paragraphs if p.style.style_id == "Heading1"],
    "title": [p.text for p in doc.paragraphs if p.style.style_id == "Title"],
    "paragraphs": [p.text for p in doc.paragraphs],
    "tables": [[[cell.text for cell in r.cells] for r in table.rows] for table in doc.tables],
    "cellParagraphCounts": [len(cell.paragraphs) for table in doc.tables for r in table.rows for cell in r.cells],
}, ensure_ascii=False))
`, output], { encoding: "utf8" }));
  assert.deepEqual(result.headings, expectedTitles);
  assert.deepEqual(result.title, ["【原剧第1–3集样例】样例迁移分镜脚本"]);
  assert.ok(result.paragraphs.some((text) => text.includes("交付范围：原剧第1–3集样例")));
  assert.deepEqual(result.paragraphs.filter((text) => text.startsWith("交付统计：")), [summary]);
  assert.deepEqual(result.tables, sourceRows.map((sourceRow) => [STORYBOARD_HEADER, sourceRow.map((value) => value.replaceAll("<br>", "\n"))]));
  assert.ok(result.cellParagraphCounts.every((count) => count === 1));
});

test("reviewed duration-cell repairs refresh both final Markdown and DOCX timing without changing other cells", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-delivery-repaired-timing-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = ["ep01-s01", "她回头。", "CN：回来。<br>EN: Come back.", "近景", "人物：她", "音效：脚步", "3.25"];
  const episode = ["# 第1集｜再见｜预计 90 秒", row(STORYBOARD_HEADER), row(STORYBOARD_HEADER.map(() => "---")), row(original)].join("\n");
  const base = renderDeliveryMarkdown({ title: "交付修正", episodes: 1, scope: { kind: "full-series" } }, [episode]);
  const applied = applyReviewedRepairs(base, { changes: [{ shot: "ep01-s01", column: 7, old: "3.25", new: "4.75", findings: ["duration-1"] }] });
  assert.equal(applied.appliedCells, 1);
  assert.deepEqual(applied.affectedEpisodes, [1]);
  const final = withDeliveryTiming(applied.markdown);
  const heading = "第 1 集｜再见｜预计 4.75 秒";
  const summary = "交付统计：共 1 集、1 镜；镜头合计 4.75 秒；单集范围 4.75–4.75 秒，平均 4.75 秒。";
  assert.ok(final.includes(`# ${heading}`));
  assert.ok(final.includes(summary));
  assert.equal(deliveryTiming(final).totalSeconds, 4.75);
  assert.equal(final.split("交付统计：").length - 1, 1);
  const input = path.join(directory, "delivery.md"), output = path.join(directory, "delivery.docx");
  fs.writeFileSync(input, final);
  execFileSync(python, [renderer, input, output, "交付修正"], { encoding: "utf8" });
  const result = JSON.parse(execFileSync(python, ["-c", `
import json, sys
from docx import Document
doc = Document(sys.argv[1])
print(json.dumps({"paragraphs": [p.text for p in doc.paragraphs], "row": [c.text for c in doc.tables[0].rows[1].cells]}, ensure_ascii=False))
`, output], { encoding: "utf8" }));
  assert.ok(result.paragraphs.includes(heading));
  assert.deepEqual(result.paragraphs.filter((text) => text.startsWith("交付统计：")), [summary]);
  assert.deepEqual(result.row, [...original.slice(0, 6).map((text) => text.replaceAll("<br>", "\n")), "4.75"]);
});
