import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { commitContinuityReview, observedSnapshotReferences, reviewContinuityUpdate } from "../src/continuity.mjs";
import { Type, Compile, defineTool } from "../src/experiments/lib.mjs";
import { parseSourceOutline } from "../src/replication.mjs";
import { buildContinuityTaskPrompt } from "../src/agent-prompts.mjs";

function offlineContinuity(snapshot, action, note = null, episode = 19, approvedEpisodeText = "本集已批准计划：核对角色与物件的实际状态变化。") {
  const root = "/offline-continuity", writes = [], metrics = [];
  let current = { lastEpisode: episode - 1, snapshot, snapshotDigest: "previous-state" }, sessions = 0, prompts = 0, attempts = 0, settings;
  const context = () => ({ contract: "静态连续性合同。", contractDigest: "contract-version", current });
  const commit = vm.runInNewContext(`(${commitContinuityReview.toString()})`, {
    path, observedSnapshotReferences, continuityContext: context,
    // Version metadata is outside this patch test; no checksum is computed.
    sha: () => "test-version",
    nextAttemptPath: () => `${root}/continuity/events/ep-${episode}/attempt-${++attempts}.json`,
    currentPath: () => `${root}/continuity/current.json`, episodePath: () => `${root}/continuity/ep-${episode}.json`,
    writeJson: (file, value) => { writes.push({ file, value: structuredClone(value) }); if (file.endsWith("/current.json")) current = value; },
    writeText: (file, value) => writes.push({ file, value }),
  });
  const review = vm.runInNewContext(`(${reviewContinuityUpdate.toString()})`, {
    episodeMapContext: () => "",
    buildContinuityTaskPrompt,
    replicationCharacterContext: () => "",
    Type, defineTool, path, parseSourceOutline, observedSnapshotReferences, process: { env: { TIANSHU_MODEL_PROVIDER: "deepseek" } },
    fs: { existsSync: (file) => note !== null && file === `${root}/work/continuity-notes.txt` },
    readJson: (file) => { assert.equal(file, `${root}/manifest.json`); return { episodes: 32 }; },
    readText: (file) => {
      if (file === `${root}/canonical/outline.md`) return Array.from({ length: 32 }, (_, index) => `## 第${index + 1}集\n${index + 1 === episode ? approvedEpisodeText : `仅属于其它集的 PLAN_${index + 1}_ONLY`}`).join("\n\n");
      assert.equal(file, `${root}/work/continuity-notes.txt`); return note;
    },
    continuityContext: context, ep: (episode) => String(episode).padStart(2, "0"), commitContinuityReview: commit,
    createPiExperimentSession: async (options) => {
      settings = options; sessions++;
      assert.equal(options.maxOutputTokens, 65536);
      assert.equal(options.thinkingLevel, "low");
      assert.equal(options.toolNames[0], "submit_continuity_review");
      return { session: { dispose() {} }, metrics: {} };
    },
    promptWithWatchdog: async (_session, _metrics, prompt) => {
      prompts++;
      await action(async (name, params, checkSchema = true) => {
        const tool = settings.customTools.find((item) => item.name === name);
        assert.ok(tool, `${name} must be available`);
        assert.equal(tool.parameters.type, "object");
        if (checkSchema) assert.ok(Compile(tool.parameters).Check(params));
        return tool.execute("offline-continuity-call", params);
      }, prompt, settings.systemPrompt);
    },
    appendMetrics: (_run, _role, _metrics, outcome, extra) => metrics.push({ outcome, ...extra }),
  });
  return { run: () => review(root, { episode, screenplay: "正式剧本：门被打开，灯仍在发亮。", proposedUpdate: "Maya 把钥匙交给 Noah，门被打开。" }), current: () => current, writes, metrics, counts: () => ({ sessions, prompts, attempts }) };
}

test("continuity patch updates a large snapshot without rewriting untouched text and records its submitted operations", async () => {
  const first = "客观事实：钥匙由Maya保管。", last = "物件状态：门已锁定。";
  const snapshot = `  ${first}\n${"已确认的事实和人物认知保持原样。\n".repeat(2450)}${last}  `;
  assert.ok(snapshot.length > 41000);
  const replacements = [{ old_text: first, new_text: "客观事实：钥匙已交给Noah。" }, { old_text: last, new_text: "物件状态：门已打开。" }];
  const append = "新状态：Noah 此时才知道钥匙编号。";
  const approvedUpdate = "钥匙转交Noah，门被打开，编号此时才告知。";
  const state = offlineContinuity(snapshot, async (invoke, prompt, instructions) => {
    assert.ok(prompt.includes(snapshot));
    const response = await invoke("submit_continuity_patch", { verdict: "correct", approvedUpdate, reason: "本集发生了两项状态变化。", replacements, append });
    assert.match(instructions, /只有需要修正旧误记.*submit_continuity_patch/);
    assert.match(response.content[0].text, /^ACCEPTED/);
  });
  const result = await state.run();
  const actualAppend = `\n【第19集确认变化】\n${approvedUpdate}\n${append}`;
  const expected = snapshot.replace(first, replacements[0].new_text).replace(last, replacements[1].new_text) + actualAppend;
  assert.equal(result.current.snapshot, expected);
  assert.equal(state.current().snapshot, expected);
  const savedEvent = state.writes.find((write) => write.file.includes("/events/ep-19/"));
  assert.deepEqual(savedEvent.value.snapshotPatch, { replacements, append: actualAppend });
  let replay = snapshot;
  for (const replacement of savedEvent.value.snapshotPatch.replacements) replay = replay.replace(replacement.old_text, replacement.new_text);
  replay += savedEvent.value.snapshotPatch.append;
  assert.equal(replay, result.current.snapshot);
  assert.equal(state.metrics[0].submissionMode, "patch");
  assert.deepEqual(state.counts(), { sessions: 1, prompts: 1, attempts: 1 });
});

test("the observed placeholder submission stays unaccepted and can be corrected in the same session", async () => {
  const snapshot = "完整前态：Maya持有钥匙，Noah尚不知道编号。\n旧状态与未决身份继续保留。";
  const approvedUpdate = "本集确认：钥匙交给Noah，编号在交接后才告知。";
  const state = offlineContinuity(snapshot, async (invoke, _prompt, instructions) => {
    for (const bad of [
      { verdict: "correct", approvedUpdate: "placeholder", currentSnapshot: "placeholder", reason: "placeholder" },
      { verdict: "correct", approvedUpdate, reason: "待补充" },
      { verdict: "correct", approvedUpdate: "同上", reason: "仍缺少本次完整变化。" },
    ]) {
      const response = await invoke("submit_continuity_review", bad, false);
      assert.equal(response.terminate, false, "invalid fields must not terminate the internal session as accepted");
      assert.match(response.content[0].text, /^REJECTED/);
      assert.equal(state.writes.length, 0);
      assert.equal(state.current().snapshot, snapshot);
    }
    const response = await invoke("submit_continuity_review", { verdict: "correct", approvedUpdate, reason: "按实际交接动作核实，未知身份未补造。" });
    assert.equal(response.terminate, true);
    assert.match(instructions, /默认.*submit_continuity_review/);
    assert.match(instructions, /省略currentSnapshot/);
  });
  const result = await state.run();
  const append = `\n【第19集确认变化】\n${approvedUpdate}`;
  assert.equal(result.current.snapshot, snapshot + append);
  const savedEvent = state.writes.find((write) => write.file.includes("/events/")).value;
  assert.deepEqual(savedEvent.snapshotPatch, { replacements: [], append });
  assert.equal(state.metrics[0].submissionMode, "append");
  assert.deepEqual(state.counts(), { sessions: 1, prompts: 1, attempts: 1 });
});

test("ContinuityAgent receives only the current approved episode plan with the full prior state and separate evidence note", async () => {
  const oldState = "Maya 在上一集尚未获任档案馆主管。";
  const snapshot = `${oldState}\n${"仍有效的事实和人物认知保持原样。\n".repeat(1000)}尾部约束：未公开的身份继续未知。`;
  const currentPlan = "本集已批准计划：馆长当场任命Maya为档案馆主管并交付徽章，Maya接受职务。";
  const note = "外部核验说明：检查授职是否已在正文场景中发生，不能只依据Writer自检。";
  const state = offlineContinuity(snapshot, async (invoke, prompt, instructions) => {
    assert.ok(prompt.includes(currentPlan), "the current episode's approved advancement must reach the ContinuityAgent");
    assert.ok(prompt.includes(snapshot), "all prior state must remain available");
    assert.ok(prompt.includes(note));
    assert.ok(!prompt.includes("PLAN_13_ONLY") && !prompt.includes("PLAN_15_ONLY"));
    assert.match(instructions, /开篇.*上一集.*永久禁令/);
    assert.match(instructions, /未.*正文.*发生/);
    assert.match(instructions, /自检.*不能替代.*动作证据/);
    assert.equal(state.current().snapshot, snapshot);
    await invoke("submit_continuity_patch", { verdict: "correct", approvedUpdate: "本集场景中Maya获任主管并接过徽章。", reason: "已批准计划与正文动作共同支持状态推进。", replacements: [{ old_text: oldState, new_text: "Maya 已在本集获任档案馆主管。" }] });
  }, note, 14, currentPlan);
  const result = await state.run();
  assert.ok(result.current.snapshot.includes("Maya 已在本集获任档案馆主管。"));
  assert.deepEqual(state.counts(), { sessions: 1, prompts: 1, attempts: 1 });
});

for (const [episode, replacements] of [[30, []], [31, [{ old_text: "已知背景：Maya曾持有钥匙。", new_text: "已知背景：Maya曾持有钥匙，后来已交还。" }]]]) {
  test(`EP${episode}-shaped patch without append still carries every approved current-episode change`, async () => {
    const snapshot = "已知背景：Maya曾持有钥匙。\n人物认知：Noah尚不知道信封内容。\n未变状态：门口守卫仍在原位。";
    const approvedUpdate = `第${episode}集确认：Maya已安全脱离陷阱，Noah此时才读到信封内容。未确认的幕后身份继续未知。`;
    const state = offlineContinuity(snapshot, async (invoke) => {
      await invoke("submit_continuity_patch", { verdict: "correct", approvedUpdate, reason: "本集事件均已核实。", replacements });
    }, null, episode);
    const result = await state.run();
    assert.ok(result.current.snapshot.includes(approvedUpdate), "approved changes cannot remain only in the event's approvedUpdate field");
    const savedEvent = state.writes.find((write) => write.file.includes(`/events/ep-${episode}/`)).value;
    let replay = snapshot;
    for (const replacement of savedEvent.snapshotPatch.replacements) replay = replay.replace(replacement.old_text, replacement.new_text);
    const oldTextAfterReplacements = replay;
    replay += savedEvent.snapshotPatch.append;
    assert.equal(result.current.snapshot, replay);
    assert.ok(result.current.snapshot.startsWith(oldTextAfterReplacements));
    assert.ok(savedEvent.snapshotPatch.append.includes(`第${episode}集确认变化`));
    assert.ok(savedEvent.snapshotPatch.append.includes(approvedUpdate));
    assert.deepEqual(state.counts(), { sessions: 1, prompts: 1, attempts: 1 });
  });
}

test("missing or non-unique continuity patch targets leave the previous formal state untouched", async () => {
  const snapshot = "客观事实：钥匙由Maya保管。\n重复条目。\n重复条目。\n人物认知：Noah 尚不知道编号。";
  for (const old_text of ["不存在的条目", "重复条目。"]) {
    const state = offlineContinuity(snapshot, async (invoke) => {
      const response = await invoke("submit_continuity_patch", { verdict: "correct", approvedUpdate: "本集状态变化需要复核。", reason: "离线匹配反例。", replacements: [{ old_text: "钥匙由Maya保管", new_text: "钥匙已交给Noah" }, { old_text, new_text: "替换条目。" }] });
      assert.match(response.content[0].text, /REJECTED.*exactly once/);
    });
    await assert.rejects(state.run(), /did not submit/);
    assert.equal(state.current().snapshot, snapshot);
    assert.equal(state.current().lastEpisode, 18);
    assert.equal(state.writes.length, 0);
    assert.deepEqual(state.counts(), { sessions: 1, prompts: 1, attempts: 0 });
  }
});

test("full continuity submission remains available and external notes are separate evidence for the agent", async () => {
  const snapshot = "客观事实：钥匙在Maya手中。人物认知：Noah尚不知道编号。物件状态：门仍锁定。";
  const note = "核验点：本集正式剧本写灯仍在发亮，请核对旧说明中的相反描述。";
  const fullSnapshot = "客观事实：钥匙已交给Noah，门已打开。人物认知：Noah此时才知道编号。灯仍在发亮。归档说明中的 approvedUpdate 字样不构成整段引用。";
  const state = offlineContinuity(snapshot, async (invoke, prompt) => {
    assert.ok(prompt.includes(snapshot));
    assert.ok(prompt.includes(note));
    assert.match(prompt, /外部复核证据[\s\S]*核实后修正不准确旧描述[\s\S]*已正确则保持[\s\S]*不凭意见新增事实/);
    assert.equal(state.current().snapshot, snapshot, "notes cannot mutate state before the internal agent submits");
    await invoke("submit_continuity_review", { verdict: "correct", approvedUpdate: "钥匙转交Noah并开门，保留灯仍亮的事实。", reason: "正文中的 placeholder 是原文标注，已按实际动作核实。", currentSnapshot: fullSnapshot });
  }, note);
  const result = await state.run();
  assert.equal(result.current.snapshot, fullSnapshot);
  assert.equal(result.event.snapshotPatch, undefined);
  assert.equal(result.event.normalization, undefined);
  assert.equal(state.metrics[0].submissionMode, "full");
  assert.deepEqual(state.counts(), { sessions: 1, prompts: 1, attempts: 1 });
});

const observedReferences = [
  { episode: 23, reference: "见 approvedUpdate（即本集通过后的完整动态快照全文）。", bodyLength: 36317 },
  { episode: 28, reference: "（已并入 approvedUpdate，见该字段：EP28 集末完整快照，含场面与在场者、Ava 状态、本集确认事实、能力与权限边界、知识状态、物件持有、关系与映射、EP28 新未知、未结悬念、硬性未来轨道。）", bodyLength: 7496 },
];

for (const { episode, reference, bodyLength } of observedReferences) {
  test(`observed EP${episode} full-field reference resolves only to the complete text supplied in the same response`, async () => {
    const header = `【动态快照·截至 EP${episode} 集末】\n`, tail = "\n末尾有效约束：未知身份继续保留未知。";
    const complete = header + "已确认的状态与人物认知保持原样。\n".repeat(bodyLength).slice(0, bodyLength - header.length - tail.length) + tail;
    const response = { verdict: "correct", approvedUpdate: complete, currentSnapshot: reference, reason: "同一响应已提供完整合并状态。" };
    const originalResponse = JSON.stringify(response);
    const state = offlineContinuity("此前完整状态与人物认知保持有效，后续变化应逐项更新而不丢失。", async (invoke) => {
      await invoke("submit_continuity_review", response);
    }, null, episode);
    const result = await state.run();
    assert.equal(result.current.snapshot.length, bodyLength);
    assert.equal(result.current.snapshot, complete);
    const savedEvent = state.writes.find((write) => write.file.includes(`/events/ep-${episode}/`)).value;
    assert.deepEqual(savedEvent.normalization, { originalReference: reference, sourceField: "approvedUpdate" });
    assert.equal(savedEvent.currentSnapshot, complete);
    assert.equal(JSON.stringify(response), originalResponse, "the original response must remain unchanged");
  });
}

test("an observed full-field reference with a missing or short target cannot become accepted state", async () => {
  const snapshot = "此前完整状态与人物认知保持有效，后续变化应逐项更新而不丢失。";
  for (const approvedUpdate of ["  ", "只有本集局部变化。", observedReferences[0].reference]) {
    const state = offlineContinuity(snapshot, async (invoke) => {
      const response = await invoke("submit_continuity_review", { verdict: "correct", approvedUpdate, currentSnapshot: observedReferences[0].reference, reason: "缺失完整目标正文的反例。" }, false);
      assert.equal(response.terminate, false);
      assert.match(response.content[0].text, /^REJECTED/);
    });
    await assert.rejects(state.run(), /did not submit/);
    assert.equal(state.current().snapshot, snapshot);
    assert.equal(state.current().lastEpisode, 18);
    assert.equal(state.writes.length, 0, "invalid targets must be rejected before any commit");
  }
});
