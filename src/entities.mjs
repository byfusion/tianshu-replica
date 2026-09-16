const PERSON_NAME = /^[A-Z][A-Za-z'-]+\s+[A-Z][A-Za-z'-]+$/;
const NON_PERSON_LAST_NAMES = new Set([
  "Arena", "Council", "County", "Crisis", "Holdings", "Logistics", "Mechanical",
  "Pack", "Partners", "Room", "Row", "Solicitors", "Store", "Trust", "Valley",
]);

const escaped = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function chineseEntryNames(charactersMarkdown, ledgerPrefix) {
  const registered = ledgerPrefix.split(/\s*[＝=]\s*/);
  const identity = registered[0].match(/^([\p{Script=Han}·]+)\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?)$/u);
  if (!identity || /待核对|待确认|未确认|未知|疑似|可能/.test(ledgerPrefix)) return [];
  const [, chineseName, englishName] = identity;
  const heading = new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?【${escaped(chineseName)}\\s*[（(]${escaped(englishName)}[）)]([^】\\n]*)】`, "gm");
  for (const match of String(charactersMarkdown).matchAll(heading)) {
    if (/待核对|待确认|未确认|未知|疑似|可能/.test(match[0])) continue;
    const aliases = match[1].split(/[／/]/).flatMap((part) => {
      const alias = part.trim().match(/^化名\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?)$/);
      return alias && registered.slice(1).includes(alias[1]) ? [alias[1]] : [];
    });
    // Both sources must register the same identity; titles and prose are not aliases.
    return [englishName, ...aliases].filter((name) => !NON_PERSON_LAST_NAMES.has(name.split(/\s+/).at(-1)));
  }
  return [];
}

export function canonicalPersonNames(charactersMarkdown, canonicalNames = []) {
  return canonicalNames.flatMap((value) => {
    const prefix = String(value).split(/[（(]/, 1)[0].trim(), names = prefix.split(/\s*\/\s*/);
    if (/^\p{Script=Han}/u.test(prefix)) return chineseEntryNames(charactersMarkdown, prefix);
    if (names.length > 2 || names.some((name) => !/^[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?$/.test(name) || NON_PERSON_LAST_NAMES.has(name.split(/\s+/).at(-1)))) return [];
    const sharedEntry = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?${escaped(prefix)}(?:\\*\\*)?\\s*(?:[（(]|,\\s*\\d{2}\\b|[:：])`).test(String(charactersMarkdown));
    return sharedEntry ? names : [];
  });
}

export function fixedEntityErrors(markdown, canonicalNames = []) {
  const byFirstName = new Map();
  for (const name of canonicalNames.filter((value) => PERSON_NAME.test(value) && !NON_PERSON_LAST_NAMES.has(value.split(/\s+/)[1]))) {
    const firstName = name.split(/\s+/)[0];
    byFirstName.set(firstName, [...(byFirstName.get(firstName) || []), name]);
  }
  const errors = [];
  for (const [firstName, allowed] of byFirstName) {
    const pattern = new RegExp(`\\b${firstName}\\s+([A-Z][A-Za-z'-]+)\\b`, "g");
    for (const match of String(markdown).matchAll(pattern)) {
      const candidate = `${firstName} ${match[1].replace(/'s$/, "")}`;
      if (!allowed.includes(candidate)) errors.push(`固定人物姓名漂移：${candidate}；应为 ${allowed.join(" / ")}`);
    }
  }
  return [...new Set(errors)];
}
