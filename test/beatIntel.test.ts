import { describe, expect, it } from "vitest";
import { describeBeat, deriveMood, isMinorKey } from "../src/core/beatIntel";
import { buildStubProfile, normalizeProfile } from "../src/integrations/analysis";
import type { BeatProfile } from "../src/types";

function profile(overrides: Partial<BeatProfile> = {}): BeatProfile {
  const base = buildStubProfile("beat_test");
  return { ...base, ...overrides };
}

describe("beat intelligence (spec §8)", () => {
  it("describes the energy lift between verse and chorus", () => {
    const beat = profile({
      bpm: 104,
      key: "F# minor",
      energy: { overall: 0.72, curve: [0.3, 0.5, 0.9], by_section: { intro: 0.31, verse: 0.52, chorus: 0.87 } },
    });
    const intelligence = describeBeat(beat, "Dark afro-fusion beat");
    expect(intelligence.headline).toBe("104 BPM · F# minor");
    expect(intelligence.summary).toContain("larger chorus");
    expect(intelligence.characteristics.some((entry) => entry.includes("wider chorus"))).toBe(true);
    expect(intelligence.evidence.some((entry) => entry.includes("chorus energy 0.87"))).toBe(true);
  });

  it("keeps every claim evidenced", () => {
    const intelligence = describeBeat(profile({ key: "A minor", bpm: 90 }), "Beat");
    expect(intelligence.evidence.length).toBeGreaterThan(2);
    expect(intelligence.summary.length).toBeGreaterThan(10);
  });

  it("recognises minor keys and derives mood", () => {
    expect(isMinorKey("F# minor")).toBe(true);
    expect(isMinorKey("F# major")).toBe(false);
    const moods = deriveMood(profile({ key: "C minor", energy: { overall: 0.3, curve: [], by_section: {} } }));
    expect(moods).toContain("melancholic");
  });

  it("says so when the beat has a flat energy profile", () => {
    const quiet = profile({ energy: { overall: 0.5, curve: [], by_section: { verse: 0.5, chorus: 0.52 } } });
    expect(describeBeat(quiet).summary).toContain("steady energy profile");
  });
});

describe("analysis contract", () => {
  it("fills defaults instead of throwing on a partial profile", () => {
    const { profile: normalised, warnings } = normalizeProfile({ bpm: 120 });
    expect(normalised.bpm).toBe(120);
    expect(normalised.time_signature).toBe("4/4");
    expect(normalised.sections).toEqual([]);
    expect(warnings.some((warning) => warning.includes("sections"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("Key"))).toBe(true);
  });

  it("coerces waveform and chord shapes from the service", () => {
    const { profile: normalised } = normalizeProfile({
      bpm: 90,
      key: "A minor",
      technical: { waveform: [[-0.5, 0.5], { min: -0.2, max: 0.2 }], sample_rate: 44100 },
      harmony: { chords: [{ chord: "Am", start: 0, end: 2, confidence: 0.7 }, { nonsense: true }] },
      sections: [{ type: "verse", start: 0, end: 8, energy: 0.4, confidence: 0.5, bars: [0, 4] }],
    });
    expect(normalised.technical.waveform).toHaveLength(2);
    expect(normalised.harmony.chords).toHaveLength(1);
    expect(normalised.sections[0]?.type).toBe("verse");
  });

  it("clamps out-of-range values", () => {
    const { profile: normalised } = normalizeProfile({ bpm: 9000, key: "C major", bpm_confidence: 5 });
    expect(normalised.bpm).toBe(400);
    expect(normalised.bpm_confidence).toBe(1);
  });

  it("produces a deterministic, clearly-labelled stub profile", () => {
    const first = buildStubProfile("beat_stub_1");
    const second = buildStubProfile("beat_stub_1");
    const other = buildStubProfile("beat_stub_2");
    expect(first.bpm).toBe(second.bpm);
    expect(first.key).toBe(second.key);
    expect(first.bpm).not.toBe(other.bpm);
    expect(first.warnings[0]).toContain("Stub analysis");
    expect(first.rhythm.beat_grid.length).toBeGreaterThan(8);
  });
});
