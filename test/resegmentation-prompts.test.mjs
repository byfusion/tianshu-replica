import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Compile } from '../src/experiments/lib.mjs';
import { planningBundleParameters, validatePlanningEpisodeSubmission, planningBudgetGuidance, planningSystemPrompt, completedPlanningMetrics } from '../src/agents.mjs';
import { createProductionContract, createReplicationProductionContract, episodeDurationPolicy } from '../src/production-contract.mjs';
import { reviewPrompt } from '../src/semantic-review.mjs';

const duration = { min: 60, max: 120 };
const mappedManifest = { productionRoute: 'tianshu-replication', scope: { kind: 'full-series' }, sourceEpisodes: 2, episodes: 2, state: 'planning' };
const map = [
  { sourceEpisodes: [1], startEvent: '珠子被送来', endEvent: 'Ava挡住托盘', targetSeconds: 67 },
  { sourceEpisodes: [1], startEvent: 'Ava解释误吞风险', endEvent: 'Knox吞珠后昏迷', targetSeconds: 68 },
  { sourceEpisodes: [2], startEvent: 'Ava争取救治', endEvent: 'Knox恢复呼吸', targetSeconds: 119 },
];
function bundle(count = 3, episodeMap = map) {
  return {
    market: { country: 'Fantasy', setting: 'An established dragon palace in the source material', characterNaming: 'Preserve the confirmed English character names', socialContext: 'Independent dragon clans and palace caregivers', culturalAnchors: ['Dragon palace', 'Clan council'] },
    acts: 'Existing plot and consequences remain intact. '.repeat(4),
    design: 'Preserve the specific source appeal and interactions. '.repeat(4),
    characters: 'Ava is the caregiver; Knox is the infant dragon. '.repeat(4),
    ledger: { names: ['Ava', 'Knox'], facts: ['Ava cares for Knox', 'Pearl is a hazard', 'The ceremony is in the palace'] },
    continuityContract: 'Preserve confirmed states; do not turn unknown relationships into facts. '.repeat(4),
    outline: Array.from({ length: count }, (_, i) => `Output ${i + 1}: preserve the assigned source events and their consequences without repeating the previous output.`),
    ...(episodeMap === undefined ? {} : { episodeMap }),
  };
}
function frozenLegacyContract() {
  const contract = createProductionContract({ screenplay: { episodeDurationSeconds: duration }, storyboard: { episodeDurationSeconds: duration } });
  delete contract.pacing;
  return contract;
}
function fixture(t, { writeMap = true, contract = frozenLegacyContract(), episodeMap = map } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tianshu-resegmentation-prompts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'canonical'));
  fs.mkdirSync(path.join(dir, 'metrics'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...mappedManifest, episodes: 3 }));
  fs.writeFileSync(path.join(dir, 'canonical', 'production-contract.json'), JSON.stringify(contract));
  if (writeMap) fs.writeFileSync(path.join(dir, 'canonical', 'episode-map.json'), JSON.stringify(episodeMap));
  return { dir, contract };
}

test('new replication tool accepts a variable output outline and requires a matching source map', () => {
  const schema = Compile(planningBundleParameters(mappedManifest, frozenLegacyContract()));
  assert.equal(schema.Check(bundle()), true, 'two source episodes can produce three output episodes');
  const missing = bundle();
  delete missing.episodeMap;
  assert.equal(schema.Check(missing), false);
  assert.deepEqual(validatePlanningEpisodeSubmission(mappedManifest, bundle(), { episodeDurationSeconds: duration }), []);
  assert.ok(validatePlanningEpisodeSubmission(mappedManifest, bundle(2), { episodeDurationSeconds: duration }).length, 'map and output lengths must match');
  assert.ok(validatePlanningEpisodeSubmission(mappedManifest, bundle(2, map.slice(0, 2)), { episodeDurationSeconds: duration }).length, 'source episode two cannot disappear');
});

test('legacy and sample planning keep the original fixed episode count', () => {
  const legacy = { ...mappedManifest };
  delete legacy.sourceEpisodes;
  const sample = { ...mappedManifest, scope: { kind: 'sample' } };
  for (const manifest of [legacy, sample]) {
    const schema = Compile(planningBundleParameters(manifest));
    const fixed = bundle(2);
    delete fixed.episodeMap;
    assert.equal(schema.Check(fixed), true);
    assert.equal(schema.Check(bundle(3)), false);
    assert.ok(validatePlanningEpisodeSubmission(manifest, bundle(3)).length);
  }
});

test('existing screenplay artifacts freeze output count and the event-to-output assignment', () => {
  const manifest = { ...mappedManifest, episodes: 3 };
  const options = { episodeDurationSeconds: duration, currentEpisodeMap: map, hasScreenplays: true };
  assert.deepEqual(validatePlanningEpisodeSubmission(manifest, bundle(), options), []);
  const changed = bundle();
  changed.episodeMap = map.map((entry) => ({ ...entry }));
  changed.episodeMap[1].startEvent = '另一段新的开始';
  assert.match(validatePlanningEpisodeSubmission(manifest, changed, options).join(';'), /new planning run/);
  const fewer = bundle(2, [{ ...map[0], endEvent: map[1].endEvent }, map[2]]);
  assert.match(validatePlanningEpisodeSubmission(manifest, fewer, options).join(';'), /new planning run/);
  assert.deepEqual(validatePlanningEpisodeSubmission(manifest, changed, { ...options, hasScreenplays: false }), [], 'a planning-only repair can adjust the split');
});

test('per-output timing uses the approved target instead of the same-number source episode', (t) => {
  const { dir, contract } = fixture(t);
  const second = planningBudgetGuidance(dir, 2, contract);
  const third = planningBudgetGuidance(dir, 3, contract);
  assert.match(second, /68 秒/);
  assert.match(third, /119 秒/);
  assert.match(second, /60–120 秒/);
  assert.match(second, /相邻输出集承担的源内容不得重复/);
});

test('planning resume requires a complete valid map as well as the output outline', (t) => {
  const { dir } = fixture(t, { writeMap: false });
  for (const name of ['acts.md', 'design.md', 'characters.md', 'ledger.json', 'continuity-contract.md', 'market.json', 'market-contract.md']) {
    fs.writeFileSync(path.join(dir, 'canonical', name), 'fixture');
  }
  fs.writeFileSync(path.join(dir, 'canonical', 'outline.md'), bundle().outline.map((text, i) => `## 第${i + 1}集\n${text}`).join('\n\n'));
  fs.writeFileSync(path.join(dir, 'metrics', 'planner-cycle-1.json'), JSON.stringify({ outcome: 'completed', completedAttempt: 1 }));
  assert.equal(completedPlanningMetrics(dir), null);
  fs.writeFileSync(path.join(dir, 'canonical', 'episode-map.json'), JSON.stringify(map));
  assert.equal(completedPlanningMetrics(dir).completedAttempt, 1);
  fs.writeFileSync(path.join(dir, 'canonical', 'episode-map.json'), JSON.stringify(map.slice(0, 2)));
  assert.equal(completedPlanningMetrics(dir), null);
});


test('planning schema separates the new target band from hard duration headroom and preserves old 120-second maps', () => {
  const current = createReplicationProductionContract();
  const policy = episodeDurationPolicy(current);
  const proposal = bundle(3, map.map((entry) => ({ ...entry, targetSeconds: 75 })));
  const schema = Compile(planningBundleParameters(mappedManifest, current));
  assert.equal(schema.Check(proposal), true);
  assert.deepEqual(validatePlanningEpisodeSubmission(mappedManifest, proposal, { episodeDurationSeconds: policy.hard, targetDurationSeconds: policy.target }), []);
  proposal.episodeMap[2].targetSeconds = 95;
  assert.equal(schema.Check(proposal), false, '95 is headroom, not a planning target');
  assert.ok(validatePlanningEpisodeSubmission(mappedManifest, proposal, { episodeDurationSeconds: policy.hard, targetDurationSeconds: policy.target }).length);
  const old = frozenLegacyContract();
  proposal.episodeMap[2].targetSeconds = 120;
  assert.equal(Compile(planningBundleParameters(mappedManifest, old)).Check(proposal), true);
  const oldPolicy = episodeDurationPolicy(old);
  assert.deepEqual(validatePlanningEpisodeSubmission(mappedManifest, proposal, { episodeDurationSeconds: oldPolicy.hard, targetDurationSeconds: oldPolicy.target }), []);
});

test('75-second preference reaches planning, generation and all review stages from the frozen contract', (t) => {
  const contract = createReplicationProductionContract();
  const episodeMap = map.map((entry) => ({ ...entry, targetSeconds: 75 }));
  const { dir } = fixture(t, { contract, episodeMap });
  const contexts = [planningSystemPrompt(mappedManifest, contract), planningBudgetGuidance(dir, 2, contract)];
  for (const stage of ['planning', 'screenplay', 'storyboard']) contexts.push(reviewPrompt(stage, 'frozen production contract', mappedManifest, contract));
  for (const context of contexts) {
    assert.match(context, /目标 60–90 秒/);
    assert.match(context, /常态 75 秒/);
    assert.match(context, /硬范围 60–100 秒/);
    assert.match(context, /超过 90 秒至 100 秒仅作自然结尾余量/);
    assert.match(context, /非阻断提醒/);
    assert.match(context, /超过 100 秒应在规划时/);
    assert.doesNotMatch(context, /60–120秒|60–120 seconds/);
  }
});

test('frozen runs without pacing retain their previous target and have no invented 75-second preference', (t) => {
  const contract = frozenLegacyContract();
  const { dir } = fixture(t, { contract });
  for (const context of [planningSystemPrompt(mappedManifest, contract), planningBudgetGuidance(dir, 3, contract), reviewPrompt('storyboard', 'old contract', mappedManifest, contract)]) {
    assert.match(context, /目标 60–120 秒/);
    assert.match(context, /硬范围 60–120 秒/);
    assert.doesNotMatch(context, /常态 75 秒|90 秒至 100 秒/);
  }
});
