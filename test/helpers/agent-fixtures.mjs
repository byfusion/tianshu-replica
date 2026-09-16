import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STORYBOARD_HEADER } from "../../src/core.mjs";
import { writeExecutionContract } from "../../src/execution-contract.mjs";
import { Compile, readText, writeJson, writeText } from "../../src/experiments/lib.mjs";
import { inferMarketIntent, marketContractMarkdown } from "../../src/market.mjs";
import {
  createProductionContract,
  writeProductionContract,
} from "../../src/production-contract.mjs";

export function agentFixture(
  t,
  { episodes = 1, state = "approved", provider = "deepseek", legacyUnbound = false } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-offline-agent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const market = inferMarketIntent("目标市场：中国");
  writeJson(path.join(dir, "manifest.json"), {
    state,
    episodes,
    productionRoute: "tianshu-replication",
  });
  writeProductionContract(dir, createProductionContract());
  writeJson(path.join(dir, "canonical", "market.json"), market);
  writeText(path.join(dir, "canonical", "market-contract.md"), marketContractMarkdown(market));
  writeText(
    path.join(dir, "canonical", "characters.md"),
    "林夏经营中国街区的旧店，周舟负责修理。来客身份未知。",
  );
  writeJson(path.join(dir, "canonical", "ledger.json"), { names: ["林夏", "周舟"] });
  writeText(
    path.join(dir, "canonical", "continuity-contract.md"),
    "林夏与周舟在中国街区修复旧店。来客身份未知，不提前推断。",
  );
  writeText(
    path.join(dir, "canonical", "design.md"),
    "通过共同修复旧店的动作推进林夏与周舟的互动，保留来客身份未知的尾钩。",
  );
  const outline = Array.from(
    { length: episodes },
    (_, index) => `## 第${index + 1}集\n林夏与周舟完成当前修理任务，门外的来客身份仍未知。`,
  ).join("\n\n");
  writeText(path.join(dir, "canonical", "outline.md"), outline);
  writeText(path.join(dir, "canonical", "source-outline.md"), outline);
  writeText(
    path.join(dir, "canonical", "source-creative.md"),
    "合成离线素材：林夏与周舟在中国街区共同修复旧店。",
  );
  writeText(
    path.join(dir, "canonical", "source-characters.md"),
    "林夏是店主，周舟负责修理，门外来客的身份尚未确认。",
  );
  writeJson(path.join(dir, "canonical", "source-provenance.json"), {
    evidenceType: "synthetic-text-test",
    directVideoUnderstanding: false,
  });
  if (!legacyUnbound) {
    const model = { deepseek: "deepseek", "openai-codex": "gpt", "kimi-coding": "kimi" }[provider];
    writeExecutionContract(dir, { model, agentDir: path.join(dir, "unused-offline-credentials") });
  }
  return {
    dir,
    read: (file) => readText(path.join(dir, file)),
    exists: (file) => fs.existsSync(path.join(dir, file)),
    write: (file, value) =>
      typeof value === "string"
        ? writeText(path.join(dir, file), value)
        : writeJson(path.join(dir, file), value),
  };
}

export function screenplayFixture(episode, title = `集名${episode}`) {
  return [
    `# 第 ${episode} 集｜${title}`,
    "## 场景1 中国街区的旧店，日，内",
    "林夏扶住摇晃的木架，周舟放下工具。两人检查破损的位置，先移开可能掉落的物件，再让出门口的通道。".repeat(
      14,
    ),
    "林夏（中）：先把门边的木架固定住，客人还在外面等。",
    "林夏（EN）：Secure the shelf by the door first. Someone is waiting outside.",
    "【本集钩子】门外传来敲门声，来客身份仍未知。",
    "【连续性检查】木架已经固定，来客仍未进入旧店，身份未确认。",
  ].join("\n");
}

export function storyboardFixture(episode, title = `集名${episode}`) {
  return [
    `# 第 ${episode} 集｜${title}`,
    `| ${STORYBOARD_HEADER.join(" | ")} |`,
    `|${STORYBOARD_HEADER.map(() => "---").join("|")}|`,
    ...Array.from(
      { length: 12 },
      (_, index) =>
        `| ep${String(episode).padStart(2, "0")}-s${String(index + 1).padStart(2, "0")} | 林夏在中国旧店内扶住木架，周舟观察固定位置。 | 林夏：先固定木架。<br>EN: Secure the shelf first. | 中景<br>走位：停在木架旁 | 人物：林夏、周舟<br>场景：中国街区旧店<br>道具：木架 | 音效：脚步<br>功能：反应<br>连续性：保持门口站位 | 8 |`,
    ),
  ].join("\n");
}

export async function invokeAgentTool(session, name, args = {}) {
  const tool = session.tools.find((item) => item.name === name);
  assert.ok(tool, `missing ${name}`);
  assert.ok(
    Compile(tool.parameters).Check(args),
    `offline ${name} input must satisfy the real tool schema`,
  );
  return tool.execute("offline-agent-test", args);
}
