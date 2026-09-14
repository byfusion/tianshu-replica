import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { Type, defineTool } from "../src/experiments/lib.mjs";
import { mapConcurrent } from "../src/concurrency.mjs";
import { normalizeEpisodeDraft } from "../src/draft-contract.mjs";
import { checkStoryboard, STORYBOARD_HEADER } from "../src/core.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function storyboardRun({ episodes = 45, provider = "deepseek", legacyUnbound = false, seeded = [], stale = [], failEpisode = null, omitSubmit = null, omitWrite = null, markdownForEpisode = (episode, role) => `STORYBOARD EP${episode} FROM ${role}`, sourceForEpisode = (episode) => `SOURCE EP${episode}`, checkDraft = () => [] } = {}) {
  const root = "/offline-storyboard", files = new Map(), workDirs = [], calls = [], batchesDone = [], states = [];
  const manifest = { state: "screenplay_passed", episodes, productionRoute: "tianshu-replication" };
  let activeSessions = 0, peakSessions = 0;
  const put = (file, value) => files.set(path.join(root, file), value);
  put("canonical/market.json", "{}"); put("canonical/market-contract.md", "market"); put("canonical/characters.md", "characters"); put("canonical/ledger.json", '{"names":[]}');
  for (let episode = 1; episode <= episodes; episode++) put(`screenplay/ep-${String(episode).padStart(2, "0")}.md`, sourceForEpisode(episode));
  for (const episode of [...seeded, ...stale]) {
    const label = String(episode).padStart(2, "0"), text = `existing storyboard EP${episode}`;
    put(`storyboard/ep-${label}.md`, text);
    put(`tasks/storyboard-ep-${label}.json`, JSON.stringify({ state: seeded.includes(episode) ? "passed" : "stale", digest: text, sourceScreenplayDigest: `SOURCE EP${episode}`, contractDigest: "contract", repairInstruction: "bounded repair" }));
  }
  const source = fs.readFileSync(new URL("../src/agents.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function produceStoryboards("), source.indexOf("\nexport async function reviewScripts(")).replace(/^export /, "");
  const run = vm.runInNewContext(`(${body})`, {
    planningBudgetGuidance: () => "",
    Type, defineTool, path, mapConcurrent,
    // Today's environment deliberately disagrees with the frozen run identity.
    process: { env: { TIANSHU_MODEL_PROVIDER: provider === "deepseek" ? "kimi-coding" : "deepseek" } },
    executionContractStatus: () => legacyUnbound ? { status: "legacy-unbound", historicalModel: "unknown" } : { status: "frozen", family: provider === "deepseek" ? "deepseek" : provider === "openai-codex" ? "gpt" : "kimi" },
    fs: { existsSync: (file) => files.has(file) },
    loadManifest: () => manifest,
    saveManifest: (_dir, value) => { if (value.state === "storyboard_reviewing") assert.equal(activeSessions, 0, "review must wait for all active sessions"); states.push(value.state); },
    readText: (file) => { assert.ok(files.has(file), `missing test artifact ${file}`); return files.get(file); },
    writeText: (file, text) => files.set(file, text), writeJson: (file, value) => files.set(file, JSON.stringify(value)),
    // Identity values stand in for unchanged artifact version metadata; no checksums are computed.
    sha: (value) => value, productionContractDigest: () => "contract", marketArtifactDigest: () => "market",
    loadProductionContract: () => ({}), productionContractMarkdown: () => "contract", canonicalPersonNames: () => [],
    storyboardChecks: checkDraft, storyboardWarnings: () => [], STORYBOARD_HEADER: ["shot"], performanceAttractionGuidance: "source appeal",
    normalizeEpisodeDraft, storyboardSourceContext: () => "source facts",
    sampleContext: () => "", ep: (episode) => String(episode).padStart(2, "0"), taskPath: (dir, name) => path.join(dir, "tasks", `${name}.json`),
    batches: (total) => Array.from({ length: Math.ceil(total / 5) }, (_, index) => ({ from: index * 5 + 1, to: Math.min(total, index * 5 + 5) })),
    artifactTools: (_dir, workDir, { normalize, onWrite }) => {
      workDirs.push(workDir);
      return [{ name: "write_draft", execute: async (_id, { markdown }) => { files.set(path.join(workDir, "draft.md"), normalize(markdown)); onWrite(); } }];
    },
    createPiExperimentSession: async ({ role, customTools }) => {
      activeSessions++; peakSessions = Math.max(peakSessions, activeSessions);
      return { session: { role, tools: customTools, prompting: false, dispose() { activeSessions--; } }, metrics: { role } };
    },
    promptWithWatchdog: async (session, _metrics, prompt) => {
      const episode = Number(prompt.match(/只制作第 (\d+) 集/)[1]);
      const [from, to] = session.role.match(/storyboard-(\d+)-(\d+)/).slice(1).map(Number);
      assert.ok(episode >= from && episode <= to);
      assert.equal(session.prompting, false, "episodes within one session must remain serial");
      assert.equal(manifest.state, "storyboard_producing");
      session.prompting = true; calls.push({ episode, role: session.role });
      try {
        await tick();
        if (episode === failEpisode) throw new Error(`offline failure EP${episode}`);
        if (episode === omitSubmit) return;
        const tool = (name) => session.tools.find((item) => item.name === name);
        if (episode === omitWrite) {
          assert.match((await tool("run_checks").execute("check", {})).content[0].text, /^FAIL:.*write_draft/);
          assert.match((await tool("submit_storyboard").execute("submit", { episode })).content[0].text, /^REJECTED.*write_draft/);
          return;
        }
        await tool("write_draft").execute("draft", { markdown: markdownForEpisode(episode, session.role) });
        assert.match((await tool("run_checks").execute("check", {})).content[0].text, /^PASS/);
        assert.match((await tool("submit_storyboard").execute("submit", { episode })).content[0].text, /^ACCEPTED/);
      } finally { session.prompting = false; }
    },
    writeBatchMetrics: (_dir, role, _metrics, outcome) => batchesDone.push({ role, outcome }),
  });
  return { run: () => run(root), files, calls, workDirs, batchesDone, states, manifest, peak: () => peakSessions, active: () => activeSessions };
}

test("DeepSeek storyboard batches reach eight independent sessions, preserve serial episode order and reuse passed tasks", async () => {
  const state = storyboardRun({ seeded: [2] });
  await state.run();
  assert.equal(state.peak(), 8);
  assert.equal(new Set(state.workDirs).size, 9);
  assert.equal(state.calls.length, 44);
  assert.equal(new Set(state.calls.map((item) => item.episode)).size, 44);
  assert.ok(!state.calls.some((item) => item.episode === 2));
  assert.equal(state.files.get("/offline-storyboard/storyboard/ep-02.md"), "existing storyboard EP2");
  for (const role of new Set(state.calls.map((item) => item.role))) {
    const episodes = state.calls.filter((item) => item.role === role).map((item) => item.episode);
    assert.deepEqual(episodes, [...episodes].sort((a, b) => a - b));
  }
  assert.equal(state.batchesDone.length, 9);
  assert.ok(state.batchesDone.every((item) => item.outcome === "completed"));
  assert.deepEqual(state.states, ["storyboard_producing", "storyboard_reviewing"]);
});

test("a failed batch stops new dispatch, awaits already-started batches and leaves the phase resumable", async () => {
  const state = storyboardRun({ failEpisode: 1 });
  await assert.rejects(state.run(), /offline failure EP1/);
  assert.equal(state.peak(), 8);
  assert.equal(state.workDirs.length, 8);
  assert.equal(state.active(), 0);
  assert.equal(state.batchesDone.length, 8);
  assert.equal(state.batchesDone.filter((item) => item.outcome === "completed").length, 7);
  assert.deepEqual(state.states, ["storyboard_producing"]);
  assert.ok(!state.calls.some((item) => item.episode > 40));
});

test("non-DeepSeek storyboard providers keep one active batch", async () => {
  const state = storyboardRun({ episodes: 10, provider: "kimi-coding" });
  await state.run();
  assert.equal(state.peak(), 1);
  assert.equal(state.calls.length, 10);
  assert.equal(state.manifest.state, "storyboard_reviewing");
});

test("an unbound legacy run stays serial with a stub session and does not infer its history from today's environment", async () => {
  const state = storyboardRun({ episodes: 10, provider: "kimi-coding", legacyUnbound: true });
  await state.run();
  assert.equal(state.peak(), 1);
  assert.equal(state.calls.length, 10);
});

test("an old storyboard file cannot stand in for the current repair submission", async () => {
  const state = storyboardRun({ episodes: 1, stale: [1], omitSubmit: 1 });
  await assert.rejects(state.run(), /did not submit episode 1/);
  assert.equal(state.manifest.state, "storyboard_producing");
  assert.equal(JSON.parse(state.files.get("/offline-storyboard/tasks/storyboard-ep-01.json")).state, "stale");
});

test("a prior episode draft cannot be checked or submitted as the next storyboard", async () => {
  const state = storyboardRun({ episodes: 2, omitWrite: 2 });
  await assert.rejects(state.run(), /did not submit episode 2/);
  assert.ok(state.files.has("/offline-storyboard/storyboard/ep-01.md"));
  assert.ok(!state.files.has("/offline-storyboard/storyboard/ep-02.md"));
  assert.match(state.files.get("/offline-storyboard/work/storyboard-1-2/draft.md"), /^# 第 1 集/);
  assert.equal(state.manifest.state, "storyboard_producing");
});

test("Storyboard checks and formal storage receive the same normalized draft with the approved episode title", async () => {
  const draft = [
    "# 分镜剧本", "创作设定：正文仍保留。", `| ${STORYBOARD_HEADER.join(" | ")} |`, `|${STORYBOARD_HEADER.map(() => "---").join("|")}|`,
    ...Array.from({ length: 12 }, (_, index) => `| ep19-s${String(index + 1).padStart(2, "0")} | 画面 | 中：台词<br>EN: line | 中景 | 人物：A<br>场景：圣殿\\n道具：晶体 | 音效：脚步 | 8 |`),
  ].join("\n");
  const checked = [];
  const state = storyboardRun({ episodes: 1, markdownForEpisode: () => draft, sourceForEpisode: () => "# 第1集｜已审核集名", checkDraft: (markdown) => { checked.push(markdown); return checkStoryboard(markdown); } });
  await state.run();
  const formal = state.files.get("/offline-storyboard/storyboard/ep-01.md");
  assert.equal(formal, draft.replace("# 分镜剧本", "# 第 1 集｜已审核集名").replaceAll("| ep19-s", "| ep01-s").replaceAll("\\n道具：", "<br>道具："));
  assert.equal(checked.length, 2);
  assert.ok(checked.every((markdown) => markdown === formal));
  assert.equal(state.manifest.state, "storyboard_reviewing");
});
