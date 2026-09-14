import assert from "node:assert/strict";
import test from "node:test";
import { deliveryTiming, withDeliveryTiming } from "../src/delivery-timing.mjs";

const header = "| 镜头号 | 画面描述 | 中英双语台词 | 运镜方式/景别 | 人物图/场景图 | 备注（音效） | 建议时长（s） |";
const divider = "| --- | --- | --- | --- | --- | --- | --- |";
const board = (episode, title, durations) => [
  title, "创作设定：保留前文。", header, divider,
  ...durations.map((seconds, index) => `| ep${String(episode).padStart(2, "0")}-s${String(index + 1).padStart(2, "0")} | 她抬头。 | CN：回来。<br>EN: Come back. | 近景 | 人物：她 | 音效：脚步 | ${seconds} |`),
  "制作说明：保留后文。",
].filter(Boolean).join("\n");

test("delivery timing totals every shot including decimals and duration units", () => {
  const markdown = [board(7, "# 第7集｜开门", ["3.1", "4.2 s"]), board(8, "# 第8集｜见面", ["5.125秒"])].join("\n---\n");
  assert.deepEqual(deliveryTiming(markdown), {
    episodes: [{ episode: 7, shots: 2, seconds: 7.3 }, { episode: 8, shots: 1, seconds: 5.125 }],
    episodeCount: 2, shotCount: 3, totalSeconds: 12.425, minSeconds: 5.125, maxSeconds: 7.3, averageSeconds: 6.2125,
  });
  const timed = withDeliveryTiming(markdown);
  assert.match(timed, /^# 第 7 集｜开门｜预计 7\.3 秒$/m);
  assert.match(timed, /^# 第 8 集｜见面｜预计 5\.125 秒$/m);
  assert.match(timed, /交付统计：共 2 集、3 镜；镜头合计 12\.425 秒；单集范围 5\.125–7\.3 秒，平均 6\.21 秒。/);
});

test("timing replaces stale title durations idempotently and preserves sample scope and table bytes", () => {
  const preface = "# 【原剧第1–3集样例】全剧标题\n\n交付范围：原剧第1–3集样例。源剧总集数：32。\n\n";
  const markdown = preface + [
    board(1, "# 第1集｜第二次｜预计 999 秒｜分镜表", ["3.25", "2.5"]),
    board(2, "# 第2集｜第7秒的答案（68s）", ["6"]),
    board(3, "# 分镜剧本", ["4"]),
  ].join("\n---\n") + "\n";
  const timed = withDeliveryTiming(markdown);
  assert.ok(timed.startsWith(preface));
  assert.match(timed, /^# 第 1 集｜第二次｜预计 5\.75 秒$/m);
  assert.match(timed, /^# 第 2 集｜第7秒的答案｜预计 6 秒$/m);
  assert.match(timed, /^# 第 3 集｜预计 4 秒$/m);
  assert.equal(withDeliveryTiming(timed), timed);
  assert.deepEqual(timed.split("\n").filter((line) => line.startsWith("|")), markdown.split("\n").filter((line) => line.startsWith("|")));
  assert.equal(timed.split("创作设定：保留前文。").length - 1, 3);
  assert.equal(timed.split("制作说明：保留后文。").length - 1, 3);
  const corrected = withDeliveryTiming(timed.replace("| 3.25 |", "| 4.75 |"));
  assert.match(corrected, /^# 第 1 集｜第二次｜预计 7\.25 秒$/m);
  assert.match(corrected, /镜头合计 17\.25 秒；单集范围 4–7\.25 秒，平均 5\.75 秒/);
  assert.equal(corrected.split("交付统计：").length - 1, 1);
});

test("timing inserts missing episode headings and keeps CRLF table content", () => {
  const markdown = board(21, "", ["3", "3.5"]).replaceAll("\n", "\r\n");
  const result = withDeliveryTiming(markdown);
  assert.match(result, /# 第 21 集｜预计 6\.5 秒\r\n/);
  assert.equal(withDeliveryTiming(result), result);
  assert.deepEqual(result.split("\n").filter((line) => line.startsWith("|")), markdown.split("\n").filter((line) => line.startsWith("|")));
});

test("timing replaces an existing seconds-plus-minutes title suffix instead of appending twice", () => {
  const markdown = board(1, "# 第 1 集｜合成小样｜预计 83 秒（1 分 23 秒）", ["3.25", "4.5"]);
  const result = withDeliveryTiming(markdown);
  assert.match(result, /^# 第 1 集｜合成小样｜预计 7\.75 秒$/m);
  assert.equal(withDeliveryTiming(result), result);
  assert.deepEqual(result.split("\n").filter((line) => line.startsWith("|")), markdown.split("\n").filter((line) => line.startsWith("|")));
});

test("an ambiguous or missing duration is reported instead of substituting a title estimate", () => {
  for (const duration of ["3–5", "", "unknown", "0"]) {
    assert.throws(() => deliveryTiming(board(1, "# 第1集｜预计 60 秒", [duration])), /invalid duration for ep01-s01/);
  }
});
