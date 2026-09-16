import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEXT_MODEL_PROFILES = Object.freeze({
  kimi: Object.freeze({ family: "kimi", provider: "kimi-coding", id: "k3-256k" }),
  deepseek: Object.freeze({ family: "deepseek", provider: "deepseek", id: "deepseek-flash" }),
  gpt: Object.freeze({ family: "gpt", provider: "openai-codex", id: "gpt-6-astra" }),
});

export function resolveTextModel({ model, agentDir, env = process.env } = {}) {
  let family = model ?? env.TIANSHU_MODEL;
  if (family === "ds") family = "deepseek";
  if (family === undefined || family === "") {
    const provider = env.TIANSHU_MODEL_PROVIDER, id = env.TIANSHU_MODEL_ID;
    if (provider || id) {
      if (!provider || !id) throw new Error("TIANSHU_MODEL_PROVIDER and TIANSHU_MODEL_ID must be supplied together");
      family = Object.values(TEXT_MODEL_PROFILES).find((entry) => entry.provider === provider && entry.id === id)?.family;
      if (!family) throw new Error(`unsupported Tianshu text model pair: ${provider}/${id}; choose kimi, deepseek or gpt`);
    } else family = "kimi";
  }
  const profile = TEXT_MODEL_PROFILES[family];
  if (!profile) throw new Error(`unknown Tianshu model family: ${family}; choose kimi, deepseek (ds) or gpt`);
  const directory = agentDir ?? env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  if (typeof directory !== "string" || !directory.trim()) throw new Error("PI_CODING_AGENT_DIR must be a directory path");
  const expanded = directory === "~" ? os.homedir() : directory.startsWith("~/") ? path.join(os.homedir(), directory.slice(2)) : directory;
  return { ...profile, agentDir: path.resolve(expanded) };
}

function readConfiguration(agentDir, filename) {
  const file = path.join(agentDir, filename);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch {
    const error = new Error(`Cannot read Tianshu model configuration: ${file}`);
    error.code = "TIANSHU_MODEL_CONFIG_INVALID";
    throw error;
  }
}

// Local configuration presence only. This never authenticates or contacts a provider.
export function credentialsForTextModel({ agentDir, provider }) {
  const credential = readConfiguration(agentDir, "auth.json")[provider];
  const stored = credential?.type === "api_key" ? typeof credential.key === "string" && !!credential.key.trim()
    : credential?.type === "oauth" && [credential.access, credential.accessToken, credential.refresh, credential.refreshToken].some((value) => typeof value === "string" && !!value.trim());
  const configured = readConfiguration(agentDir, "models.json").providers?.[provider]?.apiKey;
  return { configured: !!(stored || configured), source: stored ? "auth.json" : configured ? "models.json" : null, agentDir, provider };
}

export function modelRedactionKeys(agentDir, env = process.env) {
  const keys = [env.KIMI_API_KEY, env.DEEPSEEK_API_KEY, env.OPENAI_API_KEY, env.OPENAI_CODEX_API_KEY].filter((value) => typeof value === "string" && value);
  for (const credential of Object.values(readConfiguration(agentDir, "auth.json"))) {
    for (const field of ["key", "access", "refresh", "accessToken", "refreshToken", "idToken"]) {
      if (typeof credential?.[field] === "string" && credential[field]) keys.push(credential[field]);
    }
  }
  for (const configured of Object.values(readConfiguration(agentDir, "models.json").providers ?? {})) {
    if (typeof configured?.apiKey === "string" && configured.apiKey) {
      keys.push(configured.apiKey);
      if (typeof env[configured.apiKey] === "string" && env[configured.apiKey]) keys.push(env[configured.apiKey]);
    }
  }
  return [...new Set(keys)].sort((a, b) => b.length - a.length);
}

export function isNonRetryableModelError(detail = "") {
  return /(?:^|\b(?:HTTP|status|statusCode)[\s:=]*)\s*(?:400|401|402|403)\b/i.test(detail)
    || /unauthori[sz]ed|invalid[_ -]?(?:api[_ -]?)?key|authentication[_ -]?(?:failed|error|required)|insufficient[_ -](?:quota|balance|credits)|quota[_ -]?(?:exceeded|exhausted)|(?:monthly|5-hour|weekly(?: \(7-day\))?) usage limit|billing[_ -](?:hard[_ -]limit|limit|error)|credit balance|余额不足|额度(?:不足|用尽)/i.test(detail);
}
