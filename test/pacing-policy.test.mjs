import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLegacyProductionContract,
  createProductionContract,
  createReplicationProductionContract,
  episodeDurationPolicy,
  loadProductionContract,
  productionContractMarkdown,
  replicationContractErrors,
  validateProductionContract,
} from "../src/production-contract.mjs";

const hardRanges = (min, max) => ({
  screenplay: { episodeDurationSeconds: { min, max } },
  storyboard: { episodeDurationSeconds: { min, max } },
});

test("new full replication separates the 60–90 second target, preferred 75, and hard 100 ceiling", () => {
  const contract = createReplicationProductionContract();
  assert.equal(contract.contractVersion, "source-replication-short-episodes@2");
  assert.deepEqual(contract.screenplay.episodeDurationSeconds, { min: 60, max: 100 });
  assert.deepEqual(contract.storyboard.episodeDurationSeconds, { min: 60, max: 100 });
  assert.deepEqual(contract.pacing, { targetDurationSeconds: { min: 60, max: 90 }, preferredDurationSeconds: 75 });
  assert.deepEqual(episodeDurationPolicy(contract), { target: { min: 60, max: 90 }, preferred: 75, hard: { min: 60, max: 100 } });
  const markdown = productionContractMarkdown(contract);
  assert.match(markdown, /每集目标时长：60–90 秒/);
  assert.match(markdown, /每集推荐时长：75 秒/);
  assert.match(markdown, /每集硬性时长：60–100 秒（上限 100 秒）/);
});

test("new replication rejects a 120-second hard ceiling, targets above 90, and mismatched stage ranges", () => {
  assert.throws(() => createReplicationProductionContract(hardRanges(60, 120)), /within 60–100 seconds/);
  assert.throws(() => createReplicationProductionContract({
    pacing: { targetDurationSeconds: { min: 60, max: 100 }, preferredDurationSeconds: 75 },
  }), /target duration must not exceed 90/);
  assert.throws(() => createReplicationProductionContract({ screenplay: { episodeDurationSeconds: { min: 60, max: 90 } } }), /ranges must match/);
  assert.match(replicationContractErrors(createLegacyProductionContract()).join("; "), /within 60–100 seconds/);
});

test("a complete custom contract without pacing receives the intersection target without mutating its input", () => {
  const custom = createProductionContract({ ...hardRanges(60, 75), profile: "custom-short", contractVersion: "custom-short@1" });
  const before = structuredClone(custom);
  const contract = createReplicationProductionContract(custom);
  assert.deepEqual(contract.pacing, { targetDurationSeconds: { min: 60, max: 75 }, preferredDurationSeconds: 75 });
  assert.deepEqual(contract.screenplay.episodeDurationSeconds, { min: 60, max: 75 });
  assert.equal(contract.profile, "custom-short");
  assert.deepEqual(custom, before);
  assert.equal(Object.hasOwn(custom, "pacing"), false);
  assert.deepEqual(episodeDurationPolicy(createReplicationProductionContract(hardRanges(80, 100))), {
    target: { min: 80, max: 90 }, preferred: 80, hard: { min: 80, max: 100 },
  });
});

test("explicit pacing is retained and validated instead of silently clamped", () => {
  const explicit = { targetDurationSeconds: { min: 65, max: 75 }, preferredDurationSeconds: 70 };
  const contract = createReplicationProductionContract({ ...hardRanges(60, 75), pacing: explicit });
  assert.deepEqual(contract.pacing, explicit);
  assert.throws(() => createReplicationProductionContract({ ...hardRanges(60, 75), pacing: { ...explicit, preferredDurationSeconds: 76 } }), /preferredDurationSeconds must be within/);
  assert.throws(() => createReplicationProductionContract({ ...hardRanges(60, 75), pacing: { targetDurationSeconds: { min: 60, max: 90 }, preferredDurationSeconds: 75 } }), /targetDurationSeconds must be within/);
  assert.throws(() => createReplicationProductionContract({ pacing: null }), /pacing must be an object/);
  assert.throws(() => createReplicationProductionContract({ pacing: { targetDurationSeconds: { min: 60, max: 90 } } }), /preferredDurationSeconds/);
  assert.throws(() => createReplicationProductionContract(hardRanges(95, 100)), /targetDurationSeconds.min must not exceed/);
});

test("frozen contracts without pacing retain their 120-second range through load and projection without disk writes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-frozen-pacing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "canonical"));
  const frozen = createProductionContract({
    ...hardRanges(60, 120),
    profile: "source-replication-short-episodes",
    contractVersion: "source-replication-short-episodes@1",
  });
  const file = path.join(dir, "canonical", "production-contract.json");
  const originalText = JSON.stringify(frozen, null, 2) + "\n";
  fs.writeFileSync(file, originalText);
  const loaded = loadProductionContract(dir);
  assert.deepEqual(validateProductionContract(loaded), []);
  assert.deepEqual(loaded, frozen);
  assert.deepEqual(episodeDurationPolicy(loaded), { target: { min: 60, max: 120 }, preferred: null, hard: { min: 60, max: 120 } });
  const markdown = productionContractMarkdown(loaded);
  assert.match(markdown, /每集目标时长：60–120 秒/);
  assert.doesNotMatch(markdown, /推荐时长|硬性时长/);
  assert.equal(fs.readFileSync(file, "utf8"), originalText);
  assert.equal(Object.hasOwn(loaded, "pacing"), false);
});

test("general contract validation applies pacing only when present and keeps target inside both hard ranges", () => {
  const original = createProductionContract();
  assert.equal(Object.hasOwn(original, "pacing"), false);
  assert.deepEqual(episodeDurationPolicy(original), { target: { min: 90, max: 100 }, preferred: null, hard: { min: 90, max: 100 } });
  const custom = createProductionContract({ ...hardRanges(90, 120), pacing: { targetDurationSeconds: { min: 100, max: 110 }, preferredDurationSeconds: 105 } });
  assert.deepEqual(validateProductionContract(custom), []);
  assert.match(replicationContractErrors(custom).join("; "), /target duration must not exceed 90/);
  const invalid = structuredClone(custom);
  invalid.screenplay.episodeDurationSeconds.max = 105;
  assert.match(validateProductionContract(invalid).join("; "), /within screenplay.episodeDurationSeconds/);
  invalid.pacing.preferredDurationSeconds = "105";
  assert.match(validateProductionContract(invalid).join("; "), /preferredDurationSeconds must be an integer/);
});
