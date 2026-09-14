import fs from "node:fs";
import path from "node:path";
import { resolveTextModel, TEXT_MODEL_PROFILES } from "./model-profiles.mjs";

export const executionContractPath = (runDir) => path.join(runDir, "canonical", "execution-contract.json");

export function writeExecutionContract(runDir, { binding = "created", effectiveAt = new Date().toISOString(), ...selection } = {}) {
  if (!["created", "legacy-bound"].includes(binding)) throw new Error("invalid text execution binding");
  const contract = {
    schemaVersion: 1, kind: "tianshu-text-execution", ...resolveTextModel(selection), binding, effectiveAt,
    ...(binding === "legacy-bound" ? { historicalModel: "unknown", appliesTo: "subsequent-execution-only" } : {}),
  };
  const file = executionContractPath(runDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx" });
  return contract;
}

export function textModelForRun(runDir) {
  const file = executionContractPath(runDir);
  if (!fs.existsSync(file)) {
    const error = new Error("Tianshu run is legacy-unbound; use bind-model <run> --model kimi|deepseek|gpt to bind subsequent execution explicitly. Historical model use remains unknown.");
    error.code = "TIANSHU_LEGACY_UNBOUND";
    throw error;
  }
  const contract = JSON.parse(fs.readFileSync(file, "utf8"));
  const profile = TEXT_MODEL_PROFILES[contract.family];
  if (contract.schemaVersion !== 1 || contract.kind !== "tianshu-text-execution" || !profile
    || contract.provider !== profile.provider || contract.id !== profile.id
    || typeof contract.agentDir !== "string" || !path.isAbsolute(contract.agentDir)
    || !["created", "legacy-bound"].includes(contract.binding) || !Number.isFinite(Date.parse(contract.effectiveAt))) {
    throw new Error(`invalid Tianshu text execution contract: ${file}`);
  }
  return { ...profile, agentDir: contract.agentDir, binding: contract.binding, effectiveAt: contract.effectiveAt };
}

export function executionContractStatus(runDir) {
  return fs.existsSync(executionContractPath(runDir))
    ? { status: "frozen", ...textModelForRun(runDir) }
    : { status: "legacy-unbound", historicalModel: "unknown" };
}

export function bindRunModel(runDir, options) {
  if (!fs.existsSync(path.join(runDir, "manifest.json"))) throw new Error("run manifest is missing");
  if (!options?.model) throw new Error("bind-model requires --model kimi|deepseek|gpt");
  return writeExecutionContract(runDir, { ...options, binding: "legacy-bound" });
}

// Source extraction has no production run. Its text model is selected independently.
export function textModelForSession(runDir) {
  if (fs.existsSync(executionContractPath(runDir))) return textModelForRun(runDir);
  const manifestFile = path.join(runDir, "manifest.json");
  if (fs.existsSync(path.join(runDir, "canonical", "production-contract.json"))) return textModelForRun(runDir);
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.productionRoute || manifest.episodes) return textModelForRun(runDir);
  }
  return { ...resolveTextModel(), binding: "independent-source-or-experiment" };
}
