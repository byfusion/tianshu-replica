import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const renderer = fileURLToPath(new URL("../src/experiments/render_storyboard_docx.py", import.meta.url));
const header = ["镜头号", "画面描述", "中英双语台词", "运镜方式/景别", "人物图/场景图", "备注（音效）", "建议时长（s）"];
const python = process.env.TIANSHU_PYTHON || "python3";

function render(directory, episodes, screenplayDirectory, { preface = "", deliveryTitle = "分镜交付" } = {}) {
  const input = path.join(directory, "storyboard.md");
  const output = path.join(directory, "storyboard.docx");
  const tableRow = (values) => `| ${values.join(" | ")} |`;
  fs.writeFileSync(input, preface + episodes.map(({ heading, rows }) => [
    heading ? `# ${heading}` : "",
    tableRow(header), tableRow(header.map(() => "---")), ...rows.map(tableRow),
  ].join("\n")).join("\n---\n"));
  execFileSync(python, [renderer, input, output, deliveryTitle, ...(screenplayDirectory ? [screenplayDirectory] : [])], { encoding: "utf8" });
  return JSON.parse(execFileSync(python, ["-c", `
import json, sys
from docx import Document
from docx.oxml.ns import qn
d = Document(sys.argv[1])
headings = [p for p in d.paragraphs if p.style.style_id == "Heading1"]
outline = d.styles["Heading 1"].element.find("./" + qn("w:pPr") + "/" + qn("w:outlineLvl"))
print(json.dumps({
    "deliveryTitleSpaceAfter": d.paragraphs[0].paragraph_format.space_after.pt,
    "headings": [p.text for p in headings],
    "paragraphs": [{"style": p.style.style_id, "text": p.text} for p in d.paragraphs],
    "outline": None if outline is None else outline.get(qn("w:val")),
    "pageBreaks": [p.paragraph_format.page_break_before for p in headings],
    "headingRuns": [{"size": p.runs[0].font.size.pt, "bold": p.runs[0].bold, "color": str(p.runs[0].font.color.rgb), "alignment": int(p.alignment)} for p in headings],
    "tables": [[[c.text for c in row.cells] for row in table.rows] for table in d.tables],
    "cellParagraphCounts": [len(c.paragraphs) for table in d.tables for row in table.rows for c in row.cells],
    "softBreaks": len(d.element.findall(".//" + qn("w:br"))),
}, ensure_ascii=False))
`, output], { encoding: "utf8" }));
}

test("DOCX exposes all episodes in the outline, repairs generic labels, and preserves table content", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-storyboard-docx-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missingLabels = new Set([21, 22, 23, 24, 25, 31, 32]);
  const episodes = Array.from({ length: 32 }, (_, index) => {
    const episode = index + 1;
    const number = String(episode).padStart(2, "0");
    const title = episode === 4 ? "标题4·分镜表｜原名" : `标题${episode}`;
    const suffix = ["｜分镜表", " 分镜表", " · 分镜表"][index % 3];
    return {
      title,
      heading: missingLabels.has(episode) ? "分镜剧本" : `第${episode === 17 ? 99 : episode}集｜${title}${suffix}`,
      rows: [[`ep${number}-s01`, "她走进门。", "CN：你好。<br>EN: Hello.<br>表演：平静", "近景；走位：门边", "人物：她；场景：门口", "音效：开门；连续性：门开；制作：保留动作", "5"]],
    };
  });
  const result = render(directory, episodes);
  assert.deepEqual(result.headings, episodes.map(({ title }, index) => {
    const episode = index + 1;
    return `第 ${episode} 集${missingLabels.has(episode) ? "" : `｜${title}`}｜预计 5 秒`;
  }));
  assert.equal(result.outline, "0");
  assert.equal(result.deliveryTitleSpaceAfter, 0);
  assert.deepEqual(result.pageBreaks, episodes.map((_, index) => index > 0));
  assert.deepEqual(result.headingRuns, episodes.map(() => ({ size: 13, bold: true, color: "000000", alignment: 1 })));
  assert.deepEqual(result.tables, episodes.map(({ rows }) => [header, ...rows.map((row) => row.map((cell) => cell.replaceAll("<br>", "\n")))]));
  assert.ok(result.cellParagraphCounts.every((count) => count === 1));
  assert.equal(result.softBreaks, 64);

  const legacy = render(directory, [
    { heading: "第 41 集分镜（68s）", rows: [["01", "第一段", "", "", "", "", "5"]] },
    { heading: "", rows: [["01", "第二段", "", "", "", "", "5"]] },
    { heading: "分镜剧本", rows: [["01", "第三段", "", "", "", "", "5"]] },
  ]);
  assert.deepEqual(legacy.headings, ["第 41 集｜分镜｜预计 5 秒", "第 2 集｜预计 5 秒", "第 3 集｜预计 5 秒"]);
});

test("DOCX recovers missing episode names from the same approved screenplay without replacing storyboard names", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-storyboard-title-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const screenplayDirectory = path.join(directory, "screenplay");
  fs.mkdirSync(screenplayDirectory);
  fs.writeFileSync(path.join(screenplayDirectory, "ep-21.md"), "# 第21集｜日翼晶体粉\n\n已定稿正文。\n");
  fs.writeFileSync(path.join(screenplayDirectory, "ep-22.md"), "# 第22集｜剧本原有标题\n\n已定稿正文。\n");
  fs.writeFileSync(path.join(screenplayDirectory, "ep-23.md"), "# 第23集｜同集已定稿标题\n\n已定稿正文。\n");
  const episodes = [
    { heading: "", rows: [["ep21-s01", "第一段", "", "", "", "", "5"]] },
    { heading: "第22集｜分镜已有标题｜分镜表", rows: [["ep22-s01", "第二段", "", "", "", "", "5"]] },
    { heading: "第23集｜分镜表", rows: [["ep23-s01", "第三段", "", "", "", "", "5"]] },
  ];
  const result = render(directory, episodes, screenplayDirectory);
  assert.deepEqual(result.headings, ["第 21 集｜日翼晶体粉｜预计 5 秒", "第 22 集｜分镜已有标题｜预计 5 秒", "第 23 集｜同集已定稿标题｜预计 5 秒"]);
  assert.deepEqual(result.tables, episodes.map(({ rows }) => [header, ...rows]));
  assert.ok(result.cellParagraphCounts.every((count) => count === 1));
});

test("DOCX keeps the three-episode sample notice separate from episode headings, including custom delivery titles", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-storyboard-sample-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const label = "【原剧第1–3集样例】";
  const scopeNote = "交付范围：原剧第1–3集样例。源剧总集数：32。其余剧集不在本次交付范围内。";
  const preface = `# ${label}样例剧名\n\n${scopeNote}\n\n`;
  const episodes = [1, 2, 3].map((episode) => ({
    heading: `第${episode}集｜标题${episode}｜分镜表`,
    rows: [[`ep0${episode}-s01`, "画面", "CN：你好。<br><br>EN: Hello.", "", "", "", "5"]],
  }));
  for (const deliveryTitle of ["", `${label}自定义交付名`, "自定义交付名"]) {
    const result = render(directory, episodes, undefined, { preface, deliveryTitle });
    assert.deepEqual(result.headings, ["第 1 集｜标题1｜预计 5 秒", "第 2 集｜标题2｜预计 5 秒", "第 3 集｜标题3｜预计 5 秒"]);
    assert.deepEqual(result.paragraphs.filter(({ style }) => style !== "Heading1"), [
      { style: "Title", text: deliveryTitle ? `${label}自定义交付名` : `${label}样例剧名` },
      { style: "Normal", text: scopeNote },
      { style: "Normal", text: "交付统计：共 3 集、3 镜；镜头合计 15 秒；单集范围 5–5 秒，平均 5 秒。" },
    ]);
    assert.deepEqual(result.tables, episodes.map(({ rows }) => [header, ...rows.map((row) => row.map((cell) => cell.replaceAll("<br>", "\n")))]));
    assert.ok(result.cellParagraphCounts.every((count) => count === 1));
    assert.equal(result.softBreaks, 6);
  }
});

test("standalone DOCX recalculates stale durations and the summary from decimal table cells", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-storyboard-timing-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const episodes = [
    { heading: "第1集｜第一滴｜预计 100 秒（1 分 40 秒）｜分镜表", rows: [["ep01-s01", "中文与英文。", "CN：你好。<br>EN: Hello.", "", "", "", "3.1"], ["ep01-s02", "抬头。", "", "", "", "", "4.2 s"]] },
    { heading: "第2集｜第7秒的答案｜预计 999 秒", rows: [["ep02-s01", "水花。", "", "", "", "", "5.125秒"]] },
  ];
  const result = render(directory, episodes, undefined, { preface: "交付统计：共 99 集；镜头合计 9999 秒。\n\n" });
  assert.deepEqual(result.headings, ["第 1 集｜第一滴｜预计 7.3 秒", "第 2 集｜第7秒的答案｜预计 5.125 秒"]);
  assert.deepEqual(result.paragraphs.filter(({ text }) => text.startsWith("交付统计：")), [
    { style: "Normal", text: "交付统计：共 2 集、3 镜；镜头合计 12.425 秒；单集范围 5.125–7.3 秒，平均 6.21 秒。" },
  ]);
  assert.deepEqual(result.tables, episodes.map(({ rows }) => [header, ...rows.map((row) => row.map((cell) => cell.replaceAll("<br>", "\n")))]));
});
