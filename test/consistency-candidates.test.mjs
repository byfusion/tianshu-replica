import assert from "node:assert/strict";
import test from "node:test";
import { collectConsistencyCandidates } from "../src/consistency-candidates.mjs";

const row = ({ id = "ep01-s01", action = "Mara 看向门边。", dialogue = "无台词", assets = "人物：Mara", notes = "连续性：接上一镜" } = {}) => `| ${id} | ${action} | ${dialogue} | 固定 / 近景 | ${assets} | ${notes} | 4 |`;
const collect = (storyboard, canonical = "") => collectConsistencyCandidates({ stage: "storyboard", episode: 1, storyboard, canonical });

test("quantity hint keeps exact quotes and adjacent facts for an hours/count conflict", () => {
  const text = [row({ id: "ep01-s01", dialogue: "Leon：每两小时回报。<br>EN: Report every two hours." }), row({ id: "ep01-s02", dialogue: "Leon：两条。<br>EN: Two hours." }), row({ id: "ep01-s03" })].join("\n");
  const [candidate] = collect(text);
  assert.equal(collect(text).length, 1);
  assert.equal(candidate.kind, "bilingual_quantity");
  assert.equal(candidate.shotId, "ep01-s02");
  assert.ok(candidate.context.includes("每两小时回报"));
  assert.ok(candidate.quotes.every(({ text: quote }) => text.includes(quote)));
  assert.equal(candidate.quotes.find(({ label }) => label.endsWith("英文")).text, "EN: Two hours.");
  assert.equal(candidate.severity, undefined);
  assert.equal(candidate.replacement, undefined);
});

test("matching quantities and equivalent hour/minute units produce no hint", () => {
  for (const dialogue of ["Leon：两个小时。<br>EN: Two hours.", "Leon：六十分钟。<br>EN: An hour.", "Leon：半小时。<br>EN: Half an hour.", "Leon：半个时辰。<br>EN: An hour.", "Leon：三个选项。<br>EN: Three options.", "Leon：每两个小时一次。<br>EN: Every two hours."]) assert.deepEqual(collect(row({ dialogue })), []);
});

test("source-unknown unequal time units remain review candidates with no proposed answer", () => {
  const [candidate] = collect(row({ dialogue: "Mara：半个时辰。<br>EN: Half an hour.", notes: "原片实际时长未知，不选择任一数值。" }));
  assert.equal(candidate?.kind, "bilingual_quantity");
  assert.ok(candidate.context.includes("实际时长未知"));
  assert.equal(candidate?.replacement, undefined);
});

test("compound English quantities are compared as a whole, not just their suffix", () => {
  for (const dialogue of ["Mara：四十二天。<br>EN: Forty-two days.", "Mara：二十七天。<br>EN: Twenty seven days."]) assert.deepEqual(collect(row({ dialogue })), []);
  assert.equal(collect(row({ dialogue: "Mara：四十二天。<br>EN: Forty-three days." }))[0]?.kind, "bilingual_quantity");
});

test("repeated distributive phrases and ordinal second are not treated as numeric contradictions", () => {
  for (const dialogue of ["Mara：一个一个来。<br>EN: One at a time.", "Mara：不需要再投一次胎。<br>EN: She doesn't need a second birth."]) assert.deepEqual(collect(row({ dialogue })), []);
});

test("temporal negation highlights risk without judging even a correct translation", () => {
  for (const en of ["It wasn't in him a moment ago. It's been there.", "It wasn't inserted just now. It was already there."]) {
    assert.equal(collect(row({ dialogue: `Mara：不是刚刺进去的，是早就扎着的。<br>EN: ${en}` }))[0]?.kind, "bilingual_temporal_negation");
  }
  assert.deepEqual(collect(row({ dialogue: "Mara：我不同意。<br>EN: I do not agree." })), []);
});

test("deadline expression is a review cue even when quantities match", () => {
  assert.equal(collect(row({ dialogue: "Mara：六个月之内不成就没有机会。<br>EN: If she fails within six months, there is no second chance." }))[0]?.kind, "bilingual_temporal_negation");
});

test("silent mouth action with dialogue is a hint, while inner voice and ordinary split shots are not", () => {
  assert.equal(collect(row({ action: "Mara 嘴唇无声地动了一下。", dialogue: "Mara：他在疼。<br>EN: He is hurting.<br>表演：声音很低" }))[0]?.kind, "voice_action_dialogue");
  assert.deepEqual(collect(row({ action: "Mara 嘴唇无声地动了一下。", dialogue: "Mara（心声）：他在疼。<br>EN: He is hurting." })), []);
  assert.deepEqual(collect(row({ action: "Mara 行礼后开口。", dialogue: "无台词", notes: "下一镜接她说的话。" })), []);
});

test("multiple concrete cues in the same shot collapse without dropping their quotes", () => {
  const [candidate] = collect(row({ action: "Mara 嘴唇无声地动了一下。", dialogue: "Mara：两条。<br>EN: Two hours." }));
  assert.equal(candidate.kind, "multiple_consistency_cues");
  assert.equal(candidate.quotes.length, 4);
});

test("role and borrowed assets require named canonical quotes and preserve uncertainty", () => {
  const canonical = "Leon：黑龙王，白金礼服。\nMara：护理实习生，身穿军装、银环羽纹扣。";
  const [candidate] = collect(row({ assets: "人物：Leon（王储，军装、银环羽纹扣）" }), canonical);
  assert.equal(candidate?.kind, "canonical_claim_contrast");
  assert.ok(candidate.quotes.some(({ text }) => text === "Leon：黑龙王，白金礼服。"));
  assert.ok(candidate.quotes.some(({ text }) => text === "Mara：护理实习生，身穿军装、银环羽纹扣。"));
  for (const assets of ["人物：Leon（国王，白金礼服）", "人物：Leon（疑似王储，身份待确认）", "人物：未具名青年（王储，军装）"]) assert.deepEqual(collect(row({ assets }), canonical), []);
  assert.deepEqual(collect(row({ assets: "人物：Leon（王储）" })), []);
  assert.deepEqual(collect(row({ assets: "人物：Leon（王储）" }), "Leon：是否黑龙王，尚未确认。"), []);
  assert.deepEqual(collect(row({ assets: "人物：Mara（普通礼服）" }), canonical), []);
  assert.deepEqual(collect(row({ assets: "人物：Leon（银环羽纹扣）" }), `${canonical}\nNora：银环羽纹扣。`), []);
  assert.equal(collect(row({ assets: "人物：Leon（银环羽纹扣）" }), canonical)[0]?.kind, "canonical_claim_contrast");
});

test("screenplay pairs have stable positions, literal quotes and same quantity behavior", () => {
  const screenplay = "Leon（中）：每两个小时一次。\nLeon（EN）：Every two hours.\n\nLeon（中）：两条。\nLeon（EN）：Two hours.";
  const candidates = collectConsistencyCandidates({ stage: "screenplay", episode: 8, screenplay });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, "consistency-screenplay-ep8-line4");
  assert.ok(candidates[0].quotes.every(({ text }) => screenplay.includes(text)));
  assert.deepEqual(candidates, collectConsistencyCandidates({ stage: "screenplay", episode: 8, screenplay }));
});

test("all eligible rows are retained without a candidate cap", () => {
  const storyboard = Array.from({ length: 40 }, (_, index) => row({ id: `ep01-s${String(index + 1).padStart(2, "0")}`, dialogue: "Mara：两条。<br>EN: Two hours." })).join("\n");
  assert.equal(collect(storyboard).length, 40);
  assert.deepEqual(collectConsistencyCandidates({ stage: "planning", episode: 1, storyboard }), []);
});
