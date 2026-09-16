function cleanEpisodeName(value) {
  return value.replace(/^[｜|·:： \t]+/, "")
    .replace(/[｜|· \t]+(?:分镜表|分镜剧本|剧本)$/, "").trim();
}

function draftHeading(markdown) {
  const heading = markdown.match(/^#{1,6}[ \t]+([^\r\n]*)/m);
  if (!heading || /^(?:场景|场\s*\d+|SCENE\b)/i.test(heading[1])) return null;
  const numbered = heading[1].match(/^第\s*(\d+)\s*集/);
  const name = cleanEpisodeName(numbered ? heading[1].slice(numbered[0].length) : heading[1]);
  return { match: heading, episode: numbered ? Number(numbered[1]) : null, name: /^(?:分镜表|分镜剧本|剧本)$/.test(name) ? "" : name };
}

export function normalizeEpisodeHeading(markdown, { stage, episode, screenplay = "" }) {
  const heading = draftHeading(markdown);
  const approved = stage === "screenplay" ? null : draftHeading(screenplay);
  const approvedName = approved?.episode === episode ? approved.name : "";
  const name = stage === "storyboard" ? approvedName || heading?.name || "" : heading?.name || approvedName || "";
  const title = `# 第 ${episode} 集${name ? `｜${name}` : ""}`;
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  return heading
    ? markdown.slice(0, heading.match.index) + title + markdown.slice(heading.match.index + heading.match[0].length)
    : `${title}${newline}${newline}${markdown}`;
}

// Only presentation metadata is supplied by Runtime; all narrative text stays in the draft.
export function normalizeEpisodeDraft(markdown, { stage, episode, screenplay = "" }) {
  const normalized = normalizeEpisodeHeading(markdown, { stage, episode, screenplay });
  if (stage !== "storyboard") return normalized;
  return normalized.replace(/^\|[^\r\n]*\|[ \t]*(?=\r?$)/gm, (line) => {
    if (line.trim().split("|").slice(1, -1).length !== 7) return line;
    const parts = line.replace(/^(\|[ \t]*)ep\d+-s(\d+)([ \t]*\|)/i, `$1ep${String(episode).padStart(2, "0")}-s$2$3`).split("|");
    // Observed EP19 provider output put a literal separator before the asset's 道具 label.
    parts[5] = parts[5].replace(/\\n(?=[ \t]*道具[：:])/g, "<br>");
    return parts.join("|");
  });
}
