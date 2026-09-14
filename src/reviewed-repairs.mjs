import fs from "node:fs";
import path from "node:path";

const RECORD_NAME = "reviewed-repairs.json";
const SHOT = /^ep(\d+)-s(\d+)$/;

function conflict(message) {
  throw new Error(`reviewed repair export conflict: ${message}`);
}

function checkedChanges(record) {
  if (!record || !Array.isArray(record.changes)) conflict("missing changes array");
  const pending = record.pendingSourceFindingIds ?? [];
  if (!Array.isArray(pending) || pending.some((id) => typeof id !== "string")) {
    conflict("pendingSourceFindingIds must be an array of finding IDs");
  }
  const seen = new Set();
  for (const change of record.changes) {
    const match = typeof change?.shot === "string" && change.shot.match(SHOT);
    if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) conflict("invalid target shot ID");
    const target = `${change.shot} column ${change.column}`;
    if (!Number.isInteger(change.column) || change.column < 2 || change.column > 7) {
      conflict(`${target}: editable columns are 2–7`);
    }
    if (typeof change.old !== "string" || typeof change.new !== "string" || change.old === change.new) {
      conflict(`${target}: distinct old and new cell text required`);
    }
    if (/[|\r]/.test(change.new)) conflict(`${target}: new text contains a table separator or carriage return`);
    if (seen.has(target)) conflict(`${target}: duplicate target`);
    seen.add(target);
    const findings = change.findings ?? [];
    if (!Array.isArray(findings) || findings.some((id) => typeof id !== "string")) {
      conflict(`${target}: findings must be an array of finding IDs`);
    }
    for (const id of findings) {
      if (pending.includes(id) || record.decisions?.[id]?.decision === "needs_source") {
        conflict(`${target}: finding ${id} still needs source confirmation`);
      }
      if (record.decisions?.[id]?.decision === "reject") conflict(`${target}: finding ${id} was rejected`);
    }
  }
  return record.changes;
}

function affectedEpisodes(changes) {
  return [...new Set(changes.map(({ shot }) => Number(shot.match(SHOT)[1])))].sort((a, b) => a - b);
}

// These are final-position cell diffs. Structural revisions and original IDs are
// provenance only: applying a separate row reorder would repeat the correction.
export function applyReviewedRepairs(markdown, record) {
  if (record == null) return { markdown, appliedCells: 0, affectedEpisodes: [], pendingSourceFindingIds: [] };
  const changes = checkedChanges(record);
  const lines = markdown.split("\n");
  const rows = new Map();
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^[ \t]*\|[ \t]*(ep\d+-s\d+)(?=[ \t|\r]|$)/);
    if (!match) continue;
    if (rows.has(match[1])) conflict(`${match[1]}: duplicate row`);
    const parts = lines[index].split("|");
    if (parts.length !== 9 || parts[0].trim() || parts.at(-1).trim()) {
      conflict(`${match[1]}: malformed seven-column row`);
    }
    rows.set(match[1], { index, parts });
  }
  for (const change of changes) {
    const row = rows.get(change.shot);
    const target = `${change.shot} column ${change.column}`;
    if (!row) conflict(`${target}: missing target row`);
    const original = row.parts[change.column];
    if (original.trim().replaceAll("<br>", "\n") !== change.old) conflict(`${target}: old text no longer matches`);
    const leading = original.match(/^\s*/)[0];
    const trailing = original.slice(leading.length).match(/\s*$/)[0];
    row.parts[change.column] = leading + change.new.replaceAll("\n", "<br>") + trailing;
    lines[row.index] = row.parts.join("|");
  }
  return {
    markdown: lines.join("\n"),
    appliedCells: changes.length,
    affectedEpisodes: affectedEpisodes(changes),
    pendingSourceFindingIds: [...(record.pendingSourceFindingIds ?? [])],
  };
}

export function loadReviewedRepairs(runDir) {
  const file = path.join(runDir, RECORD_NAME);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function sourceFile(runDir, kind, episode) {
  return path.join(runDir, kind, `ep-${String(episode).padStart(2, "0")}.md`);
}

function sourceText(runDir, kind, episode) {
  const file = sourceFile(runDir, kind, episode);
  if (!fs.existsSync(file)) conflict(`episode ${episode}: missing ${kind} source`);
  return fs.readFileSync(file, "utf8");
}

export function assertReviewedRepairSources(runDir, record) {
  if (record == null) return;
  const episodes = affectedEpisodes(checkedChanges(record));
  if (!Array.isArray(record.sourceSnapshots) || record.sourceSnapshots.length !== episodes.length) {
    conflict("registered source snapshots are missing or incomplete");
  }
  for (const episode of episodes) {
    const snapshots = record.sourceSnapshots.filter((item) => item.episode === episode);
    if (snapshots.length !== 1) conflict(`episode ${episode}: source snapshot is missing or duplicated`);
    for (const kind of ["storyboard", "screenplay"]) {
      if (sourceText(runDir, kind, episode) !== snapshots[0][kind]) {
        conflict(`episode ${episode}: ${kind} source changed since editorial repairs were registered`);
      }
    }
  }
}

// The CLI owns the run lock. Registration preserves editorial review separately
// from the unchanged generation tasks and stage approvals.
export function registerReviewedRepairs(runDir, recordPath, { baseMarkdown, sourceRunId }) {
  const inputPath = path.resolve(recordPath);
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (input.sourceRunId && input.sourceRunId !== sourceRunId) conflict("repair record belongs to a different run");
  const applied = applyReviewedRepairs(baseMarkdown, input);
  const record = {
    ...input,
    sourceRunId,
    registeredAt: new Date().toISOString(),
    provenance: { ...input.provenance, correctionRecord: inputPath },
    sourceSnapshots: applied.affectedEpisodes.map((episode) => ({
      episode,
      storyboard: sourceText(runDir, "storyboard", episode),
      screenplay: sourceText(runDir, "screenplay", episode),
    })),
  };
  const file = path.join(runDir, RECORD_NAME);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return { ...applied, record };
}
