import assert from "node:assert/strict";
import test from "node:test";
import { semanticRepairPlan } from "../src/review.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertReviewerSubmitted,
  candidateReviewSummary,
  checkpointWindowReview,
  episodePayload,
  priorRepairFindingIds,
  reviewPrompt,
  reviewSeries,
  reviewTimeoutMs,
  seriesReviewSubmissionTool,
  validateCandidateDispositions,
} from "../src/semantic-review.mjs";
import { readJson, writeJson, writeText } from "../src/core.mjs";
import { createProductionContract } from "../src/production-contract.mjs";
import { writeExecutionContract } from "../src/execution-contract.mjs";

function finding(id, episode, overrides = {}) {
  return {
    id,
    episode,
    severity: "P1",
    scope: "local",
    category: `category-${id}`,
    evidence: `evidence ${id}`,
    reason: `reason ${id}`,
    acceptance: `acceptance ${id}`,
    repairInstruction: `repair ${id}`,
    preserve: [],
    doNotChange: [],
    disposition: "repair",
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    stage: "screenplay",
    totalEpisodes: 30,
    cycle: 1,
    maxCycles: 3,
    systemicEpisodeThreshold: 3,
    priorFindingIds: [],
    artifactDigest: "artifact",
    contractDigest: "contract",
    ...overrides,
  };
}

test("DeepSeek series Reviewer alone requests a 65536-token session without an extra review prompt", async (t) => {
  const previousProvider = process.env.TIANSHU_MODEL_PROVIDER;
  t.after(() => {
    if (previousProvider === undefined) delete process.env.TIANSHU_MODEL_PROVIDER;
    else process.env.TIANSHU_MODEL_PROVIDER = previousProvider;
  });
  for (const family of ["deepseek", "kimi", "gpt"]) {
    process.env.TIANSHU_MODEL_PROVIDER = family === "deepseek" ? "kimi-coding" : "deepseek";
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-series-options-"));
    t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
    writeJson(path.join(runDir, "manifest.json"), { episodes: 32 });
    writeJson(path.join(runDir, "canonical/production-contract.json"), createProductionContract());
    writeText(path.join(runDir, "canonical/outline.md"), "Existing accepted 32-episode planning");
    writeExecutionContract(runDir, {
      model: family,
      agentDir: path.join(runDir, "offline-agent"),
      env: {},
    });
    let sessionOptions;
    let prompts = 0;
    let sessions = 0;
    let disposed = 0;
    const result = await reviewSeries(runDir, "planning", [], "contract", 2, {
      createSession: async (settings) => {
        sessions++;
        sessionOptions = settings;
        return {
          session: {
            dispose() {
              disposed++;
            },
          },
          metrics: {},
        };
      },
      prompt: async (_session, _metrics, text) => {
        prompts++;
        assert.match(text, /Existing accepted 32-episode planning/);
        await sessionOptions.customTools[0].execute("offline-submit", {
          summary: "已核对全部规划，无新增问题。",
          findings: [],
        });
      },
    });
    assert.equal(sessionOptions.maxOutputTokens, family === "deepseek" ? 65536 : undefined);
    assert.equal(
      sessionOptions.thinkingLevel,
      family === "deepseek" ? "high" : undefined,
      "other families retain their adapter's reasoning policy",
    );
    assert.equal(result.findings.length, 0);
    assert.equal(prompts, 1);
    assert.equal(sessions, 1);
    assert.equal(disposed, 1);
    const recorded = readJson(path.join(runDir, "metrics/planning-series-review-cycle-2.json"));
    assert.equal(recorded.role, "planning-series-review-cycle-2");
    assert.equal(recorded.outcome, "completed");
  }
});

test("screenplay and storyboard share evidence and source uncertainty boundaries", () => {
  for (const stage of ["screenplay", "storyboard"]) {
    const prompt = reviewPrompt(stage, "production contract");
    assert.match(prompt, /不能把逐字逐动作复刻当作目标/);
    assert.match(prompt, /相同台词、类似音效、服装颜色或外貌相似均不能单独证明同一时刻或同一人物/);
    assert.match(prompt, /源稿未确认的人物映射、关系或画外过程须保留未知/);
    assert.match(prompt, /不得要求新增未获大纲支持的画外事件来补齐因果/);
    assert.match(prompt, /真实非阻断问题可由终审标为 accepted_non_blocking/);
  }
  assert.match(reviewPrompt("screenplay", "contract"), /只用 screenplay 约束验收剧本/);
  assert.match(reviewPrompt("storyboard", "contract"), /逐镜对照源剧本.*节奏时长.*可拍性/);
});

test("sample review timeout is bounded while formal review timeouts stay unchanged", () => {
  const sample = { scope: { kind: "sample" } };
  assert.equal(reviewTimeoutMs(sample, "window"), 300_000);
  assert.equal(reviewTimeoutMs(sample, "series"), 300_000);
  assert.equal(reviewTimeoutMs({}, "window"), 900_000);
  assert.equal(reviewTimeoutMs({}, "series"), 1_800_000);
});

test("completed window checkpoint is persisted and requires identical input and instructions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-review-checkpoint-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "window.json");
  const input = { systemPrompt: "review instruction", prompt: "canonical and full episode text" };
  let calls = 0;
  const runReview = async () => ({ findings: [], summary: `window result ${++calls}` });
  const first = await checkpointWindowReview(file, input, runReview);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ...input, result: first });
  assert.deepEqual(await checkpointWindowReview(file, input, runReview), first);
  assert.equal(calls, 1);

  const changedInput = { ...input, prompt: `${input.prompt}\nchanged episode` };
  assert.equal(
    (await checkpointWindowReview(file, changedInput, runReview)).summary,
    "window result 2",
  );
  const changedInstructions = {
    ...changedInput,
    systemPrompt: `${input.systemPrompt}\noperator note`,
  };
  assert.equal(
    (await checkpointWindowReview(file, changedInstructions, runReview)).summary,
    "window result 3",
  );
  assert.equal(calls, 3);
});

test("failed window review never creates a reusable checkpoint", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-review-failed-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "window.json");
  await assert.rejects(
    checkpointWindowReview(file, { systemPrompt: "review", prompt: "episodes" }, async () => {
      throw new Error("window Reviewer did not submit");
    }),
    /did not submit/,
  );
  assert.equal(fs.existsSync(file), false);
});

test("multiple unrelated local P1 findings remain automatically repairable", () => {
  const plan = semanticRepairPlan([finding("a", 2), finding("b", 8), finding("c", 19)], options());
  assert.equal(plan.action, "repair");
  assert.deepEqual(plan.episodes, [2, 8, 19]);
});

test("P0, upstream and series defects, systemic categories, repeated findings, and exhausted budgets fail closed", () => {
  assert.equal(
    semanticRepairPlan([finding("p0", 2, { severity: "P0" })], options()).action,
    "blocked",
  );
  for (const scope of ["upstream", "series"]) {
    for (const severity of ["P1", "P2"]) {
      assert.equal(
        semanticRepairPlan(
          [finding("global", 2, { scope, severity, disposition: "repair" })],
          options(),
        ).action,
        "blocked",
      );
    }
  }
  assert.equal(
    semanticRepairPlan(
      [
        finding("a", 2, { category: "continuity" }),
        finding("b", 8, { category: "continuity" }),
        finding("c", 19, { category: "continuity" }),
      ],
      options(),
    ).action,
    "blocked",
  );
  assert.equal(
    semanticRepairPlan([finding("repeat", 2)], options({ priorFindingIds: ["repeat"] })).action,
    "blocked",
  );
  assert.equal(semanticRepairPlan([finding("late", 2)], options({ cycle: 3 })).action, "blocked");
});

test("P2 must be explicitly repaired or accepted as non-blocking", () => {
  const accepted = semanticRepairPlan(
    [finding("minor", 2, { severity: "P2", disposition: "accepted_non_blocking" })],
    options(),
  );
  assert.equal(accepted.action, "pass");
  const repair = semanticRepairPlan(
    [finding("minor", 2, { severity: "P2", disposition: "repair" })],
    options(),
  );
  assert.equal(repair.action, "repair");
  assert.throws(
    () =>
      semanticRepairPlan(
        [finding("minor", 2, { severity: "P2", disposition: "unresolved" })],
        options(),
      ),
    /P2 finding requires a disposition/,
  );
  const legacy = semanticRepairPlan(
    [finding("legacy-minor", 2, { severity: "P2", disposition: undefined })],
    options({ requireP2Disposition: false }),
  );
  assert.equal(legacy.action, "pass");
  assert.equal(legacy.findings[0].disposition, "accepted_non_blocking");
});

for (const scope of ["upstream", "series"]) {
  test(`accepted non-blocking P2 with ${scope} scope stays recorded without blocking production`, () => {
    const accepted = finding("accepted-minor", 2, {
      scope,
      severity: "P2",
      disposition: "accepted_non_blocking",
    });
    const alone = semanticRepairPlan([accepted], options());
    assert.equal(alone.action, "pass");
    assert.deepEqual(alone.episodes, []);
    assert.equal(alone.findings[0].id, accepted.id);
    assert.equal(alone.findings[0].disposition, "accepted_non_blocking");

    const mixed = semanticRepairPlan([accepted, finding("local-repair", 8)], options());
    assert.equal(mixed.action, "repair");
    assert.deepEqual(mixed.episodes, [8]);
    assert.deepEqual(
      mixed.findings.map((item) => item.id),
      [accepted.id, "local-repair"],
    );
  });
}

test("planning P1 findings can repair the unapproved planning bundle", () => {
  const plan = semanticRepairPlan(
    [finding("plan", 0, { scope: "upstream" })],
    options({ stage: "planning" }),
  );
  assert.equal(plan.action, "repair");
  assert.deepEqual(plan.episodes, [0]);
});

test("storyboard review payload contains the complete source screenplay", (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-review-payload-")),
    tail = "TAIL_EVIDENCE_MUST_BE_REVIEWED";
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  writeText(
    path.join(runDir, "manifest.json"),
    JSON.stringify({ episodes: 1, productionRoute: "tianshu-original" }),
  );
  writeText(path.join(runDir, "screenplay", "ep-01.md"), `${"剧情。".repeat(5000)}${tail}`);
  writeText(path.join(runDir, "storyboard", "ep-01.md"), "storyboard");
  assert.match(episodePayload(runDir, "storyboard", 1), new RegExp(tail));
});

test("Reviewer must explicitly submit even when it has zero findings", () => {
  assert.throws(
    () => assertReviewerSubmitted(false, "screenplay window Reviewer"),
    /did not submit/,
  );
  assert.doesNotThrow(() => assertReviewerSubmitted(true, "screenplay window Reviewer"));
});

test("final review rejects the observed placeholder summary and accepts a completed clean review", async () => {
  const received = [];
  const tool = seriesReviewSubmissionTool({
    stage: "screenplay",
    totalEpisodes: 3,
    onSubmit: (value) => received.push(value),
  });
  for (const summary of ["待补充", "placeholder", " Placeholder "]) {
    const rejected = await tool.execute("placeholder", { summary, findings: [] });
    assert.equal(rejected.details.accepted, false, `placeholder accepted: ${summary}`);
    assert.equal(rejected.terminate, false);
    assert.equal(received.length, 0);
    assert.match(rejected.content[0].text, /placeholder/);
  }

  const accepted = await tool.execute("complete", {
    summary: "三集主冲突与结尾状态保持一致，未发现需要修复的问题。",
    findings: [],
  });
  assert.equal(accepted.details.accepted, true);
  assert.equal(accepted.terminate, true);
  assert.deepEqual(received, [
    { summary: "三集主冲突与结尾状态保持一致，未发现需要修复的问题。", findings: [] },
  ]);
});

test("final review tool rejects missing P2 disposition before accepting, then accepts corrected submission", async () => {
  const received = [];
  const tool = seriesReviewSubmissionTool({
    stage: "planning",
    totalEpisodes: 3,
    onSubmit: (value) => received.push(value),
  });
  const p2 = finding("source-name-ambiguity", 0, { severity: "P2", disposition: undefined });
  const rejected = await tool.execute("first", { summary: "需要保留原稿姓名疑点", findings: [p2] });
  assert.equal(rejected.terminate, false);
  assert.equal(rejected.details.accepted, false);
  assert.match(rejected.content[0].text, /P2 finding requires a disposition/);
  assert.equal(received.length, 0);
  const accepted = await tool.execute("fixed", {
    summary: "姓名疑点已注明，无新增事实",
    findings: [{ ...p2, disposition: "accepted_non_blocking" }],
  });
  assert.equal(accepted.terminate, true);
  assert.equal(received.length, 1);
  assert.equal(
    semanticRepairPlan(received[0].findings, options({ stage: "planning" })).action,
    "pass",
  );
});

test("re-evaluating a blocked review is not miscounted as a failed repair", () => {
  const existing = finding("phone-state", 2, { scope: "pair" });
  const blocked = { plan: { action: "blocked", findings: [existing] } };
  assert.deepEqual(priorRepairFindingIds(blocked), []);
  assert.equal(
    semanticRepairPlan(
      [existing],
      options({ cycle: 2, priorFindingIds: priorRepairFindingIds(blocked) }),
    ).action,
    "repair",
  );
  const repaired = { plan: { action: "repair", findings: [existing] } };
  assert.deepEqual(priorRepairFindingIds(repaired, { repairPending: true }), []);
  assert.equal(
    semanticRepairPlan(
      [existing],
      options({
        cycle: 2,
        priorFindingIds: priorRepairFindingIds(repaired, { repairPending: true }),
      }),
    ).action,
    "repair",
  );
  assert.equal(
    semanticRepairPlan(
      [existing],
      options({ cycle: 2, priorFindingIds: priorRepairFindingIds(repaired) }),
    ).action,
    "blocked",
  );
});

const candidate = {
  id: "ep21-quantity",
  episode: 21,
  shotId: "ep21-s01",
  kind: "bilingual_quantity",
  quotes: [{ label: "dialogue", text: "她说已经过去三天。 EN: It has been three hours." }],
};
const decision = (disposition, overrides = {}) => ({
  candidateId: candidate.id,
  disposition,
  evidence: candidate.quotes[0].text,
  reason: "核对所给双语原文与上下文",
  ...overrides,
});

test("focused candidates require complete, quoted decisions without converting unknowns into findings", () => {
  assert.throws(
    () => validateCandidateDispositions([candidate], [], []),
    /incomplete.*ep21-quantity/,
  );
  assert.throws(
    () =>
      validateCandidateDispositions([candidate], [decision("dismissed"), decision("dismissed")]),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateCandidateDispositions(
        [candidate],
        [decision("dismissed", { evidence: "Invented supporting text" })],
      ),
    /verbatim/,
  );
  assert.throws(
    () =>
      validateCandidateDispositions(
        [candidate],
        [decision("finding", { findingId: "wrong-episode" })],
        [finding("wrong-episode", 22)],
      ),
    /episode 21/,
  );
  const quotedFragment = decision("dismissed", { evidence: "It has been three hours." });
  assert.deepEqual(validateCandidateDispositions([candidate], [quotedFragment]), [quotedFragment]);
  const unknown = decision("needs_source");
  assert.deepEqual(validateCandidateDispositions([candidate], [unknown]), [unknown]);
  assert.deepEqual(candidateReviewSummary([candidate], [unknown]), {
    candidates: 1,
    reviewed: 1,
    findings: 0,
    dismissed: 0,
    needsSource: 1,
    unknownCandidateIds: [candidate.id],
  });
  assert.deepEqual(validateCandidateDispositions([], undefined, []), []);
});

test("final review cannot silently drop a confirmed window candidate or retain an unread repair finding", async () => {
  const readEpisodes = new Set(),
    received = [];
  const tool = seriesReviewSubmissionTool({
    stage: "storyboard",
    totalEpisodes: 32,
    candidates: [candidate],
    readEpisodes,
    onSubmit: (value) => received.push(value),
  });
  const params = { summary: "Completed focused final review", findings: [] };
  const missing = await tool.execute("missing", params);
  assert.equal(missing.terminate, false);
  assert.match(missing.content[0].text, /missing candidate dispositions/);
  const repair = finding("quantity-repair", 21);
  const confirmed = {
    ...params,
    findings: [repair],
    candidateDispositions: [decision("finding", { findingId: repair.id })],
  };
  const unread = await tool.execute("unread", confirmed);
  assert.equal(unread.details.accepted, false);
  assert.match(unread.content[0].text, /read_review_episodes/);
  assert.equal(received.length, 0);
  readEpisodes.add(21);
  assert.equal((await tool.execute("read", confirmed)).details.accepted, true);
  const dismissed = { ...params, candidateDispositions: [decision("dismissed")] };
  assert.equal((await tool.execute("dismissed", dismissed)).details.accepted, true);
  const unknown = { ...params, candidateDispositions: [decision("needs_source")] };
  assert.equal((await tool.execute("unknown", unknown)).details.accepted, true);
  assert.equal(
    semanticRepairPlan(received.at(-1).findings, options({ stage: "storyboard" })).action,
    "pass",
  );
});

test("read evidence is required for P1 and repair P2 while planning and accepted non-blocking findings stay compatible", async () => {
  for (const severity of ["P1", "P2"]) {
    const tool = seriesReviewSubmissionTool({
      stage: "screenplay",
      totalEpisodes: 3,
      readEpisodes: new Set(),
      onSubmit() {},
    });
    const params = {
      summary: "Completed focused review",
      findings: [finding("unread-repair", 2, { severity })],
    };
    assert.equal((await tool.execute("unread", params)).details.accepted, false);
    if (severity === "P2") {
      params.findings[0].disposition = "accepted_non_blocking";
      assert.equal((await tool.execute("non-blocking", params)).details.accepted, true);
    }
  }
  const planning = seriesReviewSubmissionTool({
    stage: "planning",
    totalEpisodes: 3,
    readEpisodes: new Set(),
    onSubmit() {},
  });
  assert.equal(
    (
      await planning.execute("planning", {
        summary: "Unapproved planning repair",
        findings: [finding("plan", 0)],
      })
    ).details.accepted,
    true,
  );
});
