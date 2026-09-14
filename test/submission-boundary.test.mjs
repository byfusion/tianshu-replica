import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { artifactTools, storyboardSourceContext } from "../src/agents.mjs";
import { Type, defineTool } from "../src/experiments/lib.mjs";
import { normalizeEpisodeDraft, normalizeEpisodeHeading } from "../src/draft-contract.mjs";

const agentSource = fs.readFileSync(new URL("../src/agents.mjs", import.meta.url), "utf8");
const writerBody = agentSource.slice(agentSource.indexOf("export async function produceScripts("), agentSource.indexOf("\nexport async function produceStoryboards(")).replace(/^export /, "");
const artifactBody = agentSource.slice(agentSource.indexOf("export function artifactTools("), agentSource.indexOf("\nexport function storyboardSourceContext(")).replace(/^export /, "");
const row = (values) => `| ${values.join(" | ")} |`;

test("Runtime normalizes known episode metadata without altering narrative prose or shot sequence", () => {
  const prose = "\r\n\r\n创作设定：保留。\r\n## 制作说明\r\n仍应保留。\r\n";
  const table = [
    row(["ep03-s01", "画面中的 ep03-s01 保留", "无台词", "近景", "人物：A", "音效：脚步", "5"]),
    row(["ep03-s03", "不补漏镜", "无台词", "近景", "人物：A", "音效：脚步", "5"]),
    row(["ep03-s03", "不掩盖重复镜", "无台词", "近景", "人物：A", "音效：脚步", "5"]),
  ].join("\r\n");
  const input = `# 第3集｜随意重命名 · 分镜表${prose}${table}`;
  const options = { stage: "storyboard", episode: 19, screenplay: "# 第19集｜已审核集名\n\n剧本正文" };
  const result = normalizeEpisodeDraft(input, options);
  assert.equal(result, `# 第 19 集｜已审核集名${prose}${table.replaceAll("| ep03-s", "| ep19-s")}`);
  assert.equal(normalizeEpisodeDraft(result, options), result);
  assert.equal(normalizeEpisodeHeading(input, options), `# 第 19 集｜已审核集名${prose}${table}`);
});

test("only the observed literal asset-label separators become cell line breaks", () => {
  const assets = [
    "人物：粉鳞幼龙（胸口与衣物）、Ava 的手<br>场景：白龙宫圣殿圆台\\n道具：孩子胸口的衣物与领口、透出的白色发光纹路",
    "人物：Ava、粉鳞幼龙、背景 Kael 与白龙族众人<br>场景：白龙宫圣殿圆台\\n道具：掌心的透明晶体、圆台石面、孩子的胸口发光纹路",
    "人物：Ava、粉鳞幼龙（怀中）、掌心的透明晶体、背景 Kael 与白龙族队列<br>场景：白龙宫圣殿圆台\\n道具：掌心的透明晶体、圆台石面、孩子的胸口发光纹路",
  ];
  const prose = "说明里的 \\n道具：按原文保留；路径 C:\\notes。";
  const cells = assets.map((value, index) => [`ep19-s${index + 1}`, "画面", "无台词", "近景", value, "文件 C:\\notes，字面\\n文本", "5"]);
  const input = `# 第 19 集｜集名\n\n${prose}\n${cells.map(row).join("\n")}`;
  const expected = `# 第 19 集｜集名\n\n${prose}\n${cells.map((values) => row(values.map((value, index) => index === 4 ? value.replace("\\n道具：", "<br>道具：") : value))).join("\n")}`;
  assert.equal(normalizeEpisodeDraft(input, { stage: "storyboard", episode: 19 }), expected);
  assert.equal(normalizeEpisodeDraft(expected, { stage: "storyboard", episode: 19 }), expected);
  assert.equal(normalizeEpisodeDraft(input, { stage: "screenplay", episode: 19 }), input);
});

test("normalized drafts are unchanged and missing names are not invented or borrowed from another episode", () => {
  const markdown = "# 第 2 集｜一天\n\n## 场景1\n完整正文。";
  assert.equal(normalizeEpisodeDraft(markdown, { stage: "screenplay", episode: 2 }), markdown);
  assert.equal(normalizeEpisodeDraft("## 场景1\n完整正文。", { stage: "screenplay", episode: 2 }), "# 第 2 集\n\n## 场景1\n完整正文。");
  assert.equal(normalizeEpisodeDraft("# 分镜剧本\n\n正文。", { stage: "storyboard", episode: 2, screenplay: "# 第3集｜不能借用" }), "# 第 2 集\n\n正文。");
});

function writerRun({ episodes = 1, stale = false, action = () => "submit", rejectFirstContinuity = false } = {}) {
  const root = "/offline-writer", files = new Map(), toolResults = [], checks = [];
  const put = (name, value) => files.set(path.join(root, name), typeof value === "string" ? value : JSON.stringify(value));
  const manifest = { state: stale ? "screenplay_repairing" : "approved", episodes, productionRoute: "tianshu-replication" };
  put("canonical/outline.md", "outline"); put("canonical/characters.md", "characters"); put("canonical/ledger.json", { names: [] });
  put("canonical/market.json", {}); put("canonical/market-contract.md", "market");
  if (stale) {
    put("screenplay/ep-01.md", "# 第1集｜旧稿\n旧正文");
    put("tasks/screenplay-ep-01.json", { state: "stale", repairInstruction: "修复缺陷" });
    put("continuity/ep-01.json", { proposedUpdate: "旧提案", snapshotDigest: "old" });
    put("work/writer-1-1/draft.md", "# 第1集｜旧工作稿\n不能作为新提交");
  }
  let prompts = 0, continuityReviews = 0;
  const attempts = new Map();
  const context = {
    Type, defineTool, path, normalizeEpisodeDraft,
    fs: { existsSync: (file) => files.has(file) },
    loadManifest: () => manifest, saveManifest: () => {},
    readText: (file) => { assert.ok(files.has(file), `missing test file ${file}`); return files.get(file); },
    writeText: (file, value) => files.set(file, value), writeJson: (file, value) => files.set(file, JSON.stringify(value)),
    canonicalPersonNames: () => [], loadProductionContract: () => ({ revision: { maxContinuityRepairAttempts: 2 } }),
    productionContractMarkdown: () => "contract", productionContractDigest: () => "contract", marketArtifactDigest: () => "market",
    // Identity values retain the existing version checks without computing checksums.
    sha: (value) => value,
    batches: () => [{ from: 1, to: episodes }], ep: (episode) => String(episode).padStart(2, "0"),
    taskPath: (directory, name) => path.join(directory, "tasks", `${name}.json`),
    sampleContext: () => "", outlineWindow: () => "", replicationWriterContext: () => "", planningBudgetGuidance: () => "",
    continuityContext: () => ({ contract: "contract", current: { snapshot: "previous", snapshotDigest: "previous" } }),
    continuityIsAccepted: () => false,
    screenplayChecks: (markdown) => { checks.push(markdown); return []; },
    createPiExperimentSession: async ({ customTools }) => ({ session: { tools: customTools, dispose() {} }, metrics: {} }),
    stageContinuityProposal: (_dir, { episode, proposedUpdate }) => put(`continuity/ep-${String(episode).padStart(2, "0")}.json`, { proposedUpdate }),
    reviewContinuityUpdate: async (_dir, { episode }) => {
      continuityReviews++;
      if (rejectFirstContinuity && continuityReviews === 1) throw Object.assign(new Error("continuity rejected"), { code: "CONTINUITY_REJECTED" });
      const file = `continuity/ep-${String(episode).padStart(2, "0")}.json`;
      put(file, { ...JSON.parse(files.get(path.join(root, file))), snapshotDigest: "accepted" });
    },
    nextContinuityRepairAttempt: (prior) => (prior.continuityRepairAttempt || 0) + 1,
    routeContinuityRejectToWriter: (_dir, { taskFile, prior, attempt }) => {
      files.set(taskFile, JSON.stringify({ ...prior, state: "stale", continuityRepairAttempt: attempt })); return { routed: true };
    },
    writeBatchMetrics: () => {},
    promptWithWatchdog: async (session, _metrics, prompt) => {
      prompts++;
      const episode = Number(prompt.match(/(?:只写第|提交第) (\d+) 集/)[1]);
      const attempt = (attempts.get(episode) || 0) + 1; attempts.set(episode, attempt);
      const mode = action(episode, attempt);
      if (mode === "none") return;
      const tool = (name) => session.tools.find((item) => item.name === name);
      if (mode !== "without-write") await tool("write_draft").execute("write", { markdown: `# 第99集｜集名${episode} · 分镜表\n\n正文${episode}` });
      toolResults.push(await tool("run_checks").execute("check", {}));
      toolResults.push(await tool("submit_screenplay").execute("submit", { episode, continuityUpdate: "本集真正发生的状态变化" }));
    },
  };
  const sandbox = vm.createContext(context);
  context.artifactTools = vm.runInContext(`(${artifactBody})`, sandbox);
  const run = vm.runInContext(`(${writerBody})`, sandbox);
  return { run: () => run(root), files, manifest, toolResults, checks, prompts: () => prompts, continuityReviews: () => continuityReviews };
}

test("Writer repair cannot use an old formal file as a fresh submission", async () => {
  const state = writerRun({ stale: true, action: () => "none" });
  await assert.rejects(state.run(), /writer did not submit episode 1/);
  assert.equal(state.prompts(), 2);
  assert.equal(state.continuityReviews(), 0);
  assert.equal(state.manifest.state, "screenplay_producing");
  assert.equal(JSON.parse(state.files.get("/offline-writer/tasks/screenplay-ep-01.json")).state, "stale");
  assert.equal(state.files.get("/offline-writer/screenplay/ep-01.md"), "# 第1集｜旧稿\n旧正文");
});

test("Writer checks and submit reject old work files before any normalization", async () => {
  const state = writerRun({ stale: true, action: () => "without-write" });
  await assert.rejects(state.run(), /writer did not submit episode 1/);
  assert.ok(state.toolResults.every((result) => /^(?:FAIL|REJECTED).*write_draft/.test(result.content[0].text)));
  assert.equal(state.checks.length, 0);
  assert.equal(state.files.get("/offline-writer/work/writer-1-1/draft.md"), "# 第1集｜旧工作稿\n不能作为新提交");
});

test("Writer stores the same normalized current draft that checks saw, and resets freshness for the next episode", async () => {
  const state = writerRun({ episodes: 2, action: (episode) => episode === 1 ? "submit" : "without-write" });
  await assert.rejects(state.run(), /writer did not submit episode 2/);
  const submitted = state.files.get("/offline-writer/screenplay/ep-01.md");
  assert.equal(submitted, "# 第 1 集｜集名1\n\n正文1");
  assert.ok(state.checks.every((markdown) => markdown === submitted));
  assert.ok(!state.files.has("/offline-writer/screenplay/ep-02.md"));
  assert.equal(state.continuityReviews(), 1);
});

test("same-episode continuity repair must write a new draft before resubmitting", async () => {
  const state = writerRun({ rejectFirstContinuity: true, action: (_episode, attempt) => attempt === 1 ? "submit" : "without-write" });
  await assert.rejects(state.run(), /writer did not submit episode 1/);
  assert.equal(state.continuityReviews(), 1);
  assert.equal(JSON.parse(state.files.get("/offline-writer/tasks/screenplay-ep-01.json")).state, "stale");
  assert.ok(state.toolResults.slice(2).every((result) => /^(?:FAIL|REJECTED).*write_draft/.test(result.content[0].text)));
});

test("read_artifact pages a complete long source and identifies the remaining content", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-paged-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "canonical"));
  const text = "A".repeat(12000) + "不能省略的身份事实" + "B".repeat(12000) + "结尾未知项";
  fs.writeFileSync(path.join(root, "canonical/characters.md"), text);
  const read = artifactTools(root, path.join(root, "work")).find((item) => item.name === "read_artifact");
  const parts = [];
  let offset = 0, result;
  do {
    result = await read.execute("read", { ref: "canonical/characters.md", offset });
    parts.push(result.content[0].text);
    assert.equal(result.details.totalChars, text.length);
    if (result.details.truncated) assert.match(result.content[1].text, /continue read_artifact.*offset=/);
    offset = result.details.nextOffset;
  } while (offset !== null);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(""), text);
  assert.equal(result.details.truncated, false);
});

test("Storyboard source context includes full identity and current episode source without end-of-series dynamic leakage", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-storyboard-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "canonical")); fs.mkdirSync(path.join(root, "continuity"));
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ productionRoute: "tianshu-replication", episodes: 32 }));
  fs.writeFileSync(path.join(root, "canonical/characters.md"), "身份资料".repeat(4000) + "\n四子的姓名归属仍未知。");
  fs.writeFileSync(path.join(root, "canonical/continuity-contract.md"), "静态事实：仅救当前幼龙。");
  fs.writeFileSync(path.join(root, "canonical/design.md"), "保留互动关系。");
  fs.writeFileSync(path.join(root, "canonical/source-outline.md"), Array.from({ length: 32 }, (_, index) => `## 第${index + 1}集\n源事件${index + 1}：${index === 0 ? "开场当前事实" : "其它分集"}`).join("\n\n"));
  fs.writeFileSync(path.join(root, "continuity/current.json"), JSON.stringify({ lastEpisode: 32, snapshot: "EP32未来动态事实不得倒灌" }));
  const result = storyboardSourceContext(root, 1);
  assert.ok(result.includes("身份资料".repeat(4000) + "\n四子的姓名归属仍未知。"));
  assert.match(result, /静态事实：仅救当前幼龙/);
  assert.match(result, /源事件1：开场当前事实/);
  assert.match(result, /源材料未确认的别名映射/);
  assert.doesNotMatch(result, /源事件32|EP32未来动态事实/);
});
