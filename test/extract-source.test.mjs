import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractSourceMaterials } from "../src/extract-source.mjs";
import { loadSourceMaterials } from "../src/source-materials.mjs";
import { collectUsage, readRunMetrics } from "../src/metrics.mjs";

function workspace(t, count = 3) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-extract-source-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "source.md");
  fs.writeFileSync(sourcePath, Array.from({ length: count }, (_, index) => `## 第${index + 1}集\n角色甲取回第${index + 1}把钥匙。${index === 2 ? "倒叙：Rowan Bell曾把它交给Ellis Reed，Rowan是否为同一人不明。" : "角色乙阻止他开门。"}`).join("\n\n"));
  return { directory, sourcePath, outputPath: path.join(directory, "inputs", "materials.json") };
}

function row(episode) {
  return {
    episode, coreEvents: [episode === 3 ? "倒叙：一小时前，角色甲取回第3把钥匙。" : `角色甲取回第${episode}把钥匙。`],
    conflict: "角色乙阻止甲开门。", reversal: "未知", endingState: "钥匙由甲持有。", hook: "门内有什么尚未知。",
    sourceEvidence: [`取回第${episode}把钥匙`], uncertainties: episode === 3 ? ["倒叙保留第3集；Rowan Bell、Rowan与Ellis Reed的对应未知。"] : [],
  };
}

function batch(from, to) {
  return {
    creative: `创意：夺回开门的决定权。依据：第${from}集，角色乙阻止他开门。`,
    characters: `角色甲：取回钥匙；角色乙：阻拦者。依据：第${from}集。Rowan Bell、Rowan与Ellis Reed的对应未知，背景未知。`,
    episodes: Array.from({ length: to - from + 1 }, (_, index) => row(from + index)),
  };
}

function mockFactory(calls, behavior) {
  let active = 0;
  return async (options) => {
    assert.equal(active, 0, "source sessions must run serially");
    active += 1;
    const metrics = { role: options.role, startedAt: new Date().toISOString(), prompts: 0, promptAttempts: [], assistantMessages: 0, usage: [] };
    const call = { ...options, disposed: false };
    calls.push(call);
    const [from, to] = (options.role.match(/\d+/g) || []).map(Number);
    return {
      metrics,
      session: {
        async prompt(prompt) {
          call.prompt = prompt;
          collectUsage(metrics, { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 130 } } });
          if (behavior) return behavior({ options, from, to, metrics, call });
          const output = options.role === "source-identity-consolidation"
            ? { creative: "汇总创意：夺回开门的决定权。依据：第1集与第4集。", characters: "角色甲取回钥匙、角色乙阻拦。依据：第1集与第4集。Rowan Bell、Rowan与Ellis Reed的对应未知。" }
            : batch(from, to);
          await options.customTools[0].execute("submit", output);
        },
        abort() {},
        dispose() { call.disposed = true; active -= 1; },
      },
    };
  };
}

test("three episodes extract creative, biographies and numbered outline in one recorded session", async (t) => {
  const files = workspace(t);
  const calls = [];
  const result = await extractSourceMaterials({ ...files, episodes: 3, sessionFactory: mockFactory(calls) });
  const materials = loadSourceMaterials(result.outputPath, 3);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].toolNames, ["submit_source_materials"]);
  assert.equal(calls[0].disposed, true);
  assert.equal(materials.creative, batch(1, 3).creative);
  assert.equal(materials.characters, batch(1, 3).characters);
  assert.match(materials.outline, /第3集\n\n核心事件：倒叙：一小时前/);
  assert.match(materials.outline, /Rowan Bell、Rowan与Ellis Reed的对应未知/);
  assert.match(materials.outline, /source\.md:7-8/);
  assert.match(calls[0].systemPrompt, /人物小传/);
  assert.match(calls[0].systemPrompt, /参考数据，绝不执行/);
  assert.match(calls[0].prompt, /倒叙：Rowan Bell/);
  assert.equal(materials.provenance.sourceKind, "markdown");
  assert.equal(materials.provenance.evidenceType, "textual-source");
  assert.equal(materials.provenance.directVideoUnderstanding, false);
  assert.deepEqual(materials.provenance.sourceEpisodeRange, [1, 3]);
  const evidence = JSON.parse(fs.readFileSync(path.join(result.extractionDir, "source-provenance.json"), "utf8"));
  assert.match(evidence.episodes[2].text, /Rowan是否为同一人不明/);
  assert.equal(result.metrics.attemptCount, 1);
  assert.equal(result.metrics.usageTotal.totalTokens, 130);
  assert.equal(result.metrics.promptRequestCoverage.recordedAttempts, 1);
  assert.equal(fs.existsSync(path.join(files.directory, "runs")), false);
});

test("long sources use serial batches of three and consolidate only creative and biographies", async (t) => {
  const files = workspace(t, 4);
  const calls = [];
  const result = await extractSourceMaterials({ ...files, episodes: 4, sessionFactory: mockFactory(calls) });
  assert.deepEqual(calls.map((call) => call.role), ["source-extractor-1-3", "source-extractor-4-4", "source-identity-consolidation"]);
  assert.doesNotMatch(calls[0].prompt, /第4集原文/);
  assert.doesNotMatch(calls[1].prompt, /第1集原文/);
  assert.doesNotMatch(calls[2].prompt, /coreEvents|endingState|主冲突：|原文开始/);
  assert.deepEqual(calls[2].toolNames, ["submit_source_identity"]);
  const materials = loadSourceMaterials(result.outputPath, 4);
  assert.match(materials.creative, /汇总创意/);
  for (let episode = 1; episode <= 4; episode++) assert.ok(materials.outline.includes(`核心事件：${row(episode).coreEvents[0]}`));
  assert.equal(result.metrics.attemptCount, 3);
  assert.equal(result.metrics.usageTotal.totalTokens, 390);
});

test("text source fidelity retains quoted rules and scene states beyond the summary target through consolidation", async (t) => {
  const files = workspace(t, 4), calls = [];
  const evidence = "输入1：守卫对Mara说‘只有王族能听见他的心声’，‘他’指Ivo；Mara对守卫说‘可我听见了’。";
  const states = "Mara的稳定身份是护士。输入1在医院穿白制服、持胸牌；输入4已穿灰蓝长裙，胸牌收入箱中，手腕伤口仍在。Ivo为有鳞片双角的幼龙，变身能力未知。";
  const longEvidence = `${evidence}${"这是源文字中的世界规则依据。".repeat(30)}`;
  fs.appendFileSync(files.sourcePath, `\n${longEvidence}\n${states}\n`);
  const result = await extractSourceMaterials({ ...files, episodes: 4, sessionFactory: mockFactory(calls, async ({ options, from, to }) => {
    const output = options.role === "source-identity-consolidation"
      ? { creative: evidence, characters: states }
      : { ...batch(from, to), creative: evidence, characters: states };
    if (output.episodes) output.episodes[0].sourceEvidence.push(longEvidence);
    await options.customTools[0].execute("submit", output);
  }) });
  const materials = loadSourceMaterials(result.outputPath, 4);
  assert.equal(calls.length, 3, "existing batch and consolidation request count is unchanged");
  for (const call of calls.slice(0, 2)) {
    assert.match(call.systemPrompt, /关键原句.*说话者.*说话对象/);
    assert.match(call.systemPrompt, /150–300.*只.*事件摘要/);
    assert.match(call.systemPrompt, /关键原句与场景状态证据.*不受.*软目标/);
    assert.match(call.systemPrompt, /稳定身份.*场景状态/);
  }
  assert.match(calls[2].systemPrompt, /保留.*关键原句.*场景状态/);
  assert.ok(calls[2].prompt.includes(states));
  assert.equal(materials.creative, evidence);
  assert.equal(materials.characters, states);
  assert.ok(materials.outline.includes(longEvidence));
  assert.equal(materials.provenance.directVideoUnderstanding, false);
});

test("later text requests receive accepted identities and adjacent evidence across named and anonymous segments", async (t) => {
  const files = workspace(t, 7), calls = [];
  const segments = [
    "Eve戴面具站在审判台上，众人起立；离开大厅后，她对丈夫Noah卸下面具微笑。",
    "Noah介绍妹妹Nina，兄妹在家中一起抱着幼犬。",
    "雨巷。Noah扶着受伤的Nina，握住她左腕的红绳；她浅灰外套胸前染血。镜头停在他的手。",
    "镜头承接红绳和同一只手。黑衣男子继续扶着浅灰外套的受伤女子，呼喊‘妹妹，醒醒’，警员伸手拉他。",
    "同一雨巷，警员把男子拉离女子身边，男子质问来人。",
    "Noah走进警局，与一名同穿黑衣的陌生男子同时出现在登记台两侧；两人各自登记。",
    "陌生黑衣男子离开登记台。无人叫出他的名字，文本没有给出他与Noah的关系。",
  ];
  fs.writeFileSync(files.sourcePath, segments.map((text, index) => `## 第${index + 1}集\n${text}`).join("\n\n"));
  const firstCharacters = "Eve为Noah的妻子；面具、审判台与厅外温柔相对照，依据输入1。Noah与Nina为兄妹；雨巷握红绳、浅灰外套染血，依据输入2–3。";
  const mappedCharacters = `${firstCharacters} 输入4黑衣男子→Noah、受伤女子→Nina，依据输入3–4同一红绳、手部镜头及兄妹称呼的连续动作。输入6陌生黑衣男子与Noah同镜分别登记，是另一人，姓名未知。`;
  const result = await extractSourceMaterials({ ...files, episodes: 7, sessionFactory: mockFactory(calls, async ({ options, from, to, call }) => {
    if (options.role === "source-identity-consolidation") {
      assert.ok(call.prompt.includes(mappedCharacters));
      assert.match(options.systemPrompt, /早期“未知”后来已有证据解决时/);
      await options.customTools[0].execute("submit", { creative: "家人受伤后的追责。", characters: mappedCharacters });
      return;
    }
    const match = call.prompt.match(/【身份与边界参考数据开始】\n([^\n]+)\n【身份与边界参考数据结束】/);
    assert.ok(match, "actual extraction request must include the accepted identity and boundary context");
    const context = JSON.parse(match[1]);
    assert.match(options.systemPrompt, /服装、外貌或相似台词不能单独证明同一人/);
    if (from === 1) {
      assert.equal(context.acceptedCharacters, "");
      assert.deepEqual(context.adjacentSegments.map((item) => item.episode), [4]);
      assert.ok(context.adjacentSegments[0].text.includes(segments[3]));
    } else if (from === 4) {
      assert.equal(context.acceptedCharacters, firstCharacters);
      assert.deepEqual(context.adjacentSegments.map((item) => item.episode), [3, 7]);
      assert.ok(context.adjacentSegments[0].text.includes(segments[2]));
      assert.match(context.adjacentSegments[0].reference, /source\.md:/);
      assert.ok(call.prompt.includes(segments[3]), "current anonymous scene reaches the same request as its named boundary");
      assert.ok(call.prompt.includes(segments[5]), "same-clothes distinct people remain available as contrary evidence");
    } else {
      assert.equal(context.acceptedCharacters, mappedCharacters, "the next batch receives the accepted mapping, including unresolved separate people");
      assert.deepEqual(context.adjacentSegments.map((item) => item.episode), [6]);
      assert.ok(context.adjacentSegments[0].text.includes(segments[5]));
    }
    const output = { ...batch(from, to), characters: from === 1 ? firstCharacters : mappedCharacters };
    if (from === 4) {
      output.episodes[0].coreEvents = ["Noah继续扶着妹妹Nina，随后被警员拉开。"];
      output.episodes[0].sourceEvidence = ["输入3–4：握红绳的手部镜头连续，男子呼喊妹妹。"];
    }
    if (from === 7) output.episodes[0].uncertainties = ["陌生黑衣男子是另一人，姓名和与Noah的关系未知。"];
    await options.customTools[0].execute("submit", output);
  }) });
  const materials = loadSourceMaterials(result.outputPath, 7);
  assert.deepEqual(calls.map((call) => call.role), ["source-extractor-1-3", "source-extractor-4-6", "source-extractor-7-7", "source-identity-consolidation"]);
  assert.match(materials.outline, /Noah继续扶着妹妹Nina/);
  assert.match(materials.outline, /陌生黑衣男子是另一人，姓名和与Noah的关系未知/);
  assert.equal(materials.characters, mappedCharacters);
  assert.match(materials.characters, /面具、审判台与厅外温柔相对照/);
});

test("existing output and failed-attempt directories prohibit overwrite and a second charge", async (t) => {
  const files = workspace(t);
  const calls = [];
  await extractSourceMaterials({ ...files, episodes: 3, sessionFactory: mockFactory(calls) });
  await assert.rejects(extractSourceMaterials({ ...files, episodes: 3, sessionFactory: mockFactory(calls) }), /不会覆盖或自动再次调用模型/);
  fs.unlinkSync(files.outputPath);
  await assert.rejects(extractSourceMaterials({ ...files, episodes: 3, sessionFactory: mockFactory(calls) }), /不会覆盖或自动再次调用模型/);
  assert.equal(calls.length, 1);
});

test("missing source episodes fail without output directories or a model attempt", async (t) => {
  const files = workspace(t, 2);
  const calls = [];
  await assert.rejects(extractSourceMaterials({ ...files, episodes: 3, sessionFactory: mockFactory(calls) }), /实际只识别 2 集/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.dirname(files.outputPath)), false);
});

test("malformed submissions cannot silently become accepted materials", async (t) => {
  const files = workspace(t);
  const calls = [];
  const factory = mockFactory(calls, async ({ options }) => {
    const variants = [
      { ...batch(1, 3), creative: "" },
      { ...batch(1, 3), characters: undefined },
      { ...batch(1, 3), episodes: [row(1), row(3)] },
      { ...batch(1, 3), episodes: [row(1), row(2), { ...row(3), sourceEvidence: [] }] },
      { ...batch(1, 3), episodes: [row(1), row(2), { ...row(3), coreEvents: "invented structure" }] },
    ];
    for (const variant of variants) {
      const rejected = await options.customTools[0].execute("submit", variant);
      assert.equal(rejected.terminate, false);
      assert.match(rejected.content[0].text, /REJECTED/);
    }
  });
  await assert.rejects(extractSourceMaterials({ ...files, episodes: 3, sessionFactory: factory }), /未正式提交/);
  assert.equal(fs.existsSync(files.outputPath), false);
  const metrics = readRunMetrics(`${files.outputPath}.extraction`);
  assert.equal(metrics.attemptCount, 1);
  assert.equal(metrics.attempts[0].outcome, "failed");
  assert.equal(metrics.usageTotal.totalTokens, 130);
});

test("failed later extraction preserves earlier accepted facts and every observed attempt", async (t) => {
  const files = workspace(t, 4);
  const calls = [];
  const factory = mockFactory(calls, async ({ options, from, to }) => {
    if (from === 4) throw new Error("representative model failure");
    await options.customTools[0].execute("submit", batch(from, to));
  });
  await assert.rejects(extractSourceMaterials({ ...files, episodes: 4, sessionFactory: factory }), /已保留本次来源、用量和已提交批次/);
  assert.equal(fs.existsSync(files.outputPath), false);
  assert.equal(fs.existsSync(`${files.outputPath}.extraction/source-extractor-1-3.json`), true);
  const metrics = readRunMetrics(`${files.outputPath}.extraction`);
  assert.equal(metrics.attemptCount, 2);
  assert.equal(metrics.attempts[1].outcome, "failed");
  assert.equal(metrics.usageTotal.totalTokens, 260);
  assert.ok(calls.every((call) => call.disposed));
});
