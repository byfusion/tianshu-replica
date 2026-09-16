import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPersonNames } from "../src/entities.mjs";
import { screenplayBilingualErrors } from "../src/bilingual.mjs";

const character = "【艾拉·维尔（Ayla Vale）／化名 Echo／被称 Storm Queen】\n人物正文提到 Hidden Person，不能作为姓名登记。";
const ledger = ["艾拉·维尔 Ayla Vale＝Echo＝Storm Queen（主角；后获 Honorary Commander）"];

test("Chinese character headings register explicit English names and ledger-backed aliases", () => {
  assert.deepEqual(canonicalPersonNames(character, ledger), ["Ayla Vale", "Echo"]);
});

test("a confirmed alias alone remains a valid bilingual name call", () => {
  const names = canonicalPersonNames(character, ledger);
  assert.deepEqual(screenplayBilingualErrors("艾拉（中）：Echo。\n艾拉（EN）：Echo.", names), []);
  for (const value of ["Storm Queen", "Hidden Person", "Echo, follow me!"]) {
    assert.ok(screenplayBilingualErrors(`艾拉（中）：${value}\n艾拉（EN）：${value}`, names)
      .some((error) => error.includes("没有真实中文")), value);
  }
});

test("Chinese entries require the matching registered identity and explicit alias", () => {
  assert.deepEqual(canonicalPersonNames(character, ["艾拉·维尔 Ayla Vale（主角）"]), ["Ayla Vale"]);
  assert.deepEqual(canonicalPersonNames("【艾拉·维尔（Ayla Vale）／被称 Echo】", ledger), ["Ayla Vale"]);
  assert.deepEqual(canonicalPersonNames(character, ["另一人 Ayla Vale＝Echo（主角）"]), []);
  assert.deepEqual(canonicalPersonNames(character, ["艾拉·维尔 Ayla Stone＝Echo（主角）"]), []);
});

test("unconfirmed entries, institutions, and body mentions do not register people", () => {
  const characters = [
    "【红裙女性（Lyra Stone）／映射待核对】",
    "【艾拉·维尔（Ayla Vale）／化名 Echo／身份待确认】",
    "【机甲议会（Mecha Council）】",
    "人物正文：【路人（Hidden Person）／化名 Shade】",
  ].join("\n");
  const names = ["红裙女性 Lyra Stone", ...ledger, "机甲议会 Mecha Council", "路人 Hidden Person＝Shade"];
  assert.deepEqual(canonicalPersonNames(characters, names), []);
});

test("existing English character entries keep their shared-prefix behavior", () => {
  const characters = "Ava Miller（拼写注释）：护理员。\nKnox / Nox（同一人）：幼龙。\nWindsor Council：机构。";
  assert.deepEqual(canonicalPersonNames(characters, ["Ava Miller（拼写注释）", "Knox / Nox（同一人）", "Windsor Council"]), ["Ava Miller", "Knox", "Nox"]);
});
