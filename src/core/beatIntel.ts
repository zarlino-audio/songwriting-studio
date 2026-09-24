import type { BeatIntelligence, BeatProfile } from "../types";

/**
 * "What this beat is giving" (spec §8).
 *
 * Deterministic and free: every claim below is derived from the beat profile,
 * and the evidence lines say which numbers produced it. The artist can correct
 * the profile (spec §7 — these are signals, not truths).
 */

const MINOR_HINTS = ["minor", "moll", "aeolian", "dorian", "phrygian"];

export function isMinorKey(key: string): boolean {
  const lower = key.toLowerCase();
  return MINOR_HINTS.some((hint) => lower.includes(hint));
}

function tempoClass(bpm: number): { label: string; note: string } {
  if (bpm < 70) return { label: "slow", note: "lots of space between events — long phrasing fits" };
  if (bpm < 90) return { label: "mid-slow", note: "room for conversational, unhurried delivery" };
  if (bpm < 110) return { label: "mid", note: "a comfortable pocket for melodic writing" };
  if (bpm < 130) return { label: "mid-up", note: "dense phrasing is possible without rushing" };
  return { label: "fast", note: "short phrases and repetition work better than long sentences" };
}

function energyShape(profile: BeatProfile): { summary: string; evidence: string[] } {
  const evidence: string[] = [];
  const bySection = profile.energy.by_section;
  const chorus = bySection["chorus"];
  const verse = bySection["verse"];
  const intro = bySection["intro"];

  if (chorus !== undefined && verse !== undefined) {
    const delta = chorus - verse;
    evidence.push(
      `chorus energy ${chorus.toFixed(2)} vs verse ${verse.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`,
    );
    if (delta >= 0.25) {
      return {
        summary: `a restrained verse pocket that opens into a significantly larger chorus (${chorus.toFixed(2)} vs ${verse.toFixed(2)})`,
        evidence,
      };
    }
    if (delta >= 0.1) {
      return {
        summary: `a verse/chorus contrast that lifts without jumping (${chorus.toFixed(2)} vs ${verse.toFixed(2)})`,
        evidence,
      };
    }
    return {
      summary: `a steady energy profile — verse and chorus sit at similar intensity (${verse.toFixed(2)} vs ${chorus.toFixed(2)}), so contrast has to come from the writing`,
      evidence,
    };
  }

  if (intro !== undefined) evidence.push(`intro energy ${intro.toFixed(2)}`);
  return { summary: "an energy profile without detected verse/chorus landmarks", evidence };
}

export function describeBeat(profile: BeatProfile, title = "Beat"): BeatIntelligence {
  const evidence: string[] = [];
  const characteristics: string[] = [];

  const tempo = tempoClass(profile.bpm);
  const minor = isMinorKey(profile.key);
  const shape = energyShape(profile);

  evidence.push(`tempo ${profile.bpm} BPM (${profile.bpm_confidence.toFixed(2)} confidence, ${tempo.label})`);
  evidence.push(`key ${profile.key} (${profile.key_confidence.toFixed(2)} confidence)`);
  evidence.push(`source: "${title}" analysed by ${profile.engine}${profile.engine_version ? ` v${profile.engine_version}` : ""}`);
  evidence.push(...shape.evidence);
  evidence.push(`transient density ${profile.rhythm.transient_density.toFixed(1)} events/sec, syncopation ${profile.rhythm.syncopation.toFixed(2)}`);
  evidence.push(`${profile.rhythm.bar_count} bars, ${profile.time_signature} time`);

  const dense = profile.rhythm.density >= 0.65;
  const syncopated = profile.rhythm.syncopation >= 0.5;
  const sparseIntro = (profile.energy.by_section["intro"] ?? profile.energy.overall) < 0.45;

  if (sparseIntro) characteristics.push("intimate verse entry — the beat starts low, so a close vocal can sit forward");
  if (profile.sections.some((s) => s.type === "pre-chorus") || (profile.energy.by_section["pre-chorus"] ?? 0) > 0.5) {
    characteristics.push("melodic pre-chorus — there is room to build into the drop");
  }
  if ((profile.energy.by_section["chorus"] ?? 0) - (profile.energy.by_section["verse"] ?? 0) >= 0.1) {
    characteristics.push("wider chorus — write the hook so it can open up here");
  }
  if (!dense) characteristics.push("conversational delivery — the pocket leaves space between words");
  else characteristics.push("rhythmically busy bed — keep phrases short and percussive");
  if (syncopated) characteristics.push("off-beat phrasing potential — lines can land late for tension");
  if (profile.rhythm.beats_per_bar === 4 && !dense) characteristics.push("repeated hook potential — 4-bar loops make a chant hook land");
  if (!dense) characteristics.push("space for vocal ad-libs in the gaps");
  if (minor) characteristics.push("melancholic/night-time tone — minor key supports tension and release writing");

  const mood = profile.mood.length > 0 ? profile.mood : deriveMood(profile);

  const headline = `${profile.bpm} BPM · ${profile.key}`;
  const summary =
    `${capitalise(tempo.label)} tempo, ${minor ? "minor-key" : "major-key"} bed with ${shape.summary}.` +
    (mood.length > 0 ? ` Mood cues: ${mood.join(", ")}.` : "");

  return {
    headline,
    summary,
    characteristics: dedupe(characteristics).slice(0, 8),
    evidence: [...new Set(evidence)].slice(0, 8),
  };
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function deriveMood(profile: BeatProfile): string[] {
  const moods: string[] = [];
  const minor = isMinorKey(profile.key);
  const energy = profile.energy.overall;

  if (minor && energy < 0.5) moods.push("melancholic");
  if (minor && energy >= 0.5) moods.push("tense", "confident");
  if (!minor && energy >= 0.65) moods.push("celebratory", "uplifting");
  if (!minor && energy < 0.5) moods.push("warm");
  if (profile.rhythm.syncopation >= 0.5) moods.push("loose");
  if (profile.rhythm.density >= 0.7) moods.push("aggressive");
  if (profile.rhythm.density < 0.5 && energy < 0.55) moods.push("late-night");
  if (profile.bpm >= 120 && energy >= 0.6) moods.push("high-energy");
  if (moods.length === 0) moods.push("steady");
  return [...new Set(moods)].slice(0, 4);
}

/** Render the intelligence card as text (used for prompts and exports). */
export function beatIntelligenceForPrompt(profile: BeatProfile | null, intelligence: BeatIntelligence | null): string {
  if (!profile || !intelligence) return "No beat analysis available.";
  return [
    `Beat: ${intelligence.headline}`,
    `Energy shape: ${intelligence.summary}`,
    `Characteristics: ${intelligence.characteristics.join("; ")}`,
    `Evidence: ${intelligence.evidence.join("; ")}`,
  ].join("\n");
}
