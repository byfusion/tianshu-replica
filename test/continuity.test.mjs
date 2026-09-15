import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  commitContinuityReview,
  continuityContext,
  continuityIsAccepted,
  extractContinuityUpdate,
  invalidateContinuityFrom,
  observedSnapshotReferences,
  reviewContinuityUpdate,
  stageContinuityProposal,
} from "../src/continuity.mjs";
import { createRun, readJson, readText, sha, writeJson, writeText } from "../src/core.mjs";
import { assertContinuityChain } from "../src/runtime.mjs";
import { produceScripts } from "../src/agents.mjs";
import { Type, defineTool } from "../src/experiments/lib.mjs";
import { parseSourceOutline } from "../src/replication.mjs";
import { agentFixture } from "./helpers/agent-fixtures.mjs";

async function capturedDynamicSnapshots(t, snapshot) {
  const captured = {};
  const fixture = agentFixture(t);
  fixture.write("continuity/current.json", { lastEpisode: 0, snapshot });
  const writerStop = new Error("offline Writer prompt captured");
  let writerPrompt;
  await assert.rejects(
    produceScripts(fixture.dir, {
      createSession: async (options) => {
        assert.equal(options.maxOutputTokens, undefined);
        return { session: { dispose() {} }, metrics: {} };
      },
      prompt: async (_session, _metrics, value) => {
        writerPrompt = value;
        throw writerStop;
      },
      reviewContinuity: async () => assert.fail("capture stops before continuity review"),
    }),
    (error) => error === writerStop,
  );
  captured.Writer = writerPrompt
    .split("截至上一集的动态连续性快照：\n")[1]
    .split("\n\n本集及相邻集大纲：")[0];

  for (const [role, original] of [["ContinuityAgent", reviewContinuityUpdate]]) {
    let prompt;
    const stop = new Error("offline prompt captured");
    const run = vm.runInNewContext(`(${original.toString()})`, {
      planningBudgetGuidance: () => "",
      episodeMapContext: () => "",
      Type,
      defineTool,
      path,
      parseSourceOutline,
      observedSnapshotReferences,
      fs: { existsSync: () => false },
      process: { env: { TIANSHU_MODEL_PROVIDER: "deepseek" } },
      loadManifest: () => ({ state: "screenplay_producing", episodes: 32 }),
      saveManifest: () => {},
      readJson: () => ({ episodes: 32 }),
      readText: (file) =>
        file.endsWith("outline.md")
          ? Array.from(
              { length: 32 },
              (_, index) => `## 第${index + 1}集\n已批准的本集计划。`,
            ).join("\n\n")
          : file.endsWith("ledger.json")
            ? '{"names":[]}'
            : file.endsWith("market.json")
              ? "{}"
              : "已确认的静态材料。",
      canonicalPersonNames: () => [],
      loadProductionContract: () => ({ revision: { maxContinuityRepairAttempts: 2 } }),
      productionContractDigest: () => "test-contract",
      productionContractMarkdown: () => "静态生产合同。",
      batches: () => [{ from: 12, to: 12 }],
      artifactTools: () => [],
      ep: (episode) => String(episode).padStart(2, "0"),
      taskPath: (root, id) => path.join(root, "tasks", `${id}.json`),
      continuityContext: () => ({
        contract: "静态连续性合同。",
        current: { snapshot, snapshotDigest: "test-previous-state", lastEpisode: 11 },
      }),
      sampleContext: () => "",
      outlineWindow: () => "本集与相邻集大纲。",
      replicationWriterContext: () => "",
      createPiExperimentSession: async (options) => {
        assert.equal(options.maxOutputTokens, role === "ContinuityAgent" ? 65536 : undefined);
        if (role === "ContinuityAgent") assert.equal(options.thinkingLevel, "low");
        return { session: { dispose() {} }, metrics: {} };
      },
      promptWithWatchdog: async (_session, _metrics, value) => {
        prompt = value;
        throw stop;
      },
      writeBatchMetrics: () => {},
      appendMetrics: () => {},
    });
    await assert.rejects(
      run("/offline-not-written", {
        episode: 12,
        screenplay: "本集正式剧本。",
        proposedUpdate: "本集提交的状态变化。",
      }),
      (error) => error === stop,
    );
    const start = role === "Writer" ? "截至上一集的动态连续性快照：\n" : "上一集动态快照：\n";
    const end = role === "Writer" ? "\n\n本集及相邻集大纲：" : "\n\nWriter 提交的本集变化：";
    captured[role] = prompt.split(start)[1].split(end)[0];
  }
  return captured;
}

test("Writer and ContinuityAgent receive the complete long previous snapshot including its final constraint", async (t) => {
  const finalConstraint = "末尾关键约束：Maya 尚不知道保险柜密码；钥匙仍由 Noah 保管。";
  const snapshot = `客观事实与人物认知：\n${"既有事实和人物认知保持上一集已经确认的状态。\n".repeat(650)}${finalConstraint}`;
  assert.ok(snapshot.length > 12000);
  const captured = await capturedDynamicSnapshots(t, snapshot);
  assert.deepEqual(
    Object.fromEntries(Object.entries(captured).map(([role, value]) => [role, value.length])),
    { Writer: snapshot.length, ContinuityAgent: snapshot.length },
  );
  assert.equal(captured.Writer, snapshot);
  assert.equal(captured.ContinuityAgent, snapshot);
  assert.ok(
    captured.Writer.endsWith(finalConstraint) && captured.ContinuityAgent.endsWith(finalConstraint),
  );
});

function screenplay(episode, update) {
  return `# 第${episode}集｜EP${String(episode).padStart(2, "0")}\n\n## 场景一\n\nMAYA（中）：钥匙在我这里。\nMAYA（EN）：I have the key.\n\n## 【本集钩子】\n门被打开。\n\n## 【连续性检查】\n${update}`;
}

test("continuity update is extracted from the screenplay", () => {
  assert.equal(extractContinuityUpdate(screenplay(1, "钥匙由 Maya 保管。")), "钥匙由 Maya 保管。");
});

test("continuity repair rewinds to the episode before the earliest change and archives downstream records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-continuity-rewind-"));
  try {
    const { dir } = createRun(root, { title: "回退测试", episodes: 30, input: "x" });
    writeText(
      path.join(dir, "canonical", "continuity-contract.md"),
      "开篇状态固定，任何变化必须逐集发生。",
    );
    for (let episode = 1; episode <= 4; episode++) {
      const script = screenplay(episode, `状态推进到第 ${episode} 集。`);
      stageContinuityProposal(dir, {
        episode,
        screenplay: script,
        proposedUpdate: `状态推进到第 ${episode} 集。`,
      });
      commitContinuityReview(dir, {
        episode,
        screenplay: script,
        proposedUpdate: `状态推进到第 ${episode} 集。`,
        review: {
          verdict: "accept",
          approvedUpdate: `状态推进到第 ${episode} 集。`,
          currentSnapshot: `客观事实：当前已推进到第 ${episode} 集。人物认知：Maya 知道当前进度。未解决：下一集尚未发生。`,
          reason: "与本集一致。",
        },
      });
    }
    const result = invalidateContinuityFrom(dir, 3, 4, "EP03 repair");
    assert.equal(result.restoredThrough, 2);
    assert.deepEqual(result.invalidated, [3, 4]);
    assert.equal(readJson(path.join(dir, "continuity", "current.json")).lastEpisode, 2);
    assert.equal(fs.existsSync(path.join(dir, "continuity", "ep-03.json")), false);
    assert.equal(fs.existsSync(path.join(dir, "continuity", "ep-04.json")), false);
    assert.deepEqual(fs.readdirSync(path.join(dir, result.archiveDir)).sort(), [
      "ep-03.json",
      "ep-04.json",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("delivery continuity validation rejects a broken snapshot chain", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-continuity-gate-"));
  try {
    const { dir } = createRun(root, { title: "链验证", episodes: 30, input: "x" });
    writeText(path.join(dir, "canonical", "continuity-contract.md"), "开篇状态固定。");
    for (let episode = 1; episode <= 2; episode++) {
      const update = `故事状态已经推进到第 ${episode} 集。`,
        file = path.join(dir, "screenplay", `ep-0${episode}.md`);
      writeText(file, screenplay(episode, update));
      const script = readText(file),
        previous = continuityContext(dir).current.snapshotDigest;
      stageContinuityProposal(dir, { episode, screenplay: script, proposedUpdate: update });
      commitContinuityReview(dir, {
        episode,
        screenplay: script,
        proposedUpdate: update,
        review: {
          verdict: "accept",
          approvedUpdate: update,
          currentSnapshot: `客观事实：推进到 ${episode}。人物认知：Maya 知道进度。未解决：下一步未知。`,
          reason: "一致",
        },
      });
      const record = readJson(path.join(dir, "continuity", `ep-0${episode}.json`));
      writeJson(path.join(dir, "tasks", `screenplay-ep-0${episode}.json`), {
        state: "passed",
        digest: sha(script),
        previousContinuityDigest: previous,
        continuityDigest: record.snapshotDigest,
      });
    }
    assert.equal(assertContinuityChain(dir, 2).lastEpisode, 2);
    const broken = readJson(path.join(dir, "continuity", "ep-02.json"));
    broken.previousSnapshotDigest = "broken";
    writeJson(path.join(dir, "continuity", "ep-02.json"), broken);
    assert.throws(() => assertContinuityChain(dir, 2), /chain mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("continuity history is append-only and each episode chains from the prior snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-continuity-test-"));
  try {
    const { dir } = createRun(root, { title: "连续性测试", episodes: 30, input: "x" });
    const contractFile = path.join(dir, "canonical", "continuity-contract.md");
    writeText(contractFile, "Maya 身份固定。开篇钥匙在前台保险柜，任何转移必须在剧本中发生。");
    const contractDigest = sha(fs.readFileSync(contractFile, "utf8"));
    const first = screenplay(1, "Maya 从保险柜领取钥匙；只有 Maya 知道钥匙编号。");
    stageContinuityProposal(dir, {
      episode: 1,
      screenplay: first,
      proposedUpdate: "Maya 已领取钥匙。",
    });
    const rejected = commitContinuityReview(dir, {
      episode: 1,
      screenplay: first,
      proposedUpdate: "所有人都知道钥匙编号。",
      review: {
        verdict: "reject",
        approvedUpdate: "不适用",
        currentSnapshot: "不适用",
        reason: "剧本只支持 Maya 知道。",
      },
    });
    assert.equal(rejected.accepted, false);
    const accepted = commitContinuityReview(dir, {
      episode: 1,
      screenplay: first,
      proposedUpdate: "Maya 已领取钥匙。",
      review: {
        verdict: "correct",
        approvedUpdate: "Maya 从保险柜领取钥匙；只有 Maya 知道编号。",
        currentSnapshot:
          "客观事实：钥匙现在由 Maya 保管。人物认知：只有 Maya 知道钥匙编号。未解决：钥匙对应哪扇门尚未揭示。",
        reason: "补充人物认知边界。",
      },
    });
    assert.equal(accepted.accepted, true);
    assert.equal(continuityIsAccepted(dir, 1, sha(first)), true);
    assert.equal(fs.readdirSync(path.join(dir, "continuity", "events", "ep-01")).length, 2);
    assert.equal(sha(fs.readFileSync(contractFile, "utf8")), contractDigest);

    const beforeSecond = continuityContext(dir).current.snapshotDigest;
    const second = screenplay(2, "Maya 把钥匙交给 Noah；Noah 此时才知道编号。");
    stageContinuityProposal(dir, {
      episode: 2,
      screenplay: second,
      proposedUpdate: "钥匙转交 Noah。",
    });
    commitContinuityReview(dir, {
      episode: 2,
      screenplay: second,
      proposedUpdate: "钥匙转交 Noah。",
      review: {
        verdict: "accept",
        approvedUpdate: "Maya 把钥匙交给 Noah；Noah 知道编号。",
        currentSnapshot:
          "客观事实：钥匙现在由 Noah 保管。人物认知：Maya 与 Noah 知道钥匙编号。未解决：钥匙对应哪扇门尚未揭示。",
        reason: "提案与剧本和上一集状态一致。",
      },
    });
    const secondRecord = readJson(path.join(dir, "continuity", "ep-02.json"));
    assert.equal(secondRecord.previousSnapshotDigest, beforeSecond);
    assert.equal(readJson(path.join(dir, "continuity", "current.json")).lastEpisode, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
