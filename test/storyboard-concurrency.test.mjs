import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { produceStoryboards } from "../src/agents.mjs";
import { loadManifest, saveManifest, STORYBOARD_HEADER } from "../src/core.mjs";
import {
  agentFixture,
  invokeAgentTool,
  screenplayFixture,
  storyboardFixture,
} from "./helpers/agent-fixtures.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function storyboardRun(
  t,
  {
    episodes = 45,
    provider = "deepseek",
    legacyUnbound = false,
    seeded = [],
    stale = [],
    failEpisode = null,
    failSessionRole = null,
    omitSubmit = null,
    omitWrite = null,
    beforeEpisode = tick,
    markdownForEpisode = storyboardFixture,
    sourceForEpisode = screenplayFixture,
    onChecked = () => {},
  } = {},
) {
  const fixture = agentFixture(t, {
    episodes,
    provider,
    legacyUnbound,
    state: "screenplay_passed",
  });
  const { dir, read, write } = fixture;
  const calls = [],
    workDirs = [];
  let activeSessions = 0,
    peakSessions = 0,
    seeding = false;
  for (let episode = 1; episode <= episodes; episode++) {
    write(`screenplay/ep-${String(episode).padStart(2, "0")}.md`, sourceForEpisode(episode));
  }
  const dependencies = {
    createSession: async ({ role, customTools }) => {
      if (!seeding && role === failSessionRole) throw new Error("offline session creation failure");
      workDirs.push(path.join(dir, "work", role));
      activeSessions++;
      peakSessions = Math.max(peakSessions, activeSessions);
      return {
        session: {
          role,
          tools: customTools,
          prompting: false,
          dispose() {
            assert.equal(
              loadManifest(dir).state,
              "storyboard_producing",
              "review must wait for all active sessions",
            );
            activeSessions--;
          },
        },
        metrics: { role },
      };
    },
    prompt: async (session, _metrics, prompt) => {
      const episode = Number(prompt.match(/只制作第 (\d+) 集/)[1]);
      assert.equal(session.prompting, false, "episodes within one session must remain serial");
      assert.equal(loadManifest(dir).state, "storyboard_producing");
      session.prompting = true;
      calls.push({ episode, role: session.role });
      try {
        if (!seeding) await beforeEpisode(episode, session.role);
        if (!seeding && episode === failEpisode) throw new Error(`offline failure EP${episode}`);
        if (!seeding && episode === omitSubmit) return;
        if (!seeding && episode === omitWrite) {
          assert.match(
            (await invokeAgentTool(session, "run_checks")).content[0].text,
            /^FAIL:.*write_draft/,
          );
          assert.match(
            (await invokeAgentTool(session, "submit_storyboard", { episode })).content[0].text,
            /^REJECTED.*write_draft/,
          );
          return;
        }
        await invokeAgentTool(session, "write_draft", { markdown: markdownForEpisode(episode) });
        const draft = read(`work/${session.role}/draft.md`);
        assert.match((await invokeAgentTool(session, "run_checks")).content[0].text, /^PASS/);
        if (!seeding) onChecked(draft);
        assert.match(
          (await invokeAgentTool(session, "submit_storyboard", { episode })).content[0].text,
          /^ACCEPTED/,
        );
        assert.equal(
          read(`storyboard/ep-${String(episode).padStart(2, "0")}.md`),
          draft,
          "checked bytes must be promoted unchanged",
        );
        if (!seeding) onChecked(draft);
      } finally {
        session.prompting = false;
      }
    },
  };
  if (seeded.length) {
    // Seed resumable tasks through the real submission tools. Their artifact
    // metadata is produced by the runtime, rather than recreated by this test.
    seeding = true;
    await produceStoryboards(dir, dependencies);
    for (let episode = 1; episode <= episodes; episode++) {
      if (seeded.includes(episode)) continue;
      const label = String(episode).padStart(2, "0");
      fs.unlinkSync(path.join(dir, "storyboard", `ep-${label}.md`));
      fs.unlinkSync(path.join(dir, "tasks", `storyboard-ep-${label}.json`));
    }
    for (const name of fs.readdirSync(path.join(dir, "metrics")))
      fs.unlinkSync(path.join(dir, "metrics", name));
    fs.writeFileSync(path.join(dir, "events.jsonl"), "");
    saveManifest(dir, { ...loadManifest(dir), state: "screenplay_passed" });
    calls.length = 0;
    workDirs.length = 0;
    peakSessions = 0;
    seeding = false;
  }
  for (const episode of stale) {
    const label = String(episode).padStart(2, "0");
    write(`storyboard/ep-${label}.md`, `existing storyboard EP${episode}`);
    write(`tasks/storyboard-ep-${label}.json`, {
      state: "stale",
      repairInstruction: "bounded repair",
    });
  }
  return {
    ...fixture,
    async run() {
      // Scheduling follows the frozen identity even when the environment changes.
      const originalProvider = process.env.TIANSHU_MODEL_PROVIDER;
      process.env.TIANSHU_MODEL_PROVIDER = provider === "deepseek" ? "kimi-coding" : "deepseek";
      try {
        await produceStoryboards(dir, dependencies);
      } finally {
        if (originalProvider === undefined) delete process.env.TIANSHU_MODEL_PROVIDER;
        else process.env.TIANSHU_MODEL_PROVIDER = originalProvider;
      }
    },
    calls,
    workDirs,
    get manifest() {
      return loadManifest(dir);
    },
    get batchesDone() {
      const directory = path.join(dir, "metrics");
      return fs.existsSync(directory)
        ? fs.readdirSync(directory).map((file) => JSON.parse(read(`metrics/${file}`)))
        : [];
    },
    get events() {
      return fixture.exists("events.jsonl")
        ? read("events.jsonl").split("\n").filter(Boolean).map(JSON.parse)
        : [];
    },
    peak: () => peakSessions,
    active: () => activeSessions,
  };
}

test("DeepSeek and GPT storyboard lanes reuse sessions for at most five episodes and retain passed tasks", async (t) => {
  for (const provider of ["deepseek", "openai-codex"]) {
    const state = await storyboardRun(t, { seeded: [2], provider });
    await state.run();
    assert.equal(state.peak(), 8);
    assert.equal(new Set(state.workDirs).size, state.workDirs.length);
    assert.equal(state.calls.length, 44);
    assert.equal(new Set(state.calls.map((item) => item.episode)).size, 44);
    assert.ok(!state.calls.some((item) => item.episode === 2));
    assert.equal(state.read("storyboard/ep-02.md"), `${storyboardFixture(2)}\n`);
    for (const role of new Set(state.calls.map((item) => item.role))) {
      const episodes = state.calls.filter((item) => item.role === role).map((item) => item.episode);
      assert.deepEqual(
        episodes,
        [...episodes].sort((a, b) => a - b),
      );
      assert.ok(episodes.length <= 5, "one session retains no more than five episode prompts");
    }
    assert.ok(
      state.calls.some(({ role }) => state.calls.filter((item) => item.role === role).length === 5),
    );
    assert.ok(
      state.calls.some(({ role }) => /-session-2$/.test(role)),
      "lanes rotate a full session before taking more work",
    );
    assert.equal(state.batchesDone.length, state.workDirs.length);
    assert.ok(state.batchesDone.every((item) => item.outcome === "completed"));
    assert.equal(state.manifest.state, "storyboard_reviewing");
    assert.equal(
      state.events.filter((event) => event.type === "storyboard_batch_started").length,
      state.workDirs.length,
    );
    assert.equal(
      state.events.filter((event) => event.type === "storyboard_batch_finished").length,
      state.workDirs.length,
    );
    let active = 0,
      peak = 0;
    for (const event of state.events) {
      assert.deepEqual(Object.keys(event).sort(), [
        "at",
        "episodes",
        "lane",
        "outcome",
        "role",
        "run",
        "sessionNumber",
        "type",
      ]);
      assert.equal(event.run, path.basename(state.dir));
      assert.equal(event.role, `storyboard-lane-${event.lane}-session-${event.sessionNumber}`);
      assert.ok(Number.isFinite(Date.parse(event.at)));
      const assigned = state.calls
        .filter((call) => call.role === event.role)
        .map((call) => call.episode);
      if (event.type === "storyboard_batch_started") {
        active++;
        peak = Math.max(peak, active);
        assert.equal(event.outcome, "running");
        assert.deepEqual(Array.from(event.episodes), assigned.slice(0, 1));
      } else {
        active--;
        assert.equal(event.outcome, "completed");
        assert.deepEqual(Array.from(event.episodes), assigned);
      }
    }
    assert.equal(peak, 8);
    assert.equal(active, 0);
  }
});

test("thirty episodes start eight lanes and free lanes keep taking episodes while EP1 remains slow", async (t) => {
  const gates = new Map();
  const state = await storyboardRun(t, {
    episodes: 30,
    provider: "openai-codex",
    beforeEpisode: (episode) => new Promise((resolve) => gates.set(episode, resolve)),
  });
  const pending = state.run();
  await tick();
  assert.deepEqual(
    state.calls.map(({ episode }) => episode),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(state.active(), 8);
  gates.get(8)();
  await tick();
  assert.equal(state.calls.at(-1).episode, 9, "a free lane immediately takes the next episode");
  assert.equal(
    state.calls.at(-1).role,
    state.calls.find(({ episode }) => episode === 8).role,
    "the lane keeps its warm session",
  );
  const released = new Set([8]);
  for (let turn = 0; turn < 30 && state.calls.length < 30; turn++) {
    for (const { episode } of state.calls)
      if (episode !== 1 && !released.has(episode)) {
        released.add(episode);
        gates.get(episode)();
      }
    await tick();
  }
  assert.equal(state.calls.length, 30, "all pending episodes can run without waiting for EP1");
  for (const { episode } of state.calls)
    if (episode !== 1 && !released.has(episode)) {
      released.add(episode);
      gates.get(episode)();
    }
  await tick();
  assert.equal(state.active(), 1, "only the genuinely in-flight slow episode remains");
  assert.equal(state.exists("storyboard/ep-01.md"), false);
  assert.equal(state.manifest.state, "storyboard_producing");
  gates.get(1)();
  await pending;
  assert.equal(state.peak(), 8);
  assert.equal(new Set(state.calls.map(({ episode }) => episode)).size, 30);
  assert.equal(state.manifest.state, "storyboard_reviewing");
});

test("passed storyboards are filtered before any sessions are created, including a fully resumed stage", async (t) => {
  const seeded = Array.from({ length: 30 }, (_, index) => index + 1);
  const complete = await storyboardRun(t, { episodes: 30, provider: "openai-codex", seeded });
  await complete.run();
  assert.equal(complete.workDirs.length, 0);
  assert.equal(complete.events.length, 0);
  assert.equal(complete.calls.length, 0);
  assert.equal(complete.manifest.state, "storyboard_reviewing");
  const partial = await storyboardRun(t, {
    episodes: 30,
    provider: "openai-codex",
    seeded: seeded.filter((episode) => ![2, 17, 29].includes(episode)),
  });
  await partial.run();
  assert.equal(partial.workDirs.length, 3);
  assert.equal(partial.peak(), 3);
  assert.deepEqual(
    partial.calls.map(({ episode }) => episode),
    [2, 17, 29],
  );
});

test("a failed episode stops new dispatch, awaits already-started episodes and leaves the phase resumable", async (t) => {
  const state = await storyboardRun(t, { provider: "openai-codex", failEpisode: 1 });
  await assert.rejects(state.run(), /offline failure EP1/);
  assert.equal(state.peak(), 8);
  assert.equal(state.workDirs.length, 8);
  assert.equal(state.active(), 0);
  assert.equal(state.batchesDone.length, 8);
  assert.equal(state.batchesDone.filter((item) => item.outcome === "completed").length, 7);
  assert.equal(state.manifest.state, "storyboard_producing");
  assert.deepEqual(
    state.calls.map(({ episode }) => episode),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  const finished = state.events.filter((event) => event.type === "storyboard_batch_finished");
  assert.equal(finished.length, 8);
  assert.equal(finished.filter((event) => event.outcome === "failed").length, 1);
  assert.equal(
    finished.find((event) => event.outcome === "failed").role,
    "storyboard-lane-1-session-1",
  );
});

test("a failed storyboard session creation records a failed batch finish", async (t) => {
  const state = await storyboardRun(t, {
    episodes: 1,
    provider: "openai-codex",
    failSessionRole: "storyboard-lane-1-session-1",
  });
  await assert.rejects(state.run(), /offline session creation failure/);
  assert.deepEqual(
    state.events.map(({ type, outcome }) => [type, outcome]),
    [
      ["storyboard_batch_started", "running"],
      ["storyboard_batch_finished", "failed"],
    ],
  );
  assert.equal(state.active(), 0);
  assert.equal(state.batchesDone.length, 0, "no session metrics were created");
  assert.equal(state.manifest.state, "storyboard_producing");
});

test("Kimi storyboard batches keep one active session", async (t) => {
  const state = await storyboardRun(t, { episodes: 10, provider: "kimi-coding" });
  await state.run();
  assert.equal(state.peak(), 1);
  assert.equal(state.calls.length, 10);
  assert.equal(state.manifest.state, "storyboard_reviewing");
});

test("an unbound legacy run stays serial with a stub session and does not infer its history from today's environment", async (t) => {
  const state = await storyboardRun(t, {
    episodes: 10,
    provider: "kimi-coding",
    legacyUnbound: true,
  });
  await state.run();
  assert.equal(state.peak(), 1);
  assert.equal(state.calls.length, 10);
});

test("an old storyboard file cannot stand in for the current repair submission", async (t) => {
  const state = await storyboardRun(t, { episodes: 1, stale: [1], omitSubmit: 1 });
  await assert.rejects(state.run(), /did not submit episode 1/);
  assert.equal(state.manifest.state, "storyboard_producing");
  assert.equal(JSON.parse(state.read("tasks/storyboard-ep-01.json")).state, "stale");
});

test("a prior episode draft cannot be checked or submitted as the next storyboard", async (t) => {
  const state = await storyboardRun(t, { episodes: 2, provider: "kimi-coding", omitWrite: 2 });
  await assert.rejects(state.run(), /did not submit episode 2/);
  assert.ok(state.exists("storyboard/ep-01.md"));
  assert.ok(!state.exists("storyboard/ep-02.md"));
  assert.match(state.read("work/storyboard-lane-1-session-1/draft.md"), /^# 第 1 集/);
  assert.equal(state.manifest.state, "storyboard_producing");
});

test("Storyboard checks and formal storage receive the same normalized draft with the approved episode title", async (t) => {
  const draft = [
    "# 分镜剧本",
    "创作设定：中国场景，正文仍保留。",
    `| ${STORYBOARD_HEADER.join(" | ")} |`,
    `|${STORYBOARD_HEADER.map(() => "---").join("|")}|`,
    ...Array.from(
      { length: 12 },
      (_, index) =>
        `| ep19-s${String(index + 1).padStart(2, "0")} | 画面 | 中：台词<br>EN: line | 中景 | 人物：A<br>场景：圣殿\\n道具：晶体 | 音效：脚步 | 8 |`,
    ),
  ].join("\n");
  const checked = [];
  const state = await storyboardRun(t, {
    episodes: 1,
    markdownForEpisode: () => draft,
    sourceForEpisode: () => "# 第1集｜已审核集名",
    onChecked: (markdown) => checked.push(markdown),
  });
  await state.run();
  const formal = state.read("storyboard/ep-01.md");
  assert.equal(
    formal,
    `${draft.replace("# 分镜剧本", "# 第 1 集｜已审核集名").replaceAll("| ep19-s", "| ep01-s").replaceAll("\\n道具：", "<br>道具：")}\n`,
  );
  assert.equal(checked.length, 2);
  assert.ok(checked.every((markdown) => markdown === formal));
  assert.equal(state.manifest.state, "storyboard_reviewing");
});
