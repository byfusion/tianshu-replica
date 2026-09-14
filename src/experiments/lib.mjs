import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { collectUsage } from "../metrics.mjs";
import { resolveTextModel, credentialsForTextModel, modelRedactionKeys, isNonRetryableModelError } from "../model-profiles.mjs";
import { textModelForSession, writeExecutionContract } from "../execution-contract.mjs";
import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
export const { Type } = require("typebox");
export const { Compile } = require("typebox/compile");

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const EXPERIMENT_ROOT = path.join(ROOT, "experiments", "core");

export function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${String(value).trimEnd()}\n`, "utf8");
  fs.renameSync(temporary, file);
}

export function writeJson(file, value) {
  writeText(file, JSON.stringify(value, null, 2));
}

export function readText(file) {
  return fs.readFileSync(file, "utf8");
}

export function readJson(file) {
  return JSON.parse(readText(file));
}

export function piModelSelection(env = process.env) {
  const { provider, id } = resolveTextModel({ env });
  return { provider, id };
}

export function createExperimentRun(experiment, fixture) {
  const id = `${experiment}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = path.join(EXPERIMENT_ROOT, id);
  fs.mkdirSync(runDir, { recursive: true });
  writeExecutionContract(runDir);
  writeJson(path.join(runDir, "manifest.json"), {
    id,
    experiment,
    startedAt: new Date().toISOString(),
    fixtureDigest: sha(stable(fixture)),
    model: Object.values(piModelSelection()).join("/"),
    state: "running",
  });
  return { id, runDir };
}

export function finishRun(runDir, result) {
  const manifest = readJson(path.join(runDir, "manifest.json"));
  manifest.finishedAt = new Date().toISOString();
  manifest.state = result.outcome;
  manifest.result = result;
  writeJson(path.join(runDir, "manifest.json"), manifest);
  writeJson(path.join(runDir, "metrics.json"), result.metrics || {});
}

export function safeRef(runDir, ref, allowedRoots) {
  if (typeof ref !== "string" || !ref.trim()) throw new Error("artifact ref is required");
  const resolved = path.resolve(runDir, ref);
  const allowed = allowedRoots.some((root) => {
    const base = path.resolve(runDir, root);
    return resolved === base || resolved.startsWith(`${base}${path.sep}`);
  });
  if (!allowed) throw new Error(`artifact ref outside authorized roots: ${ref}`);
  return resolved;
}

const sessionPrefixes = new WeakMap();

export function collectModelError(metrics, event) {
  if (event.type !== "message_end" || event.message?.role !== "assistant" || event.message.stopReason !== "error") return;
  let errorMessage = event.message.errorMessage;
  if (typeof errorMessage === "string") {
    try {
      const agentDir = metrics.executionModel?.agentDir ?? resolveTextModel().agentDir;
      for (const key of modelRedactionKeys(agentDir)) errorMessage = errorMessage.replaceAll(key, "[REDACTED]");
    } catch {
      errorMessage = "Error detail withheld: configured credentials could not be read for redaction";
    }
    errorMessage = errorMessage.slice(0, 2000);
  }
  metrics.modelErrors ??= [];
  metrics.modelErrors.push({ at: Date.now(), stopReason: "error", ...(typeof errorMessage === "string" ? { errorMessage } : {}) });
}

export function createSubmissionTrace(runDir, role, toolName, selected = textModelForSession(runDir)) {
  if (!["submit_planning_bundle", "submit_series_review"].includes(toolName)) throw new Error("Submission trace is limited to Planner and series Reviewer");
  const seriesReview = toolName === "submit_series_review";
  const keys = modelRedactionKeys(selected.agentDir);
  const workDir = path.join(runDir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const sessionDir = fs.mkdtempSync(path.join(workDir, seriesReview ? "series-review-session-" : "planner-session-"));
  const file = path.join(sessionDir, "submission-trace.jsonl");
  fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  return { file, record(event) {
    const assistantMessage = seriesReview && event.type === "message_end" && event.message?.role === "assistant";
    const submissionName = event.toolName === toolName || (toolName === "submit_planning_bundle" && event.toolName === "submit_planning_patch");
    const submission = submissionName && ["tool_execution_start", "tool_execution_end"].includes(event.type);
    if (!assistantMessage && !submission) return;
    const record = {
      at: new Date().toISOString(), role, type: event.type,
      ...(assistantMessage ? { message: event.message } : {
        toolCallId: event.toolCallId, toolName: event.toolName,
        ...(event.type === "tool_execution_start" ? { args: event.args } : { result: event.result, isError: event.isError }),
      }),
    };
    let line = JSON.stringify(record);
    for (const key of keys) line = line.replaceAll(key, "[REDACTED]");
    fs.appendFileSync(file, `${line}\n`);
  } };
}

export async function createPiExperimentSession({ runDir, role, systemPrompt, customTools, toolNames, thinkingLevel, maxOutputTokens }, sdk = { ModelRuntime, createAgentSession, SessionManager }) {
  const selected = textModelForSession(runDir);
  if (["created", "legacy-bound"].includes(selected.binding) && !credentialsForTextModel(selected).configured) {
    const error = new Error(`Missing configured credentials for ${selected.provider} in frozen directory ${selected.agentDir}`);
    error.code = "TIANSHU_MODEL_CREDENTIALS_MISSING";
    throw error;
  }
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(selected.agentDir, "auth.json"), modelsPath: path.join(selected.agentDir, "models.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const registeredModel = modelRuntime.getModel(selected.provider, selected.id);
  if (!registeredModel) throw new Error(`Pi cannot resolve ${selected.provider}/${selected.id}`);
  const model = maxOutputTokens === undefined ? registeredModel : { ...registeredModel, maxTokens: maxOutputTokens };
  const submissionTool = toolNames.find((name) => ["submit_planning_bundle", "submit_series_review"].includes(name));
  const submissionTrace = submissionTool ? createSubmissionTrace(runDir, role, submissionTool, selected) : null;
  const metrics = { role, executionModel: selected, model: { provider: model.provider, id: model.id }, startedAt: new Date().toISOString(), endedAt: null, prompts: 0, promptAttempts: [], turns: 0, toolCalls: 0, compactions: 0, assistantMessages: 0, usage: [], events: [], modelErrors: [] };
  metrics.maxOutputTokens = model.maxTokens;
  if (submissionTrace) metrics[submissionTool === "submit_planning_bundle" ? "plannerSubmissionTrace" : "seriesReviewTrace"] = path.relative(runDir, submissionTrace.file);
  const { session } = await sdk.createAgentSession({
    cwd: ROOT,
    agentDir: selected.agentDir,
    modelRuntime,
    model,
    thinkingLevel: thinkingLevel ?? (selected.family === "gpt" ? "high" : "off"),
    tools: toolNames,
    customTools,
    sessionManager: sdk.SessionManager.inMemory(ROOT),
  });
  sessionPrefixes.set(session, systemPrompt);
  session.subscribe((event) => {
    submissionTrace?.record(event);
    collectUsage(metrics, event);
    if (event.type === "turn_end") metrics.turns += 1;
    if (event.type === "tool_execution_start") {
      metrics.toolCalls += 1;
      metrics.events.push({ type: "tool_start", tool: event.toolName, at: Date.now() });
    }
    if (event.type === "compaction_end") metrics.compactions += 1;
    collectModelError(metrics, event);
  });
  return { session, metrics };
}

export async function promptWithWatchdog(session, metrics, prompt, timeoutMs = 180_000) {
  const prefix = metrics.prompts === 0 ? sessionPrefixes.get(session) : "";
  metrics.prompts = (metrics.prompts ?? 0) + 1;
  metrics.promptAttempts ??= [];
  const promptIndex = metrics.prompts;
  const request = prefix ? `Role instructions for this session:\n${prefix}\n\nTask:\n${prompt}` : prompt;
  for (let attempt = 0; attempt < 3; attempt++) {
    const errorsBefore = metrics.modelErrors?.length || 0;
    let timeout = false;
    const record = {
      promptIndex,
      retryIndex: attempt,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "running",
      assistantMessagesBefore: metrics.assistantMessages ?? null,
      assistantMessagesAfter: null,
    };
    metrics.promptAttempts.push(record);
    const timer = setTimeout(() => { timeout = true; void session.abort(); }, timeoutMs);
    try {
      await session.prompt(request);
      record.status = timeout ? "timeout" : (metrics.modelErrors?.length || 0) > errorsBefore ? "error" : "succeeded";
      if (record.status === "error") record.reason = "model_error";
    } catch (error) {
      record.status = timeout ? "timeout" : "error";
      record.reason = timeout ? "watchdog_timeout" : "prompt_rejected";
      throw error;
    } finally {
      clearTimeout(timer);
      record.endedAt = new Date().toISOString();
      record.assistantMessagesAfter = metrics.assistantMessages ?? null;
    }
    if (timeout) throw new Error(`Pi task exceeded ${timeoutMs}ms watchdog`);
    if ((metrics.modelErrors?.length || 0) === errorsBefore) return;
    const detail = metrics.modelErrors.at(-1)?.errorMessage || "";
    if (isNonRetryableModelError(detail)) {
      throw new Error(`Pi request rejected: ${detail}`);
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
  }
  throw new Error("Pi model returned an error without a usable response after 3 attempts");
}

export { defineTool };
