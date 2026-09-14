const HAN = /\p{Script=Han}/u;
const LATIN = /[A-Za-z]/;
const PLACEHOLDER = /^(?:同上|如上|见上|same(?:\s+as\s+above)?|as\s+above|ibid\.?)$/i;

const clean = (value) => String(value || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/^[\s"“”'‘’]+|[\s"“”'‘’]+$/g, "")
  .trim();

const stripSpeaker = (value) => clean(value)
  .replace(/^\*{0,2}[^:：]{1,60}\*{0,2}\s*[:：]\s*/, "")
  .trim();

function isLanguageNeutral(value) {
  const text = stripSpeaker(value);
  const words = text.match(/[A-Za-z]+/g) || [];
  return words.length > 1 && words.every((word) => word.length === 1 || /^[A-Z][a-z]*$/.test(word));
}

function isCanonicalNameCall(value, canonicalNames) {
  const words = value.match(/[A-Za-z]+/g) || [];
  const remainder = value.replace(/[A-Za-z]+/g, "");
  if (!words.length || !/^[\s\p{P}]*$/u.test(remainder)) return false;
  const nameWords = new Set(canonicalNames.flatMap((name) => String(name).match(/[A-Za-z]+/g) || []).map((word) => word.toLowerCase()));
  return words.every((word) => nameWords.has(word.toLowerCase()));
}

function unique(items) { return [...new Set(items)]; }

export function dialogueCellErrors(cell, context = "台词格") {
  const value = clean(cell);
  if (/^无台词[。.!！]?$/.test(value)) return [];
  if (!value) return [`${context}：台词格为空，必须写“无台词”或完整中英台词`];

  const parts = String(cell).split(/<br\s*\/?>/i).map(clean).filter(Boolean);
  const content = parts.filter((part) => !/^(?:表演|动作|语气)\s*[:：]/.test(part));
  if (content.length && content.every((part) => /^无台词[。.!！]?$/.test(part) || /^(?:EN|英文)\s*[:：]\s*(?:[（(]?无[）)]?|none)$/i.test(part))) return [];
  const errors = [];
  let pendingChinese = [];
  let pairs = 0;

  for (const part of content) {
    const english = part.match(/^(?:EN|英文)\s*[:：]\s*(.*)$/i);
    if (english) {
      const englishText = clean(english[1]);
      if (!pendingChinese.length) errors.push(`${context}：EN 台词前缺少中文台词`);
      if (!englishText || PLACEHOLDER.test(englishText)) errors.push(`${context}：英文台词为空或使用“同上”占位`);
      else if (!LATIN.test(englishText)) errors.push(`${context}：EN 后没有真实英文`);
      const targets = englishText.split(/\s+\/\s+/).map(clean).filter(Boolean);
      if (pendingChinese.length > 1 && targets.length !== pendingChinese.length) errors.push(`${context}：多句中文没有逐句对应英文`);
      for (let index = 0; index < pendingChinese.length; index++) {
        const chinese = pendingChinese[index];
        const targetText = targets.length === pendingChinese.length ? targets[index] : englishText;
        if (!HAN.test(chinese) && !isLanguageNeutral(chinese)) errors.push(`${context}：中文位置没有真实中文`);
        const source = stripSpeaker(chinese).replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
        const target = clean(targetText).replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
        if (source && source === target && !isLanguageNeutral(chinese)) errors.push(`${context}：中英文内容重复，没有中文翻译`);
      }
      pendingChinese = [];
      pairs++;
      continue;
    }

    if (/^(?:中文|中)\s*[:：]/.test(part) && pairs > 0 && !pendingChinese.length) {
      errors.push(`${context}：中英文顺序颠倒，中文必须写在 EN 前`);
    }
    pendingChinese.push(part);
  }

  if (pendingChinese.length) errors.push(`${context}：中文台词缺少对应 EN 台词`);
  if (!pairs) errors.push(`${context}：有台词但没有完整的“中文 + EN”配对`);
  return unique(errors);
}

function markerEvents(line) {
  const markers = [];
  const pattern = /（中文?）|\(中文?\)|（EN）|\(EN\)|^\s*EN\s*[:：]/gi;
  let match;
  while ((match = pattern.exec(line))) {
    const marker = match[0];
    markers.push({ kind: /EN/i.test(marker) ? "en" : "zh", index: match.index, end: pattern.lastIndex });
  }
  return markers.map((marker, index) => ({
    ...marker,
    value: clean(line.slice(marker.end, markers[index + 1]?.index ?? line.length).replace(/^\*{0,2}\s*[:：—-]?\s*/, "")),
  }));
}

export function screenplayBilingualErrors(markdown, canonicalNames = []) {
  const events = [];
  const obviousUnmarked = [];
  const lines = String(markdown).split("\n");

  lines.forEach((line, index) => {
    const found = markerEvents(line);
    for (const event of found) events.push({ ...event, line: index + 1 });
    if (!found.length && /^\s*(?:\*{0,2})?[A-Z][A-Za-z .'-]{1,40}(?:\*{0,2})?\s*[:：]\s*\S/.test(line)) obviousUnmarked.push(index + 1);
  });

  const errors = [];
  let pending = null;
  for (const event of events) {
    if (event.kind === "zh") {
      if (pending) errors.push(`剧本第 ${pending.line} 行中文台词缺少对应英文`);
      pending = event;
      if (!HAN.test(event.value) && !isCanonicalNameCall(event.value, canonicalNames)) errors.push(`剧本第 ${event.line} 行中文标记后没有真实中文`);
      continue;
    }
    if (!pending) errors.push(`剧本第 ${event.line} 行英文台词缺少对应中文`);
    if (!event.value || PLACEHOLDER.test(event.value)) errors.push(`剧本第 ${event.line} 行英文台词为空或使用“同上”占位`);
    else if (!LATIN.test(event.value)) errors.push(`剧本第 ${event.line} 行 EN 后没有真实英文`);
    pending = null;
  }
  if (pending) errors.push(`剧本第 ${pending.line} 行中文台词缺少对应英文`);
  for (const line of obviousUnmarked) errors.push(`剧本第 ${line} 行疑似未按“角色（中）/角色（EN）”格式提交台词`);
  if (!events.some((event) => event.kind === "zh") || !events.some((event) => event.kind === "en")) errors.push("剧本缺少完整中英双语台词标记");
  return unique(errors);
}
