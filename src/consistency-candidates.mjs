// Evidence for review, never a verdict or a production gate.
const ZH_NUMBER = "(?:\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百千万]+|半)";
const EN_NUMBER = "(?:\\d+(?:\\.\\d+)?|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|one|two|three|four|five|six|seven|eight|nine|ten|half(?: an?)?|an?)";
const ZH_QUANTITY = new RegExp(`(${ZH_NUMBER})\\s*(个小时|小时|个时辰|时辰|分钟|秒钟|秒|天|日|个月|月|年|条|只|个|次|瓶)`, "g");
const EN_QUANTITY = new RegExp(`(?<![A-Za-z-])(${EN_NUMBER})\\s+(seconds?|minutes?|hours?|days?|months?|years?|reports?|dragons?|bottles?|times?|options?)\\b`, "gi");
const UNIT = { 个小时: ["time", 3600], 小时: ["time", 3600], 个时辰: ["time", 7200], 时辰: ["time", 7200], 分钟: ["time", 60], 秒钟: ["time", 1], 秒: ["time", 1], 天: ["time", 86400], 日: ["time", 86400], 个月: ["month", 1], 月: ["month", 1], 年: ["year", 1], 条: ["count", 1], 只: ["count", 1], 个: ["count", 1], 次: ["count", 1], 瓶: ["count", 1], second: ["time", 1], minute: ["time", 60], hour: ["time", 3600], day: ["time", 86400], month: ["month", 1], year: ["year", 1], report: ["count", 1], dragon: ["count", 1], bottle: ["count", 1], time: ["count", 1], option: ["count", 1] };
const NUMBER = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const UNKNOWN = /待确认|未确认|未知|疑似|是否|不确定/;

function numberValue(raw) {
  const value = raw.toLowerCase();
  if (/^half/.test(value)) return 0.5;
  if (Object.hasOwn(NUMBER, value)) return NUMBER[value];
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const englishTens = value.split(/[- ]/);
  if (englishTens.length === 2 && NUMBER[englishTens[0]] >= 20 && NUMBER[englishTens[1]] < 10) return NUMBER[englishTens[0]] + NUMBER[englishTens[1]];
  const tens = value.match(/^([一二两三四五六七八九]?)十([一二三四五六七八九]?)$/);
  return tens ? (NUMBER[tens[1]] ?? 1) * 10 + (NUMBER[tens[2]] ?? 0) : null;
}

function quantities(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => {
    // "A second birth" is ordinal; this small scanner does not resolve that syntax.
    if (/^an?$/i.test(match[1]) && /^second$/i.test(match[2])) return null;
    const value = numberValue(match[1]);
    const [unit, factor] = UNIT[match[2].toLowerCase().replace(/s$/, "")];
    return value === null ? null : `${unit}:${value * factor}`;
  }).filter(Boolean))].sort();
}

function bilingualCues(zh, en) {
  const cues = [];
  const left = quantities(zh, ZH_QUANTITY), right = quantities(en, EN_QUANTITY);
  if (left.length && right.length) {
    const shared = new Set(left.map((value) => value.split(":")[0]).filter((unit) => right.some((value) => value.startsWith(`${unit}:`))));
    // Compare shared measurable units; unmatched phrases are not proof of omission.
    const relevant = (values) => shared.size ? values.filter((value) => shared.has(value.split(":")[0])) : values;
    if (JSON.stringify(relevant(left)) !== JSON.stringify(relevant(right))) cues.push("bilingual_quantity");
  }
  const temporalNegation = /早已|早就|已经|刚|之前|从未|还没|尚未/.test(zh)
    && /\b(?:not|never|wasn't|wasn’t|isn't|isn’t|hadn't|hadn’t|hasn't|hasn’t|didn't|didn’t|can't|can’t)\b/i.test(en)
    && /\b(?:already|just|ago|before|yet|been)\b/i.test(en);
  const deadline = /之内|之前|满.{0,5}(?:月|岁)|截至/.test(zh)
    && /\b(?:within|by|before)\b/i.test(en) && (left.length || right.length);
  if (temporalNegation || deadline) cues.push("bilingual_temporal_negation");
  return cues;
}

function pairs(cell) {
  const parts = cell.split(/<br\s*\/?>|\n/i);
  const result = [];
  let zh = null;
  for (const part of parts) {
    if (/^\s*(?:表演|动作|语气)\s*[:：]/.test(part)) continue;
    const en = part.match(/^\s*(?:EN|英文)\s*[:：](.*)$/i);
    if (en) {
      if (zh) result.push({ zh, en: part, enText: en[1] });
      zh = null;
    } else if (/\p{Script=Han}/u.test(part) && !/^\s*无台词/.test(part)) zh = part;
  }
  return result;
}

function canonicalClaims(canonical) {
  return String(canonical).split("\n").flatMap((line) => {
    const match = line.match(/^\s*(?:[-*#]+\s*|\d+[.、]\s*)?([A-Z][A-Za-z'-]*(?: [A-Z][A-Za-z'-]*)*)(?:\s*[（(][^）)]*[）)])?\s*[:：](.+)$/);
    if (!match) return [];
    const description = match[2].split(/核心能力|行为轨迹|关系[:：]|关键节点/)[0];
    return [{ name: match[1], alias: match[1].split(" ")[0], line, description }];
  });
}

function claimContrasts(text, claims) {
  const quotes = [];
  for (const claim of claims) {
    if (claims.some((other) => other.alias === claim.alias && other.name !== claim.name)) continue;
    const name = claim.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${name}(?: ${claim.name.split(" ").slice(1).join(" ")})?\\s*[（(]([^）)]*)[）)]`, "g");
    for (const current of text.matchAll(pattern)) {
      if (UNKNOWN.test(current[1])) continue;
      const canonicalRole = claim.description.split(/[。；;]/)[0];
      const kingHeir = !UNKNOWN.test(canonicalRole) && (
        /黑龙王|国王|君主/.test(canonicalRole) && /王储|太子|储君/.test(current[1])
        || /王储|太子|储君/.test(canonicalRole) && /黑龙王|国王|君主/.test(current[1]));
      // Match complete attribute phrases, not a story-specific asset dictionary.
      const phrases = current[1].split(/[，,、；;。]/).map((phrase) => phrase.trim()).filter((phrase) => phrase.length >= 4 && !claim.description.includes(phrase));
      const borrowed = phrases.flatMap((phrase) => {
        const owners = claims.filter((other) => other.name !== claim.name && other.description.includes(phrase));
        return new Set(owners.map((other) => other.name)).size === 1 ? owners : [];
      });
      if (kingHeir || borrowed.length) {
        quotes.push({ label: "canonical_claim_contrast:当前具名属性", text: current[0] }, { label: "canonical_claim_contrast:本角色依据", text: claim.line });
        for (const other of borrowed) quotes.push({ label: "canonical_claim_contrast:其他角色资产依据", text: other.line });
      }
    }
  }
  return quotes;
}

function nearby(lines, index) {
  return lines.slice(Math.max(0, index - 2), index + 3).join("\n");
}

export function collectConsistencyCandidates({ stage, episode, screenplay = "", storyboard = "", canonical = "" }) {
  const result = [];
  const claims = canonicalClaims(canonical);
  const add = (location, shotId, cues, quotes, context) => {
    if (!cues.length) return;
    const kinds = [...new Set(cues)];
    const seen = new Set();
    result.push({ id: `consistency-${stage}-ep${episode}-${location}`, episode, ...(shotId ? { shotId } : {}), kind: kinds.length === 1 ? kinds[0] : "multiple_consistency_cues", quotes: quotes.filter((quote) => { const key = `${quote.label}\n${quote.text}`; if (seen.has(key)) return false; seen.add(key); return true; }), context });
  };
  if (stage === "storyboard") {
    const lines = String(storyboard).split("\n");
    lines.forEach((line, index) => {
      const cells = line.trim().split("|").slice(1, -1).map((cell) => cell.trim());
      if (cells.length !== 7 || !/^ep\d+-s\d+$/.test(cells[0])) return;
      const cues = [], quotes = [];
      for (const pair of pairs(cells[2])) {
        const risks = bilingualCues(pair.zh, pair.enText);
        cues.push(...risks);
        for (const kind of risks) quotes.push({ label: `${kind}:中文`, text: pair.zh }, { label: `${kind}:英文`, text: pair.en });
      }
      if (/(?:嘴|唇).{0,12}无声|无声.{0,12}(?:嘴|唇|开口)/.test(cells[1])
        && pairs(cells[2]).length && !/心声|内心|画外音|旁白|配音|口述.{0,5}未知|发声.{0,5}未知/.test(cells[2])) {
        cues.push("voice_action_dialogue");
        quotes.push({ label: "voice_action_dialogue:画面动作", text: cells[1] }, { label: "voice_action_dialogue:台词及表演", text: cells[2] });
      }
      const contrasts = claimContrasts(cells[4], claims);
      if (contrasts.length) { cues.push("canonical_claim_contrast"); quotes.push(...contrasts); }
      add(cells[0], cells[0], cues, quotes, nearby(lines, index));
    });
  } else if (stage === "screenplay") {
    const lines = String(screenplay).split("\n");
    lines.forEach((line, index) => {
      const cues = [], quotes = [];
      const zh = line.match(/（中文?）|\(中文?\)/);
      const next = lines[index + 1] || "";
      if (zh && /（EN）|\(EN\)/i.test(next)) {
        cues.push(...bilingualCues(line.slice(zh.index + zh[0].length), next.split(/（EN）|\(EN\)/i).slice(1).join("")));
        quotes.push(...cues.flatMap((kind) => [{ label: `${kind}:中文`, text: line }, { label: `${kind}:英文`, text: next }]));
      }
      const contrasts = claimContrasts(line, claims);
      if (contrasts.length) { cues.push("canonical_claim_contrast"); quotes.push(...contrasts); }
      add(`line${index + 1}`, null, cues, quotes, nearby(lines, index));
    });
  }
  return result;
}
