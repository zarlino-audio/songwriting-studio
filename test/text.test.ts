import { describe, expect, it } from "vitest";
import {
  analyseLyrics,
  countSyllables,
  countSyllablesWord,
  endRhymeGroups,
  flagLyrics,
  internalRhymes,
  lineMetrics,
  repeatedPhrases,
  rhymeKey,
  rhymeType,
  stressPattern,
} from "../src/core/text";

describe("syllable counting", () => {
  it("handles common words", () => {
    expect(countSyllablesWord("light")).toBe(1);
    expect(countSyllablesWord("money")).toBe(2);
    expect(countSyllablesWord("beautiful")).toBe(3);
    expect(countSyllablesWord("every")).toBe(2);
    expect(countSyllablesWord("love")).toBe(1);
  });

  it("handles silent e and vowel groups", () => {
    expect(countSyllablesWord("place")).toBe(1);
    expect(countSyllablesWord("change")).toBe(1);
    expect(countSyllablesWord("table")).toBe(2);
    expect(countSyllablesWord("heart")).toBe(1);
  });

  it("counts a whole line", () => {
    // Ten monosyllabic words.
    expect(countSyllables("I came from the place where the lights stay low")).toBe(10);
    // The -ery family is in the exception table: Now + ev-ery-bod-y + wants + to + know.
    expect(countSyllables("Now everybody wants to know")).toBe(8);
  });
});

describe("stress estimation", () => {
  it("marks function words as unstressed", () => {
    const pattern = stressPattern("I came from the place");
    expect(pattern.split(" ")).toHaveLength(countSyllables("I came from the place"));
    expect(pattern.startsWith("x")).toBe(true);
  });

  it("stresses content words", () => {
    expect(stressPattern("money")).toBe("/ x");
  });
});

describe("rhyme logic", () => {
  it("produces matching keys for perfect rhymes", () => {
    expect(rhymeType("light", "night")).toBe("perfect");
    expect(rhymeType("low", "know")).toBe("perfect");
    expect(rhymeType("way", "day")).toBe("perfect");
  });

  it("produces near rhymes for shared codas", () => {
    expect(rhymeType("love", "move")).not.toBe("perfect");
    expect(rhymeType("money", "honey")).toBe("perfect");
    expect(rhymeType("orange", "silver")).toBe("none");
    expect(rhymeType("done", "gone")).not.toBe("perfect");
  });

  it("groups end rhymes across lines", () => {
    const groups = endRhymeGroups([
      "I came from the place where the lights stay low",
      "Now everybody wants to know",
      "I keep the same hunger even with the glow",
    ]);
    expect(groups.length).toBeGreaterThan(0);
    const sizes = groups.map((group) => group.lineIndexes.length);
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(3);
  });

  it("finds internal rhymes", () => {
    const found = internalRhymes("I stack it and pack it and send it back");
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("repetition + clichés", () => {
  it("detects repeated phrases", () => {
    const text = "still hungry still hungry still hungry for more\nhungry for more";
    const repeated = repeatedPhrases(text, 2, 2);
    expect(repeated.some((entry) => entry.phrase.includes("hungry"))).toBe(true);
  });

  it("flags clichés and filler", () => {
    const flags = flagLyrics([
      { text: "I rise and grind every single day", sectionKind: "verse" },
      { text: "and I will never give up on it now", sectionKind: "verse" },
    ]);
    expect(flags.filter((flag) => flag.kind === "cliche").length).toBe(2);
  });

  it("flags rhythmic monotony inside a section", () => {
    const line = "I came from the place where the lights stay low";
    const flags = flagLyrics(
      Array.from({ length: 5 }, () => ({ text: line, sectionKind: "chorus" })),
    );
    expect(flags.some((flag) => flag.kind === "rhythm")).toBe(true);
  });
});

describe("analyseLyrics", () => {
  it("aggregates metrics by section", () => {
    const metrics = analyseLyrics([
      { kind: "verse", content: "line one here\nline two here" },
      { kind: "chorus", content: "hook line\nhook line again" },
    ]);
    expect(metrics.totalLines).toBe(4);
    expect(metrics.totalWords).toBeGreaterThan(6);
    expect(metrics.bySection).toHaveLength(2);
    expect(metrics.averageSyllablesPerLine).toBeGreaterThan(0);
  });

  it("reports per-line metrics", () => {
    const metrics = lineMetrics("Now everybody wants to know");
    expect(metrics.words).toBe(5);
    expect(metrics.endWord).toBe("know");
    expect(metrics.syllables).toBeGreaterThan(3);
 });
});

describe("rhymeKey stability", () => {
  it("normalises common spellings", () => {
    expect(rhymeKey("night")).toBe(rhymeKey("kite"));
    expect(rhymeKey("low")).toBe(rhymeKey("know"));
  });
});
