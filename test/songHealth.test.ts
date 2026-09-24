import { describe, expect, it } from "vitest";
import { analyseSongHealth } from "../src/core/songHealth";
import { mergeProfile } from "../src/core/profileEdit";
import { buildStubProfile } from "../src/integrations/analysis";
import type { SongSectionPayload } from "../src/types";

const beat = buildStubProfile("beat_health", 180);

function sections(entries: [string, string][]): SongSectionPayload[] {
  return entries.map(([kind, content], index) => ({
    id: `sec_${index}`,
    position: index,
    kind,
    label: kind,
    content,
    barStart: index * 8,
    barEnd: (index + 1) * 8,
  }));
}

describe("song health check (spec §27)", () => {
  it("asks for a concept when nothing is recorded", () => {
    const health = analyseSongHealth(sections([["verse", "one line here"]]), beat, null);
    const concept = health.checks.find((check) => check.key === "concept");
    expect(concept?.status).not.toBe("ok");
  });

  it("recognises a repeated chorus as a hook", () => {
    const health = analyseSongHealth(
      sections([
        ["verse", "I came from the place where the lights stay low"],
        ["chorus", "Still hungry, still hungry"],
        ["chorus", "Still hungry, still hungry"],
      ]),
      beat,
      "success without losing hunger",
    );
    const hook = health.checks.find((check) => check.key === "hook");
    expect(hook?.status).toBe("ok");
    expect(hook?.note).toContain("2 chorus");
  });

  it("reports metrics and flags", () => {
    const health = analyseSongHealth(sections([["verse", "I rise and grind every day"]]), null, "x");
    expect(health.metrics.totalLines).toBe(1);
    expect(health.flags.some((flag) => flag.kind === "cliche")).toBe(true);
  });

  it("warns when no beat is attached to beat fit", () => {
    const health = analyseSongHealth(sections([["verse", "hello there"]]), null, "c");
    expect(health.checks.find((check) => check.key === "beat_fit")?.status).toBe("watch");
  });

  it("counts empty sections", () => {
    const health = analyseSongHealth(sections([["verse", "words"], ["chorus", ""]]), beat, "c");
    expect(health.metrics.emptySections).toBe(1);
  });
});

describe("profile corrections (spec §7)", () => {
  it("applies artist corrections and marks the profile as corrected", () => {
    const original = buildStubProfile("beat_edit");
    const corrected = mergeProfile(original, { bpm: 104, key: "F# minor", energy: { by_section: { chorus: 0.95 } } });
    expect(corrected.bpm).toBe(104);
    expect(corrected.bpm_confidence).toBe(1);
    expect(corrected.key).toBe("F# minor");
    expect(corrected.energy.by_section["chorus"]).toBe(0.95);
    expect(corrected.warnings.some((warning) => warning.startsWith("Artist corrected"))).toBe(true);
    // The original object must not be mutated.
    expect(original.bpm).not.toBe(104);
  });

  it("accepts edited sections and keeps bar ranges sane", () => {
    const original = buildStubProfile("beat_sections");
    const corrected = mergeProfile(original, {
      sections: [
        { type: "intro", start: 0, end: 16, energy: 0.2, confidence: 1, bars: [0, 8] },
        { type: "verse", start: 16, end: 48, energy: 0.5, confidence: 1, bars: [8, 24] },
      ],
    });
    expect(corrected.sections).toHaveLength(2);
    expect(corrected.sections[1]?.bars).toEqual([8, 24]);
  });

  it("ignores nonsense values", () => {
    const original = buildStubProfile("beat_nonsense");
    const corrected = mergeProfile(original, {
      bpm: Number.NaN,
      key: "   ",
      sections: [{ start: 10, end: 5 }, { garbage: true }],
    });
    expect(corrected.bpm).toBe(original.bpm);
    expect(corrected.key).toBe(original.key);
    expect(corrected.sections.length).toBe(original.sections.length);
  });
});
