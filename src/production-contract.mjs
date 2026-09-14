import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PRODUCTION_CONTRACT_SCHEMA_VERSION = "1.0.0";
export const PRODUCTION_CONTRACT_VERSION = "female-vertical-short-drama@1";
export const LEGACY_PRODUCTION_CONTRACT_VERSION = "legacy-unversioned-run@1";
export const PRODUCTION_CONTRACT_FILE = path.join("canonical", "production-contract.json");

const DEFAULT_CONTRACT = Object.freeze({
  schemaVersion: PRODUCTION_CONTRACT_SCHEMA_VERSION,
  contractVersion: PRODUCTION_CONTRACT_VERSION,
  profile: "female-vertical-short-drama",
  legacy: false,
  format: {
    audience: "female",
    orientation: "vertical",
    form: "short-drama",
  },
  screenplay: {
    episodeDurationSeconds: { min: 90, max: 100 },
    maxScenes: 4,
    englishDialogueWordLimit: 260,
  },
  storyboard: {
    episodeDurationSeconds: { min: 90, max: 100 },
    shotCount: { min: 12, max: 24 },
    shotDurationSeconds: { min: 3, max: 10 },
  },
  promotion: {
    requiredEpisodes: [1, 2, 3],
    coldOpenWithinSeconds: 3,
    requireSemanticHook: true,
    requirePromotionalClip: true,
  },
  revision: {
    maxSemanticRounds: {
      planning: 3,
      screenplay: 3,
      storyboard: 3,
    },
    systemicEpisodeThreshold: 3,
    maxContinuityRepairAttempts: 2,
    requireP2Disposition: true,
  },
  delivery: {
    autoDeliver: true,
  },
});

const LEGACY_CONTRACT = Object.freeze({
  schemaVersion: PRODUCTION_CONTRACT_SCHEMA_VERSION,
  contractVersion: LEGACY_PRODUCTION_CONTRACT_VERSION,
  profile: "legacy-unversioned-run",
  legacy: true,
  format: {
    audience: "unspecified",
    orientation: "vertical",
    form: "short-drama",
  },
  screenplay: {
    episodeDurationSeconds: { min: 60, max: 120 },
    maxScenes: 4,
    englishDialogueWordLimit: 260,
  },
  storyboard: {
    episodeDurationSeconds: { min: 60, max: 120 },
    shotCount: { min: 12, max: 24 },
    shotDurationSeconds: { min: 3, max: 10 },
  },
  promotion: {
    requiredEpisodes: [],
    coldOpenWithinSeconds: 3,
    requireSemanticHook: false,
    requirePromotionalClip: false,
  },
  revision: {
    maxSemanticRounds: {
      planning: 0,
      screenplay: 0,
      storyboard: 0,
    },
    systemicEpisodeThreshold: 3,
    maxContinuityRepairAttempts: 2,
    requireP2Disposition: false,
  },
  delivery: {
    autoDeliver: false,
  },
});

function clone(value) {
  return structuredClone(value);
}

function merge(base, overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return overrides === undefined ? clone(base) : clone(overrides);
  const result = base && typeof base === "object" && !Array.isArray(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(result[key], value)
      : clone(value);
  }
  return result;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function integer(errors, value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) errors.push(`${label} must be an integer >= ${minimum}`);
}

function range(errors, value, label, minimum = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be a range object`);
    return;
  }
  integer(errors, value.min, `${label}.min`, minimum);
  integer(errors, value.max, `${label}.max`, minimum);
  if (Number.isInteger(value.min) && Number.isInteger(value.max) && value.min > value.max) {
    errors.push(`${label}.min must not exceed ${label}.max`);
  }
}

function boolean(errors, value, label) {
  if (typeof value !== "boolean") errors.push(`${label} must be boolean`);
}

export function createProductionContract(overrides = {}) {
  const contract = merge(DEFAULT_CONTRACT, overrides);
  const errors = validateProductionContract(contract);
  if (errors.length) throw new Error(`invalid production contract: ${errors.join("; ")}`);
  return contract;
}

export function replicationContractErrors(contract) {
  const errors = validateProductionContract(contract);
  if (errors.length) return errors;
  for (const stage of ["screenplay", "storyboard"]) {
    const range = contract[stage].episodeDurationSeconds;
    if (range.min < 60 || range.max > 100) {
      errors.push(`new full-series replication requires ${stage}.episodeDurationSeconds within 60–100 seconds; split the source into more output episodes instead of extending individual episodes`);
    }
  }
  const screenplay = contract.screenplay.episodeDurationSeconds;
  const storyboard = contract.storyboard.episodeDurationSeconds;
  if (screenplay.min !== storyboard.min || screenplay.max !== storyboard.max) {
    errors.push("replication screenplay and storyboard episode-duration ranges must match");
  }
  if (contract.pacing?.targetDurationSeconds.max > 90) errors.push("new full-series replication target duration must not exceed 90 seconds");
  return errors;
}

export function createReplicationProductionContract(overrides = {}) {
  const settings = merge({
    contractVersion: "source-replication-short-episodes@2",
    profile: "source-replication-short-episodes",
    screenplay: { episodeDurationSeconds: { min: 60, max: 100 } },
    storyboard: {
      episodeDurationSeconds: { min: 60, max: 100 },
      shotCount: { min: 8, max: 32 },
    },
  }, overrides);
  if (settings?.pacing === undefined && settings && typeof settings === "object" && !Array.isArray(settings)) {
    const screenplay = settings.screenplay?.episodeDurationSeconds;
    const storyboard = settings.storyboard?.episodeDurationSeconds;
    const min = Math.max(60, screenplay?.min ?? 60, storyboard?.min ?? 60);
    const max = Math.min(90, screenplay?.max ?? 100, storyboard?.max ?? 100);
    settings.pacing = {
      targetDurationSeconds: { min, max },
      preferredDurationSeconds: Math.min(max, Math.max(min, 75)),
    };
  }
  const contract = createProductionContract(settings);
  const errors = replicationContractErrors(contract);
  if (errors.length) throw new Error(`invalid replication contract: ${errors.join("; ")}`);
  return contract;
}

export function createLegacyProductionContract(overrides = {}) {
  const contract = merge(LEGACY_CONTRACT, overrides);
  const errors = validateProductionContract(contract);
  if (errors.length) throw new Error(`invalid legacy production contract: ${errors.join("; ")}`);
  return contract;
}

export function validateProductionContract(contract) {
  const errors = [];
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return ["contract must be an object"];
  if (contract.schemaVersion !== PRODUCTION_CONTRACT_SCHEMA_VERSION) errors.push(`unsupported schemaVersion ${String(contract.schemaVersion)}`);
  if (typeof contract.contractVersion !== "string" || !contract.contractVersion.trim()) errors.push("contractVersion must be a non-empty string");
  if (typeof contract.profile !== "string" || !contract.profile.trim()) errors.push("profile must be a non-empty string");
  boolean(errors, contract.legacy, "legacy");

  if (!contract.format || typeof contract.format !== "object") errors.push("format must be an object");
  else {
    if (!['female', 'unspecified'].includes(contract.format.audience)) errors.push("format.audience must be female or unspecified");
    if (contract.format.orientation !== "vertical") errors.push("format.orientation must be vertical");
    if (contract.format.form !== "short-drama") errors.push("format.form must be short-drama");
  }

  if (!contract.screenplay || typeof contract.screenplay !== "object") errors.push("screenplay must be an object");
  else {
    range(errors, contract.screenplay.episodeDurationSeconds, "screenplay.episodeDurationSeconds", 1);
    integer(errors, contract.screenplay.maxScenes, "screenplay.maxScenes", 1);
    integer(errors, contract.screenplay.englishDialogueWordLimit, "screenplay.englishDialogueWordLimit", 1);
  }

  if (!contract.storyboard || typeof contract.storyboard !== "object") errors.push("storyboard must be an object");
  else {
    range(errors, contract.storyboard.episodeDurationSeconds, "storyboard.episodeDurationSeconds", 1);
    range(errors, contract.storyboard.shotCount, "storyboard.shotCount", 1);
    range(errors, contract.storyboard.shotDurationSeconds, "storyboard.shotDurationSeconds", 1);
  }

  if (contract.pacing !== undefined) {
    if (!contract.pacing || typeof contract.pacing !== "object" || Array.isArray(contract.pacing)) errors.push("pacing must be an object");
    else {
      const target = contract.pacing.targetDurationSeconds;
      const preferred = contract.pacing.preferredDurationSeconds;
      range(errors, target, "pacing.targetDurationSeconds", 1);
      integer(errors, preferred, "pacing.preferredDurationSeconds", 1);
      for (const stage of ["screenplay", "storyboard"]) {
        const hard = contract[stage]?.episodeDurationSeconds;
        if (target && hard && (target.min < hard.min || target.max > hard.max)) {
          errors.push(`pacing.targetDurationSeconds must be within ${stage}.episodeDurationSeconds`);
        }
      }
      if (target && Number.isInteger(preferred) && (preferred < target.min || preferred > target.max)) {
        errors.push("pacing.preferredDurationSeconds must be within pacing.targetDurationSeconds");
      }
    }
  }

  if (!contract.promotion || typeof contract.promotion !== "object") errors.push("promotion must be an object");
  else {
    if (!Array.isArray(contract.promotion.requiredEpisodes)
      || contract.promotion.requiredEpisodes.some((episode) => !Number.isInteger(episode) || episode < 1)
      || new Set(contract.promotion.requiredEpisodes).size !== contract.promotion.requiredEpisodes.length) {
      errors.push("promotion.requiredEpisodes must contain unique positive episode integers");
    }
    integer(errors, contract.promotion.coldOpenWithinSeconds, "promotion.coldOpenWithinSeconds", 1);
    boolean(errors, contract.promotion.requireSemanticHook, "promotion.requireSemanticHook");
    boolean(errors, contract.promotion.requirePromotionalClip, "promotion.requirePromotionalClip");
  }

  const rounds = contract.revision?.maxSemanticRounds;
  if (!contract.revision || typeof contract.revision !== "object") errors.push("revision must be an object");
  else {
    if (!rounds || typeof rounds !== "object") errors.push("revision.maxSemanticRounds must be an object");
    else for (const stage of ["planning", "screenplay", "storyboard"]) integer(errors, rounds[stage], `revision.maxSemanticRounds.${stage}`, 0);
    integer(errors, contract.revision.systemicEpisodeThreshold, "revision.systemicEpisodeThreshold", 1);
    integer(errors, contract.revision.maxContinuityRepairAttempts, "revision.maxContinuityRepairAttempts", 1);
    boolean(errors, contract.revision.requireP2Disposition, "revision.requireP2Disposition");
  }

  if (!contract.delivery || typeof contract.delivery !== "object") errors.push("delivery must be an object");
  else boolean(errors, contract.delivery.autoDeliver, "delivery.autoDeliver");
  return [...new Set(errors)];
}

export function productionContractPath(runDir) {
  return path.join(runDir, PRODUCTION_CONTRACT_FILE);
}

export function loadProductionContract(runDir) {
  const file = productionContractPath(runDir);
  if (!fs.existsSync(file)) return createLegacyProductionContract();
  const contract = JSON.parse(fs.readFileSync(file, "utf8"));
  const errors = validateProductionContract(contract);
  if (errors.length) throw new Error(`invalid production contract at ${file}: ${errors.join("; ")}`);
  return contract;
}

export function writeProductionContract(runDir, contract = createProductionContract()) {
  const errors = validateProductionContract(contract);
  if (errors.length) throw new Error(`invalid production contract: ${errors.join("; ")}`);
  const file = productionContractPath(runDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(contract, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return file;
}

export function productionContractDigest(contract) {
  const errors = validateProductionContract(contract);
  if (errors.length) throw new Error(`cannot digest invalid production contract: ${errors.join("; ")}`);
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(contract))).digest("hex");
}

export function episodeDurationPolicy(contract) {
  const hard = contract.storyboard.episodeDurationSeconds;
  return {
    target: clone(contract.pacing?.targetDurationSeconds ?? hard),
    preferred: contract.pacing?.preferredDurationSeconds ?? null,
    hard: clone(hard),
  };
}

export function productionContractMarkdown(contract) {
  const errors = validateProductionContract(contract);
  if (errors.length) throw new Error(`cannot render invalid production contract: ${errors.join("; ")}`);
  const episodes = contract.promotion.requiredEpisodes.length ? contract.promotion.requiredEpisodes.map((episode) => `EP${episode}`).join("、") : "不强制";
  const rounds = contract.revision.maxSemanticRounds;
  const duration = episodeDurationPolicy(contract);
  const durationLines = contract.pacing === undefined
    ? [`- 每集目标时长：${duration.hard.min}–${duration.hard.max} 秒`]
    : [
      `- 每集目标时长：${duration.target.min}–${duration.target.max} 秒`,
      `- 每集推荐时长：${duration.preferred} 秒`,
      `- 每集硬性时长：${duration.hard.min}–${duration.hard.max} 秒（上限 ${duration.hard.max} 秒）`,
    ];
  return [
    `# Production Contract｜${contract.profile}`,
    "",
    `- 合同版本：${contract.contractVersion}（schema ${contract.schemaVersion}）`,
    `- 模式：${contract.legacy ? "旧项目兼容模式" : contract.format.audience === "female" ? "女频竖屏短剧" : "竖屏短剧（受众未指定）"}`,
    ...durationLines,
    `- 每集镜头：${contract.storyboard.shotCount.min}–${contract.storyboard.shotCount.max} 镜；单镜 ${contract.storyboard.shotDurationSeconds.min}–${contract.storyboard.shotDurationSeconds.max} 秒`,
    `- 剧本限制：最多 ${contract.screenplay.maxScenes} 场；英文对白最多 ${contract.screenplay.englishDialogueWordLimit} 词`,
    `- 宣发要求：${episodes}${contract.promotion.requireSemanticHook ? ` 必须在前 ${contract.promotion.coldOpenWithinSeconds} 秒建立语义冷开和可剪宣发钩子` : " 无强制冷开要求"}`,
    `- 最大语义修订轮次：planning ${rounds.planning}；screenplay ${rounds.screenplay}；storyboard ${rounds.storyboard}`,
    `- 系统性问题阈值：同类问题涉及 ${contract.revision.systemicEpisodeThreshold} 集`,
    `- 单集连续性自动修订上限：${contract.revision.maxContinuityRepairAttempts} 次`,
    `- P2：${contract.revision.requireP2Disposition ? "必须明确处置" : "不强制处置"}`,
    `- 自动交付：${contract.delivery.autoDeliver ? "是" : "否"}`,
  ].join("\n");
}
