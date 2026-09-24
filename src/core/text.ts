/**
 * Local, zero-cost text logic (spec §36): syllable counting, stress estimation,
 * rhyme keys, repetition and cliché detection. No model calls — this runs on
 * every keystroke.
 */

const VOWELS = "aeiouy";

/** Common words the naive counter gets wrong. */
const SYLLABLE_EXCEPTIONS: Record<string, number> = {
  every: 2, evening: 3, business: 2, beautiful: 3, people: 2, again: 2, heaven: 2, seven: 2,
  prayer: 2, fire: 1, hour: 1, our: 1, flower: 2, power: 2, higher: 2, tired: 1, yeah: 1,
  heart: 1, worth: 1, world: 1, girl: 1, love: 1, move: 1, prove: 1, said: 1, says: 1,
  money: 2, city: 2, story: 2, glory: 2, niggaz: 2, brother: 2, mother: 2, father: 2,
  anything: 3, everything: 3, something: 2, nothing: 2, someone: 2, everyone: 3,
  being: 2, doing: 2, going: 2, seeing: 2, trying: 2, crying: 2, dying: 2, lying: 2,
  played: 1, prayed: 1, stayed: 1, prayedfor: 2, whoa: 1, oh: 1, ah: 1, ooh: 1, mmm: 1,
  // The -ery / -ory families: the naive vowel-group walk counts one beat too many.
  everybody: 4, nobody: 3, somebody: 3, memory: 3, family: 3, company: 3, history: 3,
  mystery: 3, misery: 3, victory: 3, category: 4, different: 3, favourite: 3, favorite: 3,
  camera: 3, area: 3, idea: 3, video: 3, chocolate: 3, interest: 3, interesting: 4,
  listening: 4, wondering: 4, remembering: 4, feeling: 2, pray: 1, away: 2,
};

export function countSyllablesWord(rawWord: string): number {
  const word = rawWord.toLowerCase().replace(/[^a-z']/g, "");
  if (!word) return 0;
  if (SYLLABLE_EXCEPTIONS[word] !== undefined) return SYLLABLE_EXCEPTIONS[word] as number;
  if (word.length <= 2) return 1;

  let count = 0;
  let previousWasVowel = false;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i] ?? "";
    const isVowel = VOWELS.includes(ch);
    // Treat a trailing "e" as silent (unless preceded by a consonant + "le").
    if (isVowel && !previousWasVowel) {
      const isSilentE = ch === "e" && i === word.length - 1 && !/[aiou]$/.test(word.slice(0, -1));
      const isLeEnding = ch === "e" && /[^aeiou]le$/.test(word);
      if (!isSilentE || isLeEnding) count++;
    }
    previousWasVowel = isVowel;
  }
  if (count === 0) count = 1;
  // "-ion"/"-ial" style endings usually add a beat.
  if (/(tion|sion|cial|tial)$/.test(word) && count > 1) count -= 0;
  return count;
}

export function countSyllables(line: string): number {
  return line
    .split(/\s+/)
    .filter(Boolean)
    .reduce((sum, word) => sum + countSyllablesWord(word), 0);
}

export function countWords(line: string): number {
  return line.split(/\s+/).filter(Boolean).length;
}

/** Words that carry no stress (function words / clitics). */
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "if", "as", "at", "by", "for", "from", "in", "into", "of", "on",
  "to", "up", "with", "is", "am", "are", "was", "were", "be", "been", "being", "do", "does", "did", "has",
  "have", "had", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your",
  "his", "its", "our", "their", "that", "this", "these", "those", "will", "would", "can", "could", "ain't",
]);

/**
 * Rough stress pattern ("x" = unstressed, "/" = stressed) — an estimation, not
 * a pronunciation dictionary. The spec asks for guidance, not authority.
 */
export function stressPattern(line: string): string {
  const words = line.split(/\s+/).filter(Boolean);
  const marks: string[] = [];
  for (const raw of words) {
    const word = raw.toLowerCase().replace(/[^a-z']/g, "");
    if (!word) continue;
    const syllables = countSyllablesWord(word);
    if (FUNCTION_WORDS.has(word)) {
      for (let i = 0; i < syllables; i++) marks.push("x");
      continue;
    }
    // Primary stress tends to sit before these suffixes.
    let stressIndex = 0;
    if (/(tion|sion|ic|ical|ity|ify|ial)$/.test(word) && syllables > 1) stressIndex = syllables - 2;
    else if (/(esque|ette)$/.test(word) && syllables > 1) stressIndex = syllables - 1;
    for (let i = 0; i < syllables; i++) marks.push(i === stressIndex ? "/" : "x");
  }
  return marks.join(" ");
}

/**
 * Rhyme keys.
 *
 * English spelling is not pronunciation, so this is deliberately a heuristic:
 * a table of common rime spellings mapped to canonical rime codes, plus a small
 * exception list for words the patterns get wrong (love/move, done/gone…).
 * It is good enough for highlighting and grouping — and it never pretends to be
 * a pronunciation dictionary.
 */
const RIME_PATTERNS: [RegExp, string][] = [
  [/(?:ight|ite|yte|eit)$/, "AYT"],
  [/(?:eat|eet|ete|eit)$/, "EET"],
  [/(?:ain|ane|ein|aign)$/, "AYN"],
  [/(?:ame|aim)$/, "AYM"],
  [/(?:own|oan|one)$/, "OHN"],
  [/(?:ound|owned)$/, "OWND"],
  [/(?:ow|owe|oh|oe|o)$/, "OH"],
  [/(?:ool|ule|uel)$/, "OOL"],
  [/(?:oom|ume)$/, "OOM"],
  [/(?:oon|une)$/, "OON"],
  [/(?:ue|ew|ou|oo|u)$/, "OO"],
  [/(?:ing|in)$/, "IN"],
  [/(?:ung)$/, "UNG"],
  [/(?:ong)$/, "ONG"],
  [/(?:ank)$/, "ANK"],
  [/(?:ink)$/, "INK"],
  [/(?:ay|ei|ey|ai)$/, "AY"],
  [/(?:y|ie|ee|ea|ey)$/, "EE"],
  [/(?:er|or|ar|ur|ir)$/, "ER"],
];

/** Words the rime patterns mis-handle. */
const WORD_EXCEPTIONS: Record<string, string> = {
  love: "UHV", above: "UHV", glove: "UHV", dove: "UHV",
  move: "OOV", prove: "OOV", groove: "OOV",
  done: "UHN", gone: "AWN", come: "UHM", some: "UHM", one: "WUHN", none: "NUHN", once: "WUHNS",
  who: "HOO", do: "DOO", to: "TOO", two: "TOO", you: "YOO", through: "THROO", though: "THOH",
  enough: "NUHF", tough: "TUHF", rough: "RUHF",
  said: "SED", says: "SEZ", again: "EHN", woman: "WUHMAN", women: "WIHMIN",
  heart: "AART", heard: "HERD", word: "WERD", world: "WERLD",
  money: "UHNEE", honey: "UHNEE",
};

/**
 * Rhyme key = a canonical code for the tail of the word. Two words rhyme
 * perfectly when the codes match; "near" when only the final consonants match
 * with a different vowel tail.
 */
export function rhymeKey(rawWord: string): string {
  const word = rawWord.toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return "";
  const exception = WORD_EXCEPTIONS[word];
  if (exception) return exception;

  for (const [pattern, code] of RIME_PATTERNS) {
    if (pattern.test(word)) return code;
  }

  // Fallback: from the last vowel group to the end, with a trailing silent "e"
  // dropped so "place" and "plac" group together.
  let lastVowel = -1;
  for (let i = word.length - 1; i >= 0; i--) {
    if (VOWELS.includes(word[i] ?? "")) {
      lastVowel = i;
      break;
    }
  }
  if (lastVowel < 0) return word.slice(-3);
  let tail = word.slice(Math.max(0, lastVowel));
  if (tail.length > 2 && tail.endsWith("e") && !/[aeiou]$/.test(tail.slice(0, -1))) tail = tail.slice(0, -1);
  // A one- or two-letter tail matches almost anything ("orange" vs "strange");
  // extend backwards so the key keeps the consonant context.
  if (tail.length < 3) tail = word.slice(Math.max(0, word.length - 3));
  return tail;
}

export function rhymeType(a: string, b: string): "perfect" | "near" | "none" {
  const ka = rhymeKey(a);
  const kb = rhymeKey(b);
  if (!ka || !kb) return "none";
  if (ka === kb) return "perfect";
  // Near: identical trailing consonants with a different vowel tail.
  const tail = (s: string) => s.replace(/[AEIOUY]+/g, "");
  if (tail(ka) === tail(kb) && tail(ka).length > 0) return "near";
  if (ka.slice(1) === kb.slice(1)) return "near";
  return "none";
}

export interface LineMetrics {
  text: string;
  syllables: number;
  words: number;
  stress: string;
  endWord: string;
}

export function lineMetrics(line: string): LineMetrics {
  const words = line.split(/\s+/).filter(Boolean);
  const last = words.length > 0 ? (words[words.length - 1] ?? "").toLowerCase().replace(/[^a-z]/g, "") : "";
  return {
    text: line,
    syllables: countSyllables(line),
    words: words.length,
    stress: stressPattern(line),
    endWord: last,
  };
}

export interface RhymeGroup {
  key: string;
  lineIndexes: number[];
  words: string[];
}

export function endRhymeGroups(lines: string[]): RhymeGroup[] {
  const groups = new Map<string, RhymeGroup>();
  lines.forEach((line, index) => {
    const metrics = lineMetrics(line);
    if (!metrics.endWord || metrics.endWord.length < 2) return;
    const key = rhymeKey(metrics.endWord);
    if (!key) return;
    const group = groups.get(key) ?? { key, lineIndexes: [], words: [] };
    group.lineIndexes.push(index);
    if (!group.words.includes(metrics.endWord)) group.words.push(metrics.endWord);
    groups.set(key, group);
  });
  return [...groups.values()].filter((g) => g.lineIndexes.length > 1);
}

/** Internal rhymes: two distinct words inside one line sharing a rhyme key. */
export function internalRhymes(line: string): { word: string; rhymeWith: string }[] {
  const words = line.toLowerCase().match(/[a-z']{3,}/g) ?? [];
  const found: { word: string; rhymeWith: string }[] = [];
  const seenKeys = new Map<string, string>();
  for (const word of words) {
    if (FUNCTION_WORDS.has(word)) continue;
    const key = rhymeKey(word);
    if (!key) continue;
    const existing = seenKeys.get(key);
    if (existing && existing !== word) found.push({ word, rhymeWith: existing });
    else seenKeys.set(key, word);
  }
  return found;
}

/** Repeated phrases across the whole lyric (spec §20 / §27). */
export function repeatedPhrases(text: string, minWords = 3, minCount = 3): { phrase: string; count: number }[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const counts = new Map<string, number>();
  for (let n = minWords; n <= Math.min(minWords + 2, 6); n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(" ");
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count || b.phrase.length - a.phrase.length)
    .slice(0, 12)
    .filter((entry, index, all) => {
      // Drop phrases that are substrings of an earlier, more frequent phrase.
      return !all.slice(0, index).some((other) => other.phrase.includes(entry.phrase) && other.count >= entry.count);
    });
}

const CLICHES = [
  "rise and grind", "chasing dreams", "against all odds", "never give up", "live laugh love",
  "heart of gold", "light at the end of the tunnel", "rock bottom", "time will tell", "broken heart",
  "diamond in the rough", "shining star", "reach for the stars", "at the end of the day",
  "money can't buy happiness", "all i do is win", "started from the bottom", "living the dream",
  "through the storm", "wings to fly", "dance in the rain", "one in a million", "lost in the moment",
];

export interface LyricFlag {
  kind: "cliche" | "filler" | "repetition" | "rhythm";
  message: string;
  detail?: string;
}

/** Advisory flags — the artist always decides (spec §40). */
export function flagLyrics(lines: { text: string; sectionKind?: string }[]): LyricFlag[] {
  const flags: LyricFlag[] = [];
  const syllableBySection = new Map<string, number[]>();

  for (const line of lines) {
    const lower = line.text.toLowerCase();
    for (const cliche of CLICHES) {
      if (lower.includes(cliche)) {
        flags.push({ kind: "cliche", message: `“${cliche}” is a well-worn phrase`, detail: line.text.trim() });
      }
    }
    const words = line.text.split(/\s+/).filter(Boolean);
    if (words.length >= 6 && countSyllables(line.text) <= words.length - 4) {
      flags.push({ kind: "filler", message: "This line is mostly unstressed filler", detail: line.text.trim() });
    }
    const sectionKind = line.sectionKind ?? "section";
    const list = syllableBySection.get(sectionKind) ?? [];
    list.push(countSyllables(line.text));
    syllableBySection.set(sectionKind, list);
  }

  // Rhythmic monotony: same syllable count on almost every line of a section.
  for (const [kind, counts] of syllableBySection) {
    if (counts.length < 4) continue;
    const tally = new Map<number, number>();
    for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 4 && top[1] / counts.length >= 0.75) {
      flags.push({
        kind: "rhythm",
        message: `${kind}: ${top[1]} of ${counts.length} lines have ${top[0]} syllables — consider varying cadence`,
      });
    }
  }

  return flags.slice(0, 20);
}

export interface LyricMetrics {
  totalLines: number;
  totalWords: number;
  totalSyllables: number;
  averageSyllablesPerLine: number;
  rhymeGroups: RhymeGroup[];
  flags: LyricFlag[];
}

export function analyseLyrics(
  sections: { kind: string; content: string }[],
): LyricMetrics & { lines: LineMetrics[]; bySection: { kind: string; lines: LineMetrics[] }[] } {
  const allLines: LineMetrics[] = [];
  const bySection: { kind: string; lines: LineMetrics[] }[] = [];
  const flatForFlags: { text: string; sectionKind: string }[] = [];

  for (const section of sections) {
    const lines = section.content.split("\n").map((l) => l.trim());
    const metrics = lines.map((line) => lineMetrics(line));
    const nonEmpty = metrics.filter((m) => m.text.length > 0);
    bySection.push({ kind: section.kind, lines: nonEmpty });
    allLines.push(...nonEmpty);
    nonEmpty.forEach((m) => flatForFlags.push({ text: m.text, sectionKind: section.kind }));
  }

  const totalSyllables = allLines.reduce((sum, m) => sum + m.syllables, 0);
  const totalWords = allLines.reduce((sum, m) => sum + m.words, 0);

  return {
    totalLines: allLines.length,
    totalWords,
    totalSyllables,
    averageSyllablesPerLine: allLines.length > 0 ? Math.round((totalSyllables / allLines.length) * 10) / 10 : 0,
    rhymeGroups: endRhymeGroups(allLines.map((m) => m.text)),
    flags: flagLyrics(flatForFlags),
    lines: allLines,
    bySection,
  };
}
