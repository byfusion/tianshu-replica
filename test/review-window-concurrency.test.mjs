import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { loadManifest, readJson, readText, writeJson, writeText } from "../src/core.mjs";
import { createProductionContract } from "../src/production-contract.mjs";
import { reviewStage } from "../src/semantic-review.mjs";
import { executionContractStatus, writeExecutionContract } from "../src/execution-contract.mjs";

function fixture(
  t,
  {
    episodes = 43,
    provider = "deepseek",
    legacyUnbound = false,
    stage = "screenplay",
    storyboardText = {},
  } = {},
) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-window-concurrency-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  writeJson(path.join(runDir, "manifest.json"), {
    episodes,
    state: `${stage}_reviewing`,
    reviewCycles: { [stage]: 1 },
  });
  writeJson(path.join(runDir, "canonical/production-contract.json"), createProductionContract());
  if (!legacyUnbound)
    writeExecutionContract(runDir, {
      model: provider === "deepseek" ? "deepseek" : provider === "openai-codex" ? "gpt" : "kimi",
      agentDir: path.join(runDir, "offline-agent"),
      env: {},
    });
  writeText(path.join(runDir, "canonical/market-contract.md"), "Synthetic review contract");
  writeJson(path.join(runDir, "canonical/market.json"), { country: "United States" });
  for (let episode = 1; episode <= episodes; episode++) {
    for (const folder of ["screenplay", "storyboard"])
      writeText(
        path.join(runDir, folder, `ep-${String(episode).padStart(2, "0")}.md`),
        `Synthetic ${folder} episode ${episode}`,
      );
  }
  for (const [episode, text] of Object.entries(storyboardText)) {
    writeText(path.join(runDir, "storyboard", `ep-${String(episode).padStart(2, "0")}.md`), text);
  }
  const preservedFiles = [
    "manifest.json",
    ...["round-1", "latest", "final"].map((name) => `reviews/${stage}-${name}.json`),
  ];
  for (const file of preservedFiles.slice(1))
    writeJson(path.join(runDir, file), {
      previousReview: true,
      plan: { action: "pass", findings: [] },
    });
  const before = preservedFiles.map((file) => readText(path.join(runDir, file)));
  const calls = [],
    state = { active: 0, peak: 0, seriesCalls: 0 };
  // Only model I/O is replaced. Candidate extraction, checkpoints, metrics,
  // submission tools, reports and manifest writes execute through normal imports.
  const modelIO = {
    createSession: async (options) => {
      if (options.role === state.failSessionRole)
        throw new Error("offline review session creation failure");
      const match = options.role.match(/-window-review-(\d+)-(\d+)-/);
      const gate = Promise.withResolvers();
      const call = {
        options,
        gate,
        from: match ? Number(match[1]) : null,
        to: match ? Number(match[2]) : null,
        disposed: false,
      };
      calls.push(call);
      return {
        session: {
          call,
          dispose() {
            call.disposed = true;
          },
        },
        metrics: { prompts: 1 },
      };
    },
    prompt: async (session, _metrics, prompt) => {
      const call = session.call;
      call.prompt = prompt;
      if (call.from !== null) state.peak = Math.max(state.peak, ++state.active);
      else {
        state.seriesCalls++;
        call.windows =
          stage === "planning" ? [] : JSON.parse(prompt.split("Digest-bound window reports:\n")[1]);
      }
      try {
        await call.gate.promise;
        const params =
          call.from === null
            ? { summary: "Completed independent final review", findings: state.finalFindings || [] }
            : {
                summary: `Completed window ${call.from}-${call.to}`,
                findings: [],
                episodeSummaries: Array.from({ length: call.to - call.from + 1 }, (_, index) => ({
                  episode: call.from + index,
                  summary: "Synthetic episode review summary",
                  hook: "hook",
                  endingState: "ending",
                  promotionalBeat: "promotion",
                })),
              };
        await (call.from === null ? state.beforeSeriesSubmit : state.beforeWindowSubmit)?.(
          call,
          params,
        );
        const submitted = await call.options.customTools[0].execute("offline-submit", params);
        assert.equal(submitted.terminate, true);
      } finally {
        if (call.from !== null) state.active--;
      }
    },
  };
  return {
    runDir,
    calls,
    state,
    start: (options) => reviewStage(runDir, stage, { ...options, ...modelIO }),
    windows: () => calls.filter((call) => call.from !== null),
    series: () => calls.findLast((call) => call.from === null),
    events: () =>
      fs.existsSync(path.join(runDir, "events.jsonl"))
        ? readText(path.join(runDir, "events.jsonl"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    assertUncommitted() {
      assert.deepEqual(
        preservedFiles.map((file) => readText(path.join(runDir, file))),
        before,
      );
      assert.equal(fs.existsSync(path.join(runDir, `reviews/${stage}-round-2.json`)), false);
    },
  };
}

test("DeepSeek and GPT run eight independent windows and wait for all windows before one final review", async (t) => {
  for (const provider of ["deepseek", "openai-codex"]) {
    for (const stage of ["screenplay", "storyboard"]) {
      const f = fixture(t, { provider, stage });
      const pending = f.start();
      await tick();
      assert.equal(f.windows().length, 8);
      assert.equal(f.state.active, 8);
      f.windows()[7].gate.resolve();
      await tick();
      assert.equal(f.windows().length, 9);
      assert.equal(f.state.active, 8);
      const firstWindow = f.windows()[0],
        tailWindow = f.windows()[8];
      assert.equal(tailWindow.to - tailWindow.from + 1, 3);
      assert.equal(
        JSON.stringify(firstWindow.options.customTools[0].parameters),
        JSON.stringify(tailWindow.options.customTools[0].parameters),
        "short final windows retain the same tool prefix",
      );
      assert.equal(firstWindow.options.systemPrompt, tailWindow.options.systemPrompt);
      assert.equal(
        firstWindow.prompt.split("Review window:\n")[0],
        tailWindow.prompt.split("Review window:\n")[0],
        "shared canonical context precedes window-specific text",
      );
      const incomplete = await tailWindow.options.customTools[0].execute("incomplete-tail", {
        episodeSummaries: [{ episode: tailWindow.from }],
      });
      assert.match(
        incomplete.content[0].text,
        /^REJECTED episode summaries must cover the review window in order/,
      );
      for (const call of f.windows().slice(1).reverse()) call.gate.resolve();
      await tick();
      assert.equal(f.state.active, 1);
      assert.equal(f.state.seriesCalls, 0);
      f.assertUncommitted();
      f.windows()[0].gate.resolve();
      await tick();
      assert.equal(f.state.active, 0);
      assert.equal(f.state.peak, 8);
      assert.equal(f.state.seriesCalls, 1);
      assert.deepEqual(
        f.series().windows.map(({ from, to }) => [from, to]),
        [
          [1, 5],
          [6, 10],
          [11, 15],
          [16, 20],
          [21, 25],
          [26, 30],
          [31, 35],
          [36, 40],
          [41, 43],
        ],
      );
      assert.ok(f.windows().every((call) => call.disposed));
      f.assertUncommitted();
      f.series().gate.resolve();
      const report = await pending;
      assert.equal(report.cycle, 2);
      assert.equal(report.plan.action, "pass");
      assert.equal(loadManifest(f.runDir).reviewCycles[stage], 2);
      assert.deepEqual(
        readJson(path.join(f.runDir, `reviews/${stage}-final.json`)).windowReviews.map(
          ({ from }) => from,
        ),
        [1, 6, 11, 16, 21, 26, 31, 36, 41],
      );
      assert.equal(fs.readdirSync(path.join(f.runDir, "metrics")).length, 10);
      const events = f.events();
      assert.equal(events.filter((event) => event.type === "review_window_started").length, 9);
      assert.equal(events.filter((event) => event.type === "review_window_finished").length, 9);
      let active = 0,
        peak = 0;
      for (const event of events) {
        assert.deepEqual(Object.keys(event).sort(), [
          "at",
          "cycle",
          "from",
          "outcome",
          "role",
          "run",
          "stage",
          "to",
          "type",
        ]);
        assert.equal(event.run, path.basename(f.runDir));
        assert.equal(event.stage, stage);
        assert.equal(event.cycle, 2);
        assert.equal(event.role, `${stage}-window-review-${event.from}-${event.to}-cycle-2`);
        assert.ok(Number.isFinite(Date.parse(event.at)));
        if (event.type === "review_window_started") {
          active++;
          peak = Math.max(peak, active);
          assert.equal(event.outcome, "running");
        } else {
          active--;
          assert.equal(event.outcome, "completed");
        }
      }
      assert.equal(peak, 8);
      assert.equal(active, 0);
      if (provider === "openai-codex") {
        assert.equal(
          f.series().options.thinkingLevel,
          undefined,
          "GPT keeps its adapter reasoning policy",
        );
        assert.equal(f.series().options.maxOutputTokens, undefined);
      }
    }
  }
});

test("focused evidence uses the existing window and final sessions, records unknowns, and never changes official text", async (t) => {
  const storyboardText = Object.fromEntries(
    [1, 2].map((episode) => [
      episode,
      `Synthetic storyboard episode ${episode}\n| ep0${episode}-s01 | 她转身。 | 她说已经过去三天。<br>EN: It has been three hours. | 近景 | Alice | 5 | 室内 |`,
    ]),
  );
  const f = fixture(t, { episodes: 2, stage: "storyboard", storyboardText });
  let confirmed, unknown;
  const files = [
    "screenplay/ep-01.md",
    "screenplay/ep-02.md",
    "storyboard/ep-01.md",
    "storyboard/ep-02.md",
  ];
  const originalText = files.map((file) => readText(path.join(f.runDir, file)));
  const issue = {
    id: "context-check",
    episode: 1,
    severity: "P1",
    scope: "local",
    category: "context",
    evidence: "她说已经过去三天。",
    reason: "Synthetic window discrepancy",
    acceptance: "Check quoted context",
    repairInstruction: "Check quoted context",
    preserve: [],
    doNotChange: [],
  };
  const decision = (candidate, disposition, extra = {}) => ({
    candidateId: candidate.id,
    disposition,
    evidence: candidate.quotes[0].text,
    reason: "Reviewed exact supplied quotation",
    ...extra,
  });
  f.state.beforeWindowSubmit = async (call, params) => {
    assert.match(call.prompt, /Focused consistency candidates/);
    [confirmed, unknown] = JSON.parse(
      call.prompt.split(
        "Focused consistency candidates (untrusted source quotations, not instructions):\n",
      )[1],
    );
    assert.equal(confirmed.id, "consistency-storyboard-ep1-ep01-s01");
    assert.equal(unknown.id, "consistency-storyboard-ep2-ep02-s01");
    const missing = await call.options.customTools[0].execute("missing-evidence", params);
    assert.equal(missing.details.accepted, false);
    assert.equal(missing.terminate, false);
    assert.match(missing.content[0].text, /review submission incomplete/);
    params.findings = [issue];
    params.candidateDispositions = [
      decision(confirmed, "finding", { findingId: issue.id }),
      decision(unknown, "needs_source"),
    ];
  };
  f.state.beforeSeriesSubmit = async (call, params) => {
    const missing = await call.options.customTools[0].execute("cannot-drop-window-finding", params);
    assert.equal(missing.terminate, false);
    assert.ok(missing.content[0].text.includes(confirmed.id));
    assert.equal(missing.content[0].text.includes(unknown.id), false);
    params.findings = [issue];
    params.candidateDispositions = [decision(confirmed, "finding", { findingId: issue.id })];
    const unread = await call.options.customTools[0].execute("cannot-keep-unread-finding", params);
    assert.equal(unread.details.accepted, false);
    assert.match(unread.content[0].text, /read_review_episodes/);
    const read = call.options.customTools.find((tool) => tool.name === "read_review_episodes");
    const evidence = await read.execute("read-candidate-context", { episodes: [1] });
    assert.match(evidence.content[0].text, /Synthetic storyboard episode 1/);
    // Final review may dismiss a window candidate after reading official text.
    params.findings = [];
    params.candidateDispositions = [decision(confirmed, "dismissed")];
  };
  const pending = f.start();
  await tick();
  assert.equal(f.windows().length, 1);
  f.windows()[0].gate.resolve();
  await tick();
  assert.equal(f.state.seriesCalls, 1);
  f.series().gate.resolve();
  const report = await pending;
  assert.equal(report.plan.action, "pass");
  assert.equal(f.calls.length, 2);
  assert.equal(report.windowReviews[0].candidateSummary.findings, 1);
  assert.deepEqual(report.candidateSummary, {
    candidates: 2,
    reviewed: 2,
    findings: 0,
    dismissed: 1,
    needsSource: 1,
    unknownCandidateIds: [unknown.id],
  });
  assert.deepEqual(report.readEpisodes, [1]);
  assert.deepEqual(
    report.candidateDispositions.map((decision) => decision.disposition),
    ["dismissed", "needs_source"],
  );
  assert.equal(report.seriesCandidateDispositions.length, 1);
  assert.deepEqual(
    files.map((file) => readText(path.join(f.runDir, file))),
    originalText,
  );
  assert.equal(
    readJson(path.join(f.runDir, "reviews/storyboard-final.json")).candidateSummary.needsSource,
    1,
  );
});

test("other providers keep windows serial and planning keeps its single independent final review", async (t) => {
  const f = fixture(t, { episodes: 11, provider: "kimi-coding", stage: "storyboard" });
  const pending = f.start();
  for (let index = 0; index < 3; index++) {
    await tick();
    assert.equal(f.windows().length, index + 1);
    assert.equal(f.state.active, 1);
    assert.equal(f.state.seriesCalls, 0);
    f.windows()[index].gate.resolve();
  }
  await tick();
  assert.equal(f.state.peak, 1);
  assert.equal(f.state.seriesCalls, 1);
  assert.equal(f.series().options.maxOutputTokens, undefined);
  f.series().gate.resolve();
  await pending;

  const planning = fixture(t, { stage: "planning" });
  const planned = planning.start();
  await tick();
  assert.equal(planning.windows().length, 0);
  assert.equal(planning.state.seriesCalls, 1);
  assert.equal(planning.series().options.maxOutputTokens, 65536);
  assert.equal(planning.series().options.thinkingLevel, "high");
  planning.assertUncommitted();
  planning.series().gate.resolve();
  assert.equal((await planned).cycle, 2);
});

test("unbound legacy stub reviews stay serial without inheriting DeepSeek options from today's environment", async (t) => {
  const previousProvider = process.env.TIANSHU_MODEL_PROVIDER;
  process.env.TIANSHU_MODEL_PROVIDER = "deepseek";
  t.after(() => {
    if (previousProvider === undefined) delete process.env.TIANSHU_MODEL_PROVIDER;
    else process.env.TIANSHU_MODEL_PROVIDER = previousProvider;
  });
  const f = fixture(t, { episodes: 6, provider: "openai-codex", legacyUnbound: true });
  const pending = f.start();
  await tick();
  assert.equal(f.windows().length, 1);
  f.windows()[0].gate.resolve();
  await tick();
  assert.equal(f.windows().length, 2);
  assert.equal(f.state.peak, 1);
  f.windows()[1].gate.resolve();
  await tick();
  assert.equal(f.series().options.thinkingLevel, undefined);
  assert.equal(f.series().options.maxOutputTokens, undefined);
  f.series().gate.resolve();
  assert.equal((await pending).plan.action, "pass");
  assert.equal(executionContractStatus(f.runDir).status, "legacy-unbound");
});

test("window failure drains in-flight reviews without final submission and resumes unchanged successful checkpoints", async (t) => {
  const f = fixture(t, { provider: "openai-codex" });
  let settled = false;
  const failed = f.start().then(
    () => assert.fail("window failure must reject"),
    (error) => {
      settled = true;
      return error;
    },
  );
  await tick();
  f.windows()[2].gate.reject(new Error("synthetic window failure"));
  await tick();
  assert.equal(settled, false);
  assert.equal(f.windows().length, 8);
  for (const call of f.windows()) if (call.from !== 11) call.gate.resolve();
  assert.match((await failed).message, /synthetic window failure/);
  assert.equal(f.state.active, 0);
  assert.equal(f.windows().length, 8);
  assert.equal(f.state.seriesCalls, 0);
  assert.ok(f.calls.every((call) => call.disposed));
  f.assertUncommitted();
  const failedEvents = f.events();
  assert.equal(failedEvents.filter((event) => event.type === "review_window_finished").length, 8);
  assert.equal(failedEvents.filter((event) => event.outcome === "failed").length, 1);
  const checkpointsDir = path.join(f.runDir, "reviews/checkpoints");
  const checkpoints = new Map(
    fs.readdirSync(checkpointsDir).map((file) => [file, readText(path.join(checkpointsDir, file))]),
  );
  assert.equal(checkpoints.size, 7);
  assert.equal(
    fs.existsSync(path.join(checkpointsDir, "screenplay-window-11-15-cycle-2.json")),
    false,
  );
  const resumed = f.start();
  await tick();
  assert.deepEqual(
    f
      .windows()
      .slice(8)
      .map((call) => call.from),
    [11, 41],
  );
  for (const call of f.windows().slice(8)) call.gate.resolve();
  await tick();
  assert.equal(f.state.seriesCalls, 1);
  f.series().gate.resolve();
  assert.equal((await resumed).cycle, 2);
  for (const [file, content] of checkpoints)
    assert.equal(readText(path.join(checkpointsDir, file)), content);
  assert.equal(
    readJson(path.join(f.runDir, "metrics/screenplay-window-review-11-15-cycle-2.json")).attempts
      .length,
    2,
  );
  assert.equal(
    readJson(path.join(f.runDir, "metrics/screenplay-window-review-1-5-cycle-2.json")).attempts
      .length,
    1,
  );
  const newStarts = f
    .events()
    .slice(failedEvents.length)
    .filter((event) => event.type === "review_window_started");
  assert.deepEqual(
    newStarts.map((event) => event.from),
    [11, 41],
    "cached successful windows do not emit new execution starts",
  );
});

test("a failed window session creation records failure without a final review", async (t) => {
  const f = fixture(t, { episodes: 1, provider: "openai-codex" });
  f.state.failSessionRole = "screenplay-window-review-1-1-cycle-2";
  await assert.rejects(f.start(), /offline review session creation failure/);
  assert.deepEqual(
    f.events().map(({ type, outcome }) => [type, outcome]),
    [
      ["review_window_started", "running"],
      ["review_window_finished", "failed"],
    ],
  );
  assert.equal(f.state.seriesCalls, 0);
  assert.equal(
    fs.existsSync(path.join(f.runDir, "reviews/checkpoints/screenplay-window-1-1-cycle-2.json")),
    false,
  );
  f.assertUncommitted();
});

test("failed final review preserves manifest, prior reports and completed window checkpoints", async (t) => {
  const f = fixture(t, { episodes: 6 });
  const failed = f.start().then(
    () => assert.fail("final failure must reject"),
    (error) => error,
  );
  await tick();
  for (const call of f.windows()) call.gate.resolve();
  await tick();
  assert.equal(f.state.seriesCalls, 1);
  f.series().gate.reject(new Error("synthetic final failure"));
  assert.match((await failed).message, /synthetic final failure/);
  f.assertUncommitted();
  assert.equal(fs.readdirSync(path.join(f.runDir, "reviews/checkpoints")).length, 2);
  assert.ok(f.calls.every((call) => call.disposed));
  assert.equal(
    readJson(path.join(f.runDir, "metrics/screenplay-series-review-cycle-2.json")).outcome,
    "failed",
  );
});

test("final review alone receives operator notes and a read-only tool for complete official episode context", async (t) => {
  for (const stage of ["screenplay", "storyboard", "planning"]) {
    const f = fixture(t, { episodes: 6, stage });
    const operatorNote = "OFFLINE_OPERATOR_EVIDENCE_NOTE";
    const pending = f.start({ operatorNote });
    await tick();
    for (const call of f.windows()) {
      assert.equal(call.options.systemPrompt.includes(operatorNote), false);
      assert.equal(call.prompt.includes(operatorNote), false);
      assert.deepEqual(call.options.toolNames, ["submit_review"]);
      call.gate.resolve();
    }
    await tick();
    const { options } = f.series();
    assert.ok(options.systemPrompt.includes(operatorNote));
    assert.deepEqual(
      options.toolNames,
      stage === "planning"
        ? ["submit_series_review"]
        : ["submit_series_review", "read_review_episodes"],
    );
    if (stage !== "planning") {
      const read = options.customTools.find((tool) => tool.name === "read_review_episodes");
      const originals = ["screenplay", "storyboard"].map((folder) =>
        readText(path.join(f.runDir, folder, "ep-06.md")),
      );
      const result = await read.execute("offline-read", { episodes: [1, 6] });
      assert.equal(result.terminate, false);
      assert.match(result.content[0].text, /Synthetic screenplay episode 1/);
      assert.match(result.content[0].text, /Synthetic screenplay episode 6/);
      if (stage === "storyboard") {
        assert.match(result.content[0].text, /SOURCE SCREENPLAY/);
        assert.match(result.content[0].text, /Synthetic storyboard episode 6/);
      } else assert.doesNotMatch(result.content[0].text, /Synthetic storyboard/);
      assert.equal(read.parameters.properties.episodes.items.minimum, 1);
      assert.equal(read.parameters.properties.episodes.items.maximum, 6);
      assert.deepEqual(
        ["screenplay", "storyboard"].map((folder) =>
          readText(path.join(f.runDir, folder, "ep-06.md")),
        ),
        originals,
      );
      assert.match(options.systemPrompt, /保留任何 P1.*必须调用 read_review_episodes/);
      assert.match(
        options.systemPrompt,
        /窗口摘要省略的动作和正式稿已有的未知说明均不能虚构为缺陷/,
      );
      assert.match(
        options.systemPrompt,
        /仅当必须修改已批准的 canonical 规划或生产合同时用 upstream/,
      );
      assert.match(options.systemPrompt, /不能因为举证引用多集就用 series/);
    }
    f.assertUncommitted();
    f.series().gate.resolve();
    await pending;
  }
});

test("explicit blocked re-review reuses only unchanged previous windows and preserves the previous round", async (t) => {
  for (const { changed, operatorNote } of [
    { changed: false, operatorNote: "Review source evidence" },
    { changed: true, operatorNote: "Review source evidence" },
    { changed: false, operatorNote: "" },
  ]) {
    const f = fixture(t, { episodes: 6 });
    f.state.finalFindings = [
      {
        id: "synthetic-blocker",
        episode: 1,
        severity: "P0",
        scope: "upstream",
        category: "contract",
        evidence: "Synthetic contract evidence",
        reason: "Synthetic contract conflict",
        acceptance: "Synthetic acceptance",
        repairInstruction: "Synthetic instruction",
        preserve: [],
        doNotChange: [],
        disposition: "repair",
      },
    ];
    const first = f.start();
    await tick();
    for (const call of f.windows()) call.gate.resolve();
    await tick();
    f.series().gate.resolve();
    assert.equal((await first).plan.action, "blocked");
    const previousReport = readText(path.join(f.runDir, "reviews/screenplay-round-2.json"));
    const checkpointDir = path.join(f.runDir, "reviews/checkpoints");
    const previousFiles = fs.readdirSync(checkpointDir);
    const previousContents = previousFiles.map((file) => readText(path.join(checkpointDir, file)));
    if (changed)
      writeText(
        path.join(f.runDir, "screenplay/ep-06.md"),
        "Changed official screenplay episode 6",
      );
    f.state.finalFindings = [];
    const repeated = f.start({ operatorNote });
    await tick();
    const newWindows = f.windows().slice(2);
    assert.deepEqual(
      newWindows.map((call) => call.from),
      !operatorNote ? [1, 6] : changed ? [6] : [],
    );
    if (newWindows.length) assert.equal(f.state.seriesCalls, 1);
    for (const call of newWindows) call.gate.resolve();
    await tick();
    assert.equal(f.state.seriesCalls, 2);
    assert.equal(loadManifest(f.runDir).reviewCycles.screenplay, 2);
    assert.deepEqual(
      f.series().windows.map(({ from }) => from),
      [1, 6],
    );
    f.series().gate.resolve();
    assert.equal((await repeated).cycle, 3);
    assert.equal(readText(path.join(f.runDir, "reviews/screenplay-round-2.json")), previousReport);
    assert.deepEqual(
      previousFiles.map((file) => readText(path.join(checkpointDir, file))),
      previousContents,
    );
    const firstWindow = readJson(path.join(checkpointDir, "screenplay-window-1-5-cycle-3.json"));
    assert.equal(
      firstWindow.reusedFrom,
      operatorNote ? path.join(checkpointDir, "screenplay-window-1-5-cycle-2.json") : undefined,
    );
    const secondWindow = readJson(path.join(checkpointDir, "screenplay-window-6-6-cycle-3.json"));
    assert.equal(
      secondWindow.reusedFrom,
      operatorNote && !changed
        ? path.join(checkpointDir, "screenplay-window-6-6-cycle-2.json")
        : undefined,
    );
  }
});
