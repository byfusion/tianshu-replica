// Project known workflow notes at the delivery boundary; story cells are untouched.
const METADATA_LABEL = /^(?:阅读说明|复核说明|排版说明|字符校订|保留制作待核|审稿说明|审稿记录|审稿结果|任务修复说明|任务修复记录|修复记录)(?=\s*(?:[：:（(]|$))/;

function plainLabel(value) {
  return value.trim().replace(/^>\s*/, "").replace(/^#{1,6}\s*/, "")
    .replace(/^[-*+]\s+/, "").replaceAll("**", "").replaceAll("__", "");
}

function internalNote(value) {
  const text = plainLabel(value).replace(/^(?:制作|备注|制作说明)[：:]\s*/, "").trim();
  return METADATA_LABEL.test(text)
    || /^(?:GPT(?:[- ]?\d[\w.-]*)?|Codex|Gemini|Kimi|DeepSeek).{0,40}(?:复核|审稿|修复记录)/i.test(text)
    || /^(?:PASS|REVISE)\s*[。；;!?！？]?$/i.test(text);
}

function projectNoteCell(value) {
  const projected = value.split(/<br\s*\/?>/i).map((line) => line
    .split(/(?<=[，,。！？!?；;])/u).filter((clause) => !internalNote(clause))
    .join("").trim()).filter(Boolean).join("<br>");
  if (projected === value.trim()) return value;
  return value.match(/^\s*/)[0] + projected + value.match(/\s*$/)[0];
}

export function projectDeliveryMarkdown(markdown) {
  const output = [];
  let internalSectionDepth = null, internalParagraph = false, storyboardTable = false;
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^\s*#{1,6}\s+/);
    const depth = heading?.[0].trim().length;
    const parts = line.trimStart().startsWith("|") ? line.split("|") : null;
    if (parts?.length === 9 && parts[1].trim() === "镜头号" && /备注/.test(parts[6])) {
      storyboardTable = true;
      internalSectionDepth = null;
      internalParagraph = false;
      output.push(line);
      continue;
    }
    if (storyboardTable && parts?.length === 9) {
      if (/^(?:ep\d+-s\d+|\d+)$/i.test(parts[1].trim())) parts[6] = projectNoteCell(parts[6]);
      output.push(parts.join("|"));
      continue;
    }
    if (line.trim()) storyboardTable = false;
    if (internalSectionDepth !== null) {
      if (!heading || depth > internalSectionDepth) continue;
      internalSectionDepth = null;
    }
    if (heading) internalParagraph = false;
    if (!line.trim()) internalParagraph = false;
    if (METADATA_LABEL.test(plainLabel(line))) {
      if (heading) internalSectionDepth = depth;
      else internalParagraph = true;
      continue;
    }
    if (!internalParagraph) output.push(line);
  }
  return output.join("\n");
}
