const SUMMARY_PREFIX = "交付统计：";
const NUMBER = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const DURATION = new RegExp(`^(${NUMBER})\\s*(?:s|秒)?$`, "i");
const TIMING_SUFFIX = new RegExp(`(?:[｜|· \\t]*(?:预计|总时长|时长)[：:]?\\s*${NUMBER}\\s*(?:秒|s)(?:\\s*[（(]\\s*\\d+\\s*分\\s*\\d+\\s*秒\\s*[）)])?|[（(]\\s*(?:(?:预计|总时长|时长)[：:]?\\s*)?${NUMBER}\\s*(?:秒|s)\\s*[）)])$`, "i");
const cells = (line) => line.trim().split("|").slice(1, -1).map((value) => value.trim());
const stableSeconds = (value) => Number(value.toFixed(9));

export function parseDurationSeconds(value) {
  const match = String(value ?? "").trim().match(DURATION);
  const seconds = match ? Number(match[1]) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : NaN;
}

function episodeName(value) {
  let name = value.replace(/^第\s*\d+\s*集/, "").replace(/^[｜|·:： \t]+/, "").trim();
  let previous;
  do {
    previous = name;
    name = name.replace(/[｜|· \t]+(?:分镜表|分镜剧本|剧本)$/, "").replace(TIMING_SUFFIX, "").trim();
  } while (name !== previous);
  return /^(?:分镜表|分镜剧本|剧本)$/.test(name) ? "" : name;
}

function parsedEpisodes(markdown) {
  const lines = markdown.split("\n"), episodes = [];
  let previousEnd = 0;
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trimStart().startsWith("|")) continue;
    const header = cells(lines[index]);
    if (header.length !== 7 || header[0] !== "镜头号") continue;
    const headerIndex = index, rows = [];
    let separator = index + 1;
    while (separator < lines.length && !lines[separator].trim()) separator++;
    if (!cells(lines[separator] || "").every((value) => /^:?-+:?$/.test(value)) || cells(lines[separator] || "").length !== 7) {
      throw new Error("storyboard table is missing its seven-column separator");
    }
    index = separator + 1;
    while (index < lines.length) {
      if (!lines[index].trim()) { index++; continue; }
      if (!lines[index].trimStart().startsWith("|")) break;
      const row = cells(lines[index]);
      if (row.length !== 7) throw new Error("expected a strict 7-column storyboard table");
      rows.push(row);
      index++;
    }
    if (!rows.length) throw new Error("storyboard table has no shots");
    const headings = lines.slice(previousEnd, headerIndex).flatMap((line, offset) => {
      const match = line.match(/^#{1,6}[ \t]+([^\r\n]*)/);
      return match ? [{ index: previousEnd + offset, text: match[1], episode: Number(match[1].match(/^第\s*(\d+)\s*集/)?.[1]) || null }] : [];
    });
    const shotEpisode = Number(rows[0][0].match(/^ep(\d+)-s\d+$/i)?.[1]) || null;
    const heading = headings.find((item) => item.episode && (!shotEpisode || item.episode === shotEpisode))
      || headings.find((item) => item.episode)
      || headings.find((item) => /^(?:分镜表|分镜剧本|剧本)$/.test(item.text));
    const episode = shotEpisode || heading?.episode || episodes.length + 1;
    const seconds = stableSeconds(rows.reduce((sum, row) => {
      const duration = parseDurationSeconds(row[6]);
      if (!Number.isFinite(duration)) throw new Error(`invalid duration for ${row[0]}: ${row[6]}`);
      return sum + duration;
    }, 0));
    episodes.push({ episode, shots: rows.length, seconds, headingIndex: heading?.index, headerIndex, name: episodeName(heading?.text || "") });
    previousEnd = index;
    index--;
  }
  if (!episodes.length) throw new Error("no storyboard tables found");
  return episodes;
}

function timingFromEpisodes(parsed) {
  const episodes = parsed.map(({ episode, shots, seconds }) => ({ episode, shots, seconds }));
  const totalSeconds = stableSeconds(episodes.reduce((sum, item) => sum + item.seconds, 0));
  return {
    episodes, episodeCount: episodes.length,
    shotCount: episodes.reduce((sum, item) => sum + item.shots, 0), totalSeconds,
    minSeconds: Math.min(...episodes.map((item) => item.seconds)),
    maxSeconds: Math.max(...episodes.map((item) => item.seconds)),
    averageSeconds: stableSeconds(totalSeconds / episodes.length),
  };
}

export function deliveryTiming(markdown) {
  return timingFromEpisodes(parsedEpisodes(markdown));
}

export function withDeliveryTiming(markdown) {
  const parsed = parsedEpisodes(markdown), timing = timingFromEpisodes(parsed);
  const lines = markdown.split("\n"), cr = markdown.includes("\r\n") ? "\r" : "";
  for (const item of [...parsed].reverse()) {
    const title = `# 第 ${item.episode} 集${item.name ? `｜${item.name}` : ""}｜预计 ${item.seconds} 秒${cr}`;
    if (item.headingIndex !== undefined) lines[item.headingIndex] = title;
    else lines.splice(item.headerIndex, 0, title, cr);
  }
  const average = Math.round((timing.averageSeconds + Number.EPSILON) * 100) / 100;
  const summary = `${SUMMARY_PREFIX}共 ${timing.episodeCount} 集、${timing.shotCount} 镜；镜头合计 ${timing.totalSeconds} 秒；单集范围 ${timing.minSeconds}–${timing.maxSeconds} 秒，平均 ${average} 秒。${cr}`;
  const summaryIndex = lines.findIndex((line) => line.startsWith(SUMMARY_PREFIX));
  if (summaryIndex >= 0) lines[summaryIndex] = summary;
  else lines.splice(parsed[0].headingIndex ?? parsed[0].headerIndex, 0, summary, cr);
  return lines.join("\n");
}
