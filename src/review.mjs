import fs from "node:fs";
import path from "node:path";
import { loadManifest, readJson, taskPath, writeJson } from "./core.mjs";

export function normalizeFinding(finding) {
  const episode = Number(finding.episode);
  if (!Number.isInteger(episode) || episode < 1) throw new Error("review finding requires a positive episode");
  if (!['P0', 'P1', 'P2'].includes(finding.severity)) throw new Error("review finding has invalid severity");
  if (!['local', 'pair', 'upstream'].includes(finding.scope)) throw new Error("review finding has invalid scope");
  return { ...finding, episode };
}

export function normalizeSemanticFinding(finding, { stage, totalEpisodes, requireP2Disposition = true }) {
  const episode = stage === "planning" ? 0 : Number(finding.episode);
  if (stage !== "planning" && (!Number.isInteger(episode) || episode < 1 || episode > totalEpisodes)) {
    throw new Error("semantic finding has an invalid episode");
  }
  if (!["P0", "P1", "P2"].includes(finding.severity)) throw new Error("semantic finding has an invalid severity");
  if (!["local", "pair", "series", "upstream"].includes(finding.scope)) throw new Error("semantic finding has an invalid scope");
  const required = ["id", "category", "evidence", "reason", "acceptance", "repairInstruction"];
  for (const field of required) if (!String(finding[field] || "").trim()) throw new Error(`semantic finding requires ${field}`);
  const disposition = finding.severity === "P2" ? (finding.disposition || (requireP2Disposition ? null : "accepted_non_blocking")) : "repair";
  if (finding.severity === "P2" && !["repair", "accepted_non_blocking"].includes(disposition)) {
    throw new Error("P2 finding requires a disposition");
  }
  return {
    id: String(finding.id).trim(),
    stage,
    episode,
    severity: finding.severity,
    scope: finding.scope,
    category: String(finding.category).trim(),
    evidence: String(finding.evidence).trim(),
    reason: String(finding.reason).trim(),
    acceptance: String(finding.acceptance).trim(),
    repairInstruction: String(finding.repairInstruction).trim(),
    preserve: Array.isArray(finding.preserve) ? finding.preserve.map(String) : [],
    doNotChange: Array.isArray(finding.doNotChange) ? finding.doNotChange.map(String) : [],
    disposition,
  };
}

export function semanticRepairPlan(findings, {
  stage,
  totalEpisodes,
  cycle,
  maxCycles,
  systemicEpisodeThreshold = 3,
  priorFindingIds = [],
  artifactDigest,
  contractDigest,
  requireP2Disposition = true,
}) {
  const normalized = findings.map((finding) => normalizeSemanticFinding(finding, { stage, totalEpisodes, requireP2Disposition }));
  const repeated = new Set(priorFindingIds);
  const blockers = normalized.filter((finding) => finding.severity === "P0" || (
    finding.disposition === "repair" && stage !== "planning" && ["series", "upstream"].includes(finding.scope)
  ));
  const categories = new Map();
  for (const finding of normalized.filter((item) => item.severity !== "P2" || item.disposition === "repair")) {
    if (finding.episode > 0) categories.set(finding.category, new Set([...(categories.get(finding.category) || []), finding.episode]));
  }
  for (const [category, episodes] of categories) {
    if (episodes.size >= systemicEpisodeThreshold) blockers.push({ id: `systemic:${category}`, category, reason: `${category} affects ${episodes.size} episodes` });
  }
  const repairable = normalized.filter((finding) => finding.severity === "P1" || (finding.severity === "P2" && finding.disposition === "repair"));
  for (const finding of repairable) if (repeated.has(finding.id)) blockers.push({ ...finding, reason: `finding ${finding.id} survived the previous repair cycle` });
  if (blockers.length) return { stage, action: "blocked", cycle, artifactDigest, contractDigest, findings: normalized, reasons: blockers };
  if (repairable.length && cycle >= maxCycles) {
    return { stage, action: "blocked", cycle, artifactDigest, contractDigest, findings: normalized, reasons: [{ id: "repair-budget-exhausted", reason: `${stage} repair budget exhausted at cycle ${cycle}` }] };
  }
  const episodes = [...new Set(repairable.flatMap((finding) => {
    if (stage === "planning") return [0];
    return finding.scope === "pair" ? [finding.episode, Math.min(totalEpisodes, finding.episode + 1)] : [finding.episode];
  }))].sort((a, b) => a - b);
  return {
    stage,
    action: repairable.length ? "repair" : "pass",
    cycle,
    artifactDigest,
    contractDigest,
    episodes,
    findings: normalized,
  };
}

export function repairPlan(findings, totalEpisodes) {
  const normalized = findings.map(normalizeFinding);
  const systemic = normalized.filter((item) => item.scope === 'upstream' || item.severity === 'P0');
  if (systemic.length) return { action: 'blocked', reasons: systemic };
  const p1 = normalized.filter((item) => item.severity === 'P1');
  if (p1.length > 2) return { action: 'blocked', reasons: p1 };
  const episodes = [...new Set(p1.flatMap((item) => item.scope === 'pair' ? [item.episode, Math.min(totalEpisodes, item.episode + 1)] : [item.episode]))].sort((a,b)=>a-b);
  return { action: episodes.length ? 'repair' : 'pass', episodes, findings: p1 };
}

export function markStale(runDir, repairedEpisodes) {
  const manifest = loadManifest(runDir);
  const stale = new Set();
  for (const episode of repairedEpisodes) {
    stale.add(`storyboard-ep-${String(episode).padStart(2, '0')}`);
    if (episode < manifest.episodes) {
      stale.add(`screenplay-ep-${String(episode + 1).padStart(2, '0')}`);
      stale.add(`storyboard-ep-${String(episode + 1).padStart(2, '0')}`);
    }
  }
  for (const id of stale) {
    const file = taskPath(runDir, id);
    const prior = fs.existsSync(file) ? readJson(file) : { id };
    writeJson(file, { ...prior, state: 'stale', staleReason: 'upstream screenplay revised' });
  }
  return [...stale].sort();
}
