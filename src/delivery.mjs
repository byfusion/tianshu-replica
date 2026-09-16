import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadManifest, markdownDelivery, sha, transition, writeJson, writeText } from "./core.mjs";
import { deliveryGate } from "./runtime.mjs";
import { loadReviewedRepairs } from "./reviewed-repairs.mjs";
import { deliveryScope, sampleLabel } from "./sample.mjs";

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOperations = {
  loadManifest,
  deliveryGate,
  markdownDelivery,
  writeText,
  execFileSync,
  loadReviewedRepairs,
  writeJson,
  transition,
};

// The CLI holds the run lock across both production and this final export.
export async function deliverUnlocked(runDir, operations = defaultOperations) {
  const manifest = operations.loadManifest(runDir);
  if (!["ready_to_deliver", "delivered"].includes(manifest.state)) {
    throw new Error(`cannot deliver from ${manifest.state}`);
  }

  // Explicit redelivery checks current artifacts before replacing either output.
  const readiness = operations.deliveryGate(runDir);
  const markdown = operations.markdownDelivery(runDir);
  const deliveryTitle = manifest.deliveryTitle
    ? `${sampleLabel(manifest)}${manifest.deliveryTitle}`
    : `${sampleLabel(manifest)}${manifest.title}｜分镜剧本`;
  const markdownFile = path.join(runDir, "deliverables", `${deliveryTitle}.md`);
  const docxFile = path.join(runDir, "deliverables", `${deliveryTitle}.docx`);

  operations.writeText(markdownFile, markdown);
  operations.execFileSync(process.env.TIANSHU_PYTHON || "python3", [
    path.join(CODE_ROOT, "src", "experiments", "render_storyboard_docx.py"),
    markdownFile,
    docxFile,
    manifest.deliveryTitle ? deliveryTitle : "",
    path.join(runDir, "screenplay"),
  ]);
  if (!fs.existsSync(docxFile) || fs.statSync(docxFile).size < 1000) {
    throw new Error("DOCX render failed");
  }

  const corrections = operations.loadReviewedRepairs(runDir);
  operations.writeJson(path.join(runDir, "delivery.json"), {
    ...deliveryScope(manifest),
    title: deliveryTitle,
    markdown: markdownFile,
    docx: docxFile,
    ...(corrections
      ? {
          reviewedCorrections: {
            file: path.join(runDir, "reviewed-repairs.json"),
            registeredAt: corrections.registeredAt,
            provenance: corrections.provenance,
            appliedCells: corrections.changes.length,
            pendingSourceFindingIds: corrections.pendingSourceFindingIds || [],
            reviewBasis:
              "independent editorial corrections; generation stage reviews remain separate",
          },
        }
      : {}),
    digest: sha(markdown),
    readiness,
  });
  return operations.transition(
    runDir,
    "delivered",
    "Markdown and DOCX delivery generated after fresh delivery gate",
  );
}
