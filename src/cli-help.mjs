const commands = [
  "extract-source <source.md|txt|docx> --episodes N [--output inputs/materials.json | --preview]",
  "extract-video <episodes.json> [--output inputs/materials.json [--resume [--repair-episode N]] | --preview]",
  "extract-outline <source.md|txt|docx> --episodes N [--output inputs/outline.md | --preview]",
  "init <input> [--model kimi|deepseek|ds|gpt] [--agent-dir directory] [--title T] [--episodes N] [--source-materials materials.json | --source-outline outline.md] [--sample] [--source-episodes N] [--contract production-contract.json]",
  "bind-model <run> --model kimi|deepseek|gpt [--agent-dir directory]",
  "plan <run> [--note repair-note.txt]",
  "set-delivery-title <run> <title>",
  "status <run>",
  "metrics <run>",
  "approve <run>",
  "run <run>",
  "resume <run>",
  "produce <run>",
  "review <run> [--note review-note.txt]",
  "repair <run>",
  "storyboard <run>",
  "storyboard-review <run> [--note review-note.txt]",
  "approve-delivery <run>",
  "return <run> <note>",
  "accept-corrections <run> <reviewed-record.json>",
  "deliver <run>",
  "lock-status <run>",
  "unlock-stale <run>",
];

const usageNotes = [
  "Text models are frozen at init: kimi=kimi-coding/k3-256k, deepseek(ds)=deepseek/deepseek-flash, gpt=openai-codex/gpt-6-astra. Source extraction is independent; GPT text runs never invoke Gemini. Legacy runs require explicit bind-model for subsequent execution; historical identity stays unknown.",
  "Data directory: --root (before or after the command) > TIANSHU_ROOT > this repository. Input/output file paths remain relative to the current working directory.",
  "init episode counts: original 30|60 (default 30); full-series replication separates sourceEpisodes from output episodes; --source-episodes checks complete source coverage, --episodes is an optional planning reference, and the approved outline/map determines the output count; --sample exactly 3 (default 3).",
  "New full-series replication timing: target 60–90 seconds, usually 75 (pacing.targetDurationSeconds / pacing.preferredDurationSeconds); planned targetSeconds must be <=90, with a hard episode limit of 100 seconds. Natural endings over 90 and up to 100 seconds may be kept with a Reviewer pacing note; above 100, prefer more episodes. Frozen runs keep their existing contracts, including old 120-second limits. Sample and original scopes are unchanged.",
];

export const CLI_HELP = [
  `tianshu [--root data-directory] ${commands.join(" | ")}`,
  ...usageNotes,
].join("\n");
