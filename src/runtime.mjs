import { episodeDurationPolicy } from "./production-contract.mjs";
import { deliveryTiming } from "./delivery-timing.mjs";
import { loadEpisodeMap } from "./episode-map.mjs";
import fs from "node:fs";
import path from "node:path";
import { applyRepair, produceScripts, produceStoryboards, reviewScripts, reviewStoryboards, screenplayChecks, storyboardChecks } from "./agents.mjs";
import { continuityIsAccepted, openingContinuityState } from "./continuity.mjs";
import { loadManifest, markdownDelivery, readJson, readText, saveManifest, sha, taskPath, writeJson } from "./core.mjs";
import { canonicalPersonNames } from "./entities.mjs";
import { marketArtifactDigest } from "./market.mjs";
import { loadProductionContract, productionContractDigest } from "./production-contract.mjs";
import { stageArtifactDigest } from "./semantic-review.mjs";
import { deliveryScope } from "./sample.mjs";

const ep = (value) => String(value).padStart(2, "0");

export function appendRunEvent(runDir, event) {
  const record = { at: new Date().toISOString(), ...event };
  fs.appendFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify(record)}\n`);
  return record;
}

export async function withRunLock(runDir, operation) {
  const lockFile = path.join(runDir, ".lock");
  let handle;
  try {
    handle = fs.openSync(lockFile, "wx");
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`run is already locked: ${lockFile}`);
    throw error;
  }
  try {
    return await operation();
  } finally {
    fs.closeSync(handle);
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  }
}

export function readRunLock(runDir) {
  const file = path.join(runDir, ".lock");
  return fs.existsSync(file) ? { file, ...readJson(file) } : null;
}

export function clearStaleRunLock(runDir, minimumAgeMs = 3_600_000) {
  const lock = readRunLock(runDir);
  if (!lock) return { cleared: false, reason: "no lock" };
  const ageMs = Date.now() - Date.parse(lock.startedAt);
  if (!Number.isFinite(ageMs) || ageMs < minimumAgeMs) throw new Error("lock is not old enough to clear");
  let running = false;
  try { process.kill(Number(lock.pid), 0); running = true; } catch (error) { if (error.code === "EPERM") running = true; else if (error.code !== "ESRCH") throw error; }
  if (running) throw new Error(`lock owner PID ${lock.pid} is still running`);
  fs.unlinkSync(lock.file);
  appendRunEvent(runDir, { type: "stale_lock_cleared", actorRole: "ExternalOrchestrator", pid: lock.pid, ageMs });
  return { cleared: true, pid: lock.pid, ageMs };
}

function assertFinalReview(runDir, stage, contractDigest, marketDigest) {
  const file = path.join(runDir, "reviews", `${stage}-final.json`);
  if (!fs.existsSync(file)) throw new Error(`missing ${stage} final review attestation`);
  const report = readJson(file);
  if (report.plan?.action !== "pass") throw new Error(`${stage} final review did not pass`);
  if (report.contractDigest !== contractDigest) throw new Error(`${stage} final review contract mismatch`);
  if (report.marketDigest !== marketDigest) throw new Error(`${stage} final review market mismatch`);
  if (report.artifactDigest !== stageArtifactDigest(runDir, stage)) throw new Error(`${stage} final review artifact mismatch`);
  for (const finding of report.plan.findings || []) {
    if (["P0", "P1"].includes(finding.severity)) throw new Error(`${stage} final review contains unresolved ${finding.severity}`);
    if (finding.severity === "P2" && finding.disposition !== "accepted_non_blocking") throw new Error(`${stage} final review contains unresolved P2`);
  }
  return report;
}

export function assertContinuityChain(runDir, totalEpisodes) {
  const contractDigest=sha(readText(path.join(runDir,"canonical","continuity-contract.md")));let previousDigest=openingContinuityState().snapshotDigest;
  for(let episode=1;episode<=totalEpisodes;episode++){
    const screenplay=readText(path.join(runDir,"screenplay",`ep-${ep(episode)}.md`)),task=readJson(taskPath(runDir,`screenplay-ep-${ep(episode)}`)),continuity=readJson(path.join(runDir,"continuity",`ep-${ep(episode)}.json`));
    if(!continuityIsAccepted(runDir,episode,sha(screenplay)))throw new Error(`screenplay ${episode} continuity is not accepted`);
    if(continuity.contractDigest!==contractDigest)throw new Error(`continuity ${episode} contract mismatch`);
    if(continuity.previousSnapshotDigest!==previousDigest)throw new Error(`continuity ${episode} chain mismatch`);
    if(task.previousContinuityDigest!==continuity.previousSnapshotDigest||task.continuityDigest!==continuity.snapshotDigest)throw new Error(`screenplay task ${episode} continuity digest mismatch`);
    const eventFile=path.join(runDir,continuity.event||"");if(!continuity.event||!fs.existsSync(eventFile))throw new Error(`continuity ${episode} source event is missing`);const event=readJson(eventFile);if(event.previousSnapshotDigest!==continuity.previousSnapshotDigest||event.screenplayDigest!==continuity.screenplayDigest||event.screenplayDigest!==sha(screenplay)||sha(event.currentSnapshot||"")!==continuity.snapshotDigest)throw new Error(`continuity ${episode} source event mismatch`);previousDigest=continuity.snapshotDigest;
  }
  const current=readJson(path.join(runDir,"continuity","current.json"));if(current.lastEpisode!==totalEpisodes||current.snapshotDigest!==previousDigest||sha(current.snapshot||"")!==current.snapshotDigest)throw new Error("current continuity snapshot does not match the accepted chain");
  return {lastEpisode:totalEpisodes,snapshotDigest:previousDigest,contractDigest};
}

export function deliveryGate(runDir) {
  const manifest = loadManifest(runDir);
  loadEpisodeMap(runDir);
  const contract = loadProductionContract(runDir), contractDigest = productionContractDigest(contract);
  const marketFile = path.join(runDir, "canonical", "market.json"), marketContractFile = path.join(runDir, "canonical", "market-contract.md");
  if (!fs.existsSync(marketFile) || !fs.existsSync(marketContractFile)) throw new Error("missing market contract");
  const market = readJson(marketFile), marketDigest = marketArtifactDigest(runDir);
  const charactersFile = path.join(runDir, "canonical", "characters.md"), ledgerFile = path.join(runDir, "canonical", "ledger.json");
  const names = canonicalPersonNames(readText(charactersFile), readJson(ledgerFile).names || []);
  const screenplayDigests = [], storyboardDigests = [];assertContinuityChain(runDir,manifest.episodes);
  for (let episode = 1; episode <= manifest.episodes; episode++) {
    const screenplayFile = path.join(runDir, "screenplay", `ep-${ep(episode)}.md`), storyboardFile = path.join(runDir, "storyboard", `ep-${ep(episode)}.md`);
    if (!fs.existsSync(screenplayFile) || !fs.existsSync(storyboardFile)) throw new Error(`missing episode ${episode} artifacts`);
    const screenplay = readText(screenplayFile), storyboard = readText(storyboardFile);
    const screenplayTask = readJson(taskPath(runDir, `screenplay-ep-${ep(episode)}`));
    if (screenplayTask.state !== "passed" || screenplayTask.digest !== sha(screenplay)) throw new Error(`screenplay task ${episode} is stale or mismatched`);
    if (screenplayTask.contractDigest !== contractDigest || screenplayTask.marketDigest !== marketDigest) throw new Error(`screenplay task ${episode} input contract mismatch`);
    const screenplayErrors = screenplayChecks(screenplay, episode, market, names, contract, manifest.productionRoute);
    if (screenplayErrors.length) throw new Error(`screenplay ${episode}: ${[...new Set(screenplayErrors)].join("; ")}`);
    const storyboardTask = readJson(taskPath(runDir, `storyboard-ep-${ep(episode)}`));
    if (storyboardTask.state !== "passed" || storyboardTask.digest !== sha(storyboard)) throw new Error(`storyboard task ${episode} is stale or mismatched`);
    if (storyboardTask.contractDigest !== contractDigest || storyboardTask.marketDigest !== marketDigest || storyboardTask.sourceScreenplayDigest !== sha(screenplay)) throw new Error(`storyboard task ${episode} input contract mismatch`);
    const marketErrors = storyboardChecks(storyboard, market, names, contract, manifest.productionRoute);
    if (marketErrors.length) throw new Error(`storyboard ${episode}: ${[...new Set(marketErrors)].join("; ")}`);
    screenplayDigests.push(sha(screenplay));storyboardDigests.push(sha(storyboard));
  }
  const reviews = {
    planning: assertFinalReview(runDir, "planning", contractDigest, marketDigest),
    screenplay: assertFinalReview(runDir, "screenplay", contractDigest, marketDigest),
    storyboard: assertFinalReview(runDir, "storyboard", contractDigest, marketDigest),
  };
  const markdown = markdownDelivery(runDir);
  const timing = deliveryTiming(markdown), policy = episodeDurationPolicy(contract);
  const report = {
    ...deliveryScope(manifest),
    ...(manifest.sourceEpisodes ? { sourceEpisodes: manifest.sourceEpisodes } : {}),
    timing,
    ...(contract.pacing ? { durationPolicy: policy, overTargetEpisodes: timing.episodes.filter((episode) => episode.seconds > policy.target.max) } : {}),
    passedAt: new Date().toISOString(),
    contractDigest,
    screenplayDigest: sha(screenplayDigests.join("\n")),
    storyboardDigest: sha(storyboardDigests.join("\n")),
    markdownDigest: sha(markdown),
    reviewCycles: Object.fromEntries(Object.entries(reviews).map(([stage, review]) => [stage, review.cycle])),
  };
  writeJson(path.join(runDir, "reviews", "delivery-readiness.json"), report);
  return report;
}

const defaultOperations = { produceScripts, reviewScripts, applyRepair, produceStoryboards, reviewStoryboards, deliveryGate };

async function runProductionUnlocked(runDir, operations) {
    appendRunEvent(runDir, { type: "production_started", actorRole: "Runtime" });
    try {
    for (let step = 0; step < 30; step++) {
      const before = loadManifest(runDir), state = before.state;
      if (["needs_human_review", "awaiting_delivery_approval", "ready_to_deliver", "delivered"].includes(state)) return before;
      if (["approved", "screenplay_producing", "screenplay_repairing"].includes(state)) await operations.produceScripts(runDir);
      else if (state === "screenplay_reviewing") {
        const report = await operations.reviewScripts(runDir);
        appendRunEvent(runDir,{type:"semantic_review",actorRole:"ScreenplaySeriesReviewer",stage:"screenplay",cycle:report.cycle,action:report.plan.action});
        if (report.plan.action === "repair") {operations.applyRepair(runDir, report);appendRunEvent(runDir,{type:"repair_dispatched",actorRole:"Runtime",stage:"screenplay",cycle:report.cycle,episodes:report.plan.episodes});}
      } else if (state === "screenplay_passed") await operations.produceStoryboards(runDir);
      else if (["storyboard_producing", "storyboard_repairing"].includes(state)) await operations.produceStoryboards(runDir);
      else if (state === "storyboard_reviewing") {
        const report = await operations.reviewStoryboards(runDir);
        appendRunEvent(runDir,{type:"semantic_review",actorRole:"StoryboardSeriesReviewer",stage:"storyboard",cycle:report.cycle,action:report.plan.action});
        if (report.plan.action === "repair") {operations.applyRepair(runDir, report);appendRunEvent(runDir,{type:"repair_dispatched",actorRole:"Runtime",stage:"storyboard",cycle:report.cycle,episodes:report.plan.episodes});}
      } else if (state === "final_review") {
        const readiness = operations.deliveryGate(runDir), contract = loadProductionContract(runDir), current = loadManifest(runDir);
        current.state = contract.delivery.autoDeliver ? "ready_to_deliver" : "awaiting_delivery_approval";
        current.note = "all deterministic and semantic delivery gates passed";
        current.deliveryReadinessDigest = sha(JSON.stringify(readiness));
        saveManifest(runDir, current);
        appendRunEvent(runDir,{type:"delivery_gate_passed",actorRole:"Runtime",readinessDigest:current.deliveryReadinessDigest});
      } else throw new Error(`run cannot continue from ${state}`);
      const after = loadManifest(runDir);
      appendRunEvent(runDir, { type: "state_progress", actorRole: "Runtime", from: state, to: after.state });
      if (after.state === state) throw new Error(`run made no progress from ${state}`);
    }
    throw new Error("production state machine exceeded its step budget");
    } catch (error) {
      appendRunEvent(runDir,{type:"production_interrupted",actorRole:"Runtime",state:loadManifest(runDir).state,error:error.message});
      throw error;
    }
}

export async function runProduction(runDir, operations = defaultOperations, { lock = true } = {}) {
  return lock ? withRunLock(runDir, () => runProductionUnlocked(runDir, operations)) : runProductionUnlocked(runDir, operations);
}
