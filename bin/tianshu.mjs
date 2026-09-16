#!/usr/bin/env node
import { bindRunModel, executionContractStatus } from "../src/execution-contract.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRun,
  loadManifest,
  markdownDelivery,
  readText,
  runRoot,
  saveManifest,
  transition,
} from "../src/core.mjs";
import {
  applyRepair,
  plan,
  produceScripts,
  produceStoryboards,
  reviewScripts,
  reviewStoryboards,
} from "../src/agents.mjs";
import { clearStaleRunLock, readRunLock, runProduction, withRunLock } from "../src/runtime.mjs";
import { readRunMetrics } from "../src/metrics.mjs";
import { extractSourceOutline } from "../src/extract-outline.mjs";
import { loadSourceEpisodes } from "../src/source-input.mjs";
import { loadSourceMaterials } from "../src/source-materials.mjs";
import { deliveryScope } from "../src/sample.mjs";
import { registerReviewedRepairs } from "../src/reviewed-repairs.mjs";
import { CLI_HELP } from "../src/cli-help.mjs";
import { deliverUnlocked } from "../src/delivery.mjs";

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawArgs = process.argv.slice(2);
let DATA_ROOT = path.resolve(process.env.TIANSHU_ROOT || CODE_ROOT);
let cmd, args;
const findRun = (id) => path.join(runRoot(DATA_ROOT), id);
const help = () => console.log(CLI_HELP);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const mutateRun = (id, operation) => {
  const runDir = findRun(id);
  return withRunLock(runDir, () => operation(runDir));
};
try {
  const rootIndex = rawArgs.indexOf("--root");
  if (rootIndex >= 0) {
    const value = rawArgs[rootIndex + 1];
    if (!value?.trim() || value.startsWith("--"))
      throw new Error("--root requires a run data directory");
    DATA_ROOT = path.resolve(value);
    rawArgs.splice(rootIndex, 2);
  }
  // Share the resolved CLI data root with every GPT session and source stage.
  process.env.TIANSHU_ROOT = DATA_ROOT;
  [cmd, ...args] = rawArgs;
  if (cmd === "extract-outline" || cmd === "extract-source") {
    const count = Number(flag("--episodes") || 3);
    if (args.includes("--preview")) {
      const source = await loadSourceEpisodes(args[0], count);
      console.log(
        JSON.stringify(
          {
            sourcePath: source.sourcePath,
            sourceKind: source.sourceKind,
            totalEpisodes: source.totalEpisodes,
            selectedEpisodes: source.episodes.map(({ episode, text, reference }) => ({
              episode,
              characters: text.length,
              reference,
            })),
            plannedMaterials:
              cmd === "extract-source" ? ["creative", "characters", "outline"] : ["outline"],
            directVideoUnderstanding: false,
            modelRequestSent: false,
          },
          null,
          2,
        ),
      );
    } else {
      const output = flag("--output");
      if (!output || output.startsWith("--"))
        throw new Error(
          "--output requires a local output path; use --preview to inspect without a model call",
        );
      const extract =
        cmd === "extract-source"
          ? (await import("../src/extract-source.mjs")).extractSourceMaterials
          : extractSourceOutline;
      console.log(
        JSON.stringify(
          await extract({ sourcePath: args[0], episodes: count, outputPath: output }),
          null,
          2,
        ),
      );
    }
  } else if (cmd === "extract-video") {
    const { extractVideoMaterials, previewVideoMaterials } = await import(
      "../src/extract-video.mjs"
    );
    if (args.includes("--preview"))
      console.log(JSON.stringify(await previewVideoMaterials(args[0]), null, 2));
    else {
      const output = flag("--output");
      if (!output || output.startsWith("--"))
        throw new Error("--output requires a local JSON path; use --preview before a model call");
      console.log(
        JSON.stringify(
          await extractVideoMaterials({
            manifestPath: args[0],
            outputPath: output,
            resume: args.includes("--resume"),
            ...(args.includes("--repair-episode")
              ? { repairEpisode: Number(flag("--repair-episode")) }
              : {}),
          }),
          null,
          2,
        ),
      );
    }
  } else if (cmd === "init") {
    const input = readText(args[0]);
    const title = flag("--title") || input.split("\n")[0].slice(0, 50);
    const contractFile = flag("--contract");
    const productionContract = contractFile ? JSON.parse(readText(contractFile)) : undefined;
    const sourceFile = flag("--source-outline");
    const materialsFile = flag("--source-materials");
    if (args.includes("--source-outline") && (!sourceFile || sourceFile.startsWith("--")))
      throw new Error("--source-outline requires a Markdown file");
    if (args.includes("--source-materials") && (!materialsFile || materialsFile.startsWith("--")))
      throw new Error("--source-materials requires a JSON file");
    if (sourceFile && materialsFile)
      throw new Error("use --source-materials or --source-outline, not both");
    const sample = args.includes("--sample");
    const count = flag("--episodes") === null ? undefined : Number(flag("--episodes"));
    const sourceCount = flag("--source-episodes");
    for (const name of ["--model", "--agent-dir"])
      if (args.includes(name) && (!flag(name) || flag(name).startsWith("--")))
        throw new Error(`${name} requires a value`);
    const { id, manifest } = createRun(DATA_ROOT, {
      title,
      model: flag("--model") ?? undefined,
      agentDir: flag("--agent-dir") ?? undefined,
      episodes: count,
      sample,
      sourceTotalEpisodes: sourceCount === null ? null : Number(sourceCount),
      input,
      ...(sourceFile ? { sourceOutline: readText(sourceFile) } : {}),
      ...(materialsFile
        ? { sourceMaterials: loadSourceMaterials(materialsFile, sample ? 3 : undefined) }
        : {}),
      ...(productionContract ? { productionContract } : {}),
    });
    console.log(
      JSON.stringify({
        id,
        state: "draft",
        executionModel: executionContractStatus(findRun(id)),
        productionRoute: manifest.productionRoute,
        ...(manifest.sourceEpisodes ? { sourceEpisodes: manifest.sourceEpisodes } : {}),
        ...deliveryScope(manifest),
      }),
    );
  } else if (cmd === "set-delivery-title") {
    const title = args.slice(1).join(" ").trim();
    if (!title || /[\\/\0\r\n]/.test(title)) {
      throw new Error("delivery title must be a filename-safe single line");
    }
    const result = await mutateRun(args[0], async (runDir) => {
      const manifest = loadManifest(runDir);
      if (manifest.state === "delivered") throw new Error("set the delivery title before export");
      manifest.deliveryTitle = title;
      saveManifest(runDir, manifest);
      return { id: manifest.id, state: manifest.state, deliveryTitle: manifest.deliveryTitle };
    });
    console.log(JSON.stringify(result));
  } else if (cmd === "bind-model") {
    for (const name of ["--model", "--agent-dir"]) {
      if (args.includes(name) && (!flag(name) || flag(name).startsWith("--"))) {
        throw new Error(`${name} requires a value`);
      }
    }
    const result = await mutateRun(args[0], (runDir) =>
      bindRunModel(runDir, { model: flag("--model"), agentDir: flag("--agent-dir") ?? undefined }),
    );
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "status") {
    const runDir = findRun(args[0]);
    console.log(
      JSON.stringify(
        { ...loadManifest(runDir), executionModel: executionContractStatus(runDir) },
        null,
        2,
      ),
    );
  } else if (cmd === "metrics") {
    const runDir = findRun(args[0]);
    loadManifest(runDir);
    console.log(JSON.stringify(readRunMetrics(runDir), null, 2));
  } else if (cmd === "lock-status") {
    console.log(JSON.stringify(readRunLock(findRun(args[0])), null, 2));
  } else if (cmd === "unlock-stale") {
    console.log(JSON.stringify(clearStaleRunLock(findRun(args[0])), null, 2));
  } else if (cmd === "approve") {
    const result = await mutateRun(args[0], async (runDir) => {
      const manifest = loadManifest(runDir);
      if (manifest.state !== "awaiting_approval")
        throw new Error(`cannot approve from ${manifest.state}`);
      return transition(runDir, "approved", "human phase-A approval");
    });
    console.log(JSON.stringify(result));
  } else if (cmd === "plan") {
    const note = flag("--note");
    if (args.includes("--note") && (!note || note.startsWith("--"))) {
      throw new Error("--note requires a local repair-note file");
    }
    const result = await mutateRun(args[0], async (runDir) => {
      await plan(runDir, { operatorNote: note ? readText(note) : "" });
      return loadManifest(runDir);
    });
    console.log(JSON.stringify(result));
  } else if (cmd === "produce") {
    const result = await mutateRun(args[0], async (runDir) => {
      await produceScripts(runDir);
      return loadManifest(runDir);
    });
    console.log(JSON.stringify(result));
  } else if (cmd === "review") {
    const note = flag("--note");
    const result = await mutateRun(args[0], (runDir) =>
      reviewScripts(runDir, { operatorNote: note ? readText(note) : "" }),
    );
    console.log(JSON.stringify(result));
  } else if (cmd === "repair") {
    const result = await mutateRun(args[0], async (runDir) => applyRepair(runDir));
    console.log(JSON.stringify(result));
  } else if (cmd === "run" || cmd === "resume") {
    const runDir = findRun(args[0]);
    await withRunLock(runDir, async () => {
      await runProduction(runDir, undefined, { lock: false });
      if (loadManifest(runDir).state === "ready_to_deliver") await deliverUnlocked(runDir);
    });
    console.log(JSON.stringify(loadManifest(runDir)));
  } else if (cmd === "storyboard") {
    const result = await mutateRun(args[0], async (runDir) => {
      await produceStoryboards(runDir);
      return loadManifest(runDir);
    });
    console.log(JSON.stringify(result));
  } else if (cmd === "storyboard-review") {
    const note = flag("--note");
    const result = await mutateRun(args[0], (runDir) =>
      reviewStoryboards(runDir, { operatorNote: note ? readText(note) : "" }),
    );
    console.log(JSON.stringify(result));
  } else if (cmd === "approve-delivery") {
    const result = await mutateRun(args[0], async (runDir) => {
      const manifest = loadManifest(runDir);
      if (manifest.state !== "awaiting_delivery_approval") {
        throw new Error(`cannot approve delivery from ${manifest.state}`);
      }
      return transition(runDir, "ready_to_deliver", "human final delivery approval");
    });
    console.log(JSON.stringify(result));
  } else if (cmd === "return") {
    const result = await mutateRun(args[0], async (runDir) =>
      transition(runDir, "returned", args.slice(1).join(" ")),
    );
    console.log(JSON.stringify(result));
  } else if (cmd === "accept-corrections") {
    if (!args[1]) {
      throw new Error(
        "accept-corrections requires an independently reviewed corrections JSON file",
      );
    }
    const result = await mutateRun(args[0], async (runDir) => {
      const manifest = loadManifest(runDir);
      if (!["ready_to_deliver", "delivered"].includes(manifest.state)) {
        throw new Error(`cannot register delivery corrections from ${manifest.state}`);
      }
      const baseMarkdown = markdownDelivery(runDir, { includeReviewedRepairs: false });
      const corrections = registerReviewedRepairs(runDir, args[1], {
        baseMarkdown,
        sourceRunId: manifest.id,
      });
      return {
        id: manifest.id,
        state: manifest.state,
        registeredCorrections: path.join(runDir, "reviewed-repairs.json"),
        appliedCells: corrections.appliedCells,
        affectedEpisodes: corrections.affectedEpisodes,
        pendingSourceFindingIds: corrections.pendingSourceFindingIds,
      };
    });
    console.log(JSON.stringify(result));
  } else if (cmd === "deliver") {
    const runDir = findRun(args[0]);
    const result = await withRunLock(runDir, () => deliverUnlocked(runDir));
    console.log(JSON.stringify(result));
  } else {
    help();
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
