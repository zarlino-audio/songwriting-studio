import type { BeatProfile, SongSectionPayload } from "../types";
import { analyseLyrics } from "./text";

export interface HealthCheck {
  key: string;
  label: string;
  status: "ok" | "watch" | "weak";
  note: string;
}

export interface SongHealth {
  checks: HealthCheck[];
  metrics: {
    totalLines: number;
    totalWords: number;
    totalSyllables: number;
    averageSyllablesPerLine: number;
    sectionCount: number;
    emptySections: number;
  };
  flags: { kind: string; message: string; detail?: string }[];
}

/**
 * Song Health Check (spec §27) — deterministic and analytical, never
 * complimentary. It measures what can be measured locally and leaves judgement
 * to the artist (and to the AI critique mode when they ask for it).
 */
export function analyseSongHealth(
  sections: SongSectionPayload[],
  beat: BeatProfile | null,
  concept: string | null,
): SongHealth {
  const lyricMetrics = analyseLyrics(sections.map((s) => ({ kind: s.kind, content: s.content })));
  const checks: HealthCheck[] = [];

  const filled = sections.filter((section) => section.content.trim().length > 0);
  const words = lyricMetrics.totalWords;
  const lines = lyricMetrics.totalLines;

  // Concept
  checks.push(
    concept && concept.trim().length > 0
      ? { key: "concept", label: "Concept", status: "ok", note: `Stated: “${concept.trim()}”` }
      : {
          key: "concept",
          label: "Concept",
          status: words > 40 ? "watch" : "weak",
          note: "No concept recorded. The song can drift without one — write it down in the song settings.",
        },
  );

  // Story progression: does the vocabulary actually move across sections?
  const uniqueLineRatio = lines > 0 ? new Set(lyricMetrics.lines.map((l) => l.text.toLowerCase())).size / lines : 0;
  checks.push({
    key: "story",
    label: "Story",
    status: lines < 4 ? "weak" : uniqueLineRatio > 0.75 ? "ok" : "watch",
    note:
      lines < 4
        ? "Too little written to judge progression."
        : uniqueLineRatio > 0.75
          ? `${Math.round(uniqueLineRatio * 100)}% of lines are distinct — the writing is moving.`
          : `Only ${Math.round(uniqueLineRatio * 100)}% of lines are distinct — heavy repetition may stall the story.`,
  });

  // Hook: is there a chorus-like section and is it repeated?
  const chorusSections = sections.filter((section) => section.kind === "chorus" && section.content.trim().length > 0);
  checks.push(
    chorusSections.length === 0
      ? { key: "hook", label: "Hook", status: "watch", note: "No chorus written yet — no hook to remember." }
      : chorusSections.length === 1
        ? { key: "hook", label: "Hook", status: "ok", note: "One chorus written; repeat it for memory value." }
        : { key: "hook", label: "Hook", status: "ok", note: `${chorusSections.length} chorus sections — repeated hook detected.` },
  );

  // Clichés / filler (from the local flags)
  const cliches = lyricMetrics.flags.filter((f) => f.kind === "cliche");
  checks.push({
    key: "lyrics",
    label: "Lyrics",
    status: cliches.length === 0 ? "ok" : cliches.length > 2 ? "weak" : "watch",
    note: cliches.length === 0 ? "No well-worn phrases detected." : `${cliches.length} cliché(s): ${cliches.slice(0, 3).map((c) => c.message).join("; ")}`,
  });

  // Repetition
  const rhythmFlags = lyricMetrics.flags.filter((f) => f.kind === "rhythm");
  checks.push({
    key: "rhythm",
    label: "Rhythm",
    status: rhythmFlags.length === 0 ? "ok" : "watch",
    note: rhythmFlags.length === 0 ? "Cadence varies across sections." : rhythmFlags.map((f) => f.message).join("; "),
  });

  // Contrast between verse and chorus density
  const verseLines = lyricMetrics.bySection.filter((s) => s.kind === "verse").flatMap((s) => s.lines);
  const chorusLines = lyricMetrics.bySection.filter((s) => s.kind === "chorus").flatMap((s) => s.lines);
  const avg = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
  const verseAvg = avg(verseLines.map((l) => l.syllables));
  const chorusAvg = avg(chorusLines.map((l) => l.syllables));
  if (verseLines.length === 0 || chorusLines.length === 0) {
    checks.push({ key: "contrast", label: "Contrast", status: "watch", note: "Write both a verse and a chorus to compare their feel." });
  } else {
    const delta = chorusAvg - verseAvg;
    checks.push({
      key: "contrast",
      label: "Contrast",
      status: Math.abs(delta) < 1 ? "watch" : "ok",
      note:
        Math.abs(delta) < 1
          ? `Verse and chorus average ${verseAvg.toFixed(1)} vs ${chorusAvg.toFixed(1)} syllables — they feel identical rhythmically.`
          : `Chorus averages ${chorusAvg.toFixed(1)} syllables/line vs verse ${verseAvg.toFixed(1)} — the sections differ.`,
    });
  }

  // Emotion: crude but honest proxy — question marks, negation, first person in the hook.
  const allText = sections.map((s) => s.content).join("\n");
  const questionCount = (allText.match(/\?/g) ?? []).length;
  const negationCount = (allText.match(/\b(no|not|never|nothing|can't|won't|don't)\b/gi) ?? []).length;
  checks.push({
    key: "emotion",
    label: "Emotion",
    status: words < 20 ? "weak" : questionCount + negationCount > 0 ? "ok" : "watch",
    note:
      words < 20
        ? "Not enough writing to read emotional movement."
        : questionCount + negationCount > 0
          ? `Tension markers present (${questionCount} question(s), ${negationCount} negation(s)).`
          : "No questions or negations — the emotional register may be flat.",
  });

  // Beat fit (spec §27): does writing density follow the beat's energy contour?
  if (beat) {
    const chorusEnergy = beat.energy.by_section["chorus"] ?? beat.energy.overall;
    const verseEnergy = beat.energy.by_section["verse"] ?? beat.energy.overall;
    if (chorusLines.length > 0 && verseLines.length > 0) {
      const beatDelta = chorusEnergy - verseEnergy;
      const writeDelta = chorusAvg - verseAvg;
      const aligned = (beatDelta >= 0.1 && writeDelta >= 0) || (beatDelta < 0.1 && Math.abs(writeDelta) < 3);
      checks.push({
        key: "beat_fit",
        label: "Beat fit",
        status: aligned ? "ok" : "watch",
        note: aligned
          ? `Writing density follows the beat contour (${beat.bpm} BPM, chorus ${chorusEnergy.toFixed(2)} vs verse ${verseEnergy.toFixed(2)}).`
          : `The beat lifts ${beatDelta >= 0 ? "into" : "against"} the chorus (${beatDelta.toFixed(2)}) while the writing moves ${writeDelta.toFixed(1)} syllables/line — check whether that contrast is deliberate.`,
      });
    } else {
      checks.push({
        key: "beat_fit",
        label: "Beat fit",
        status: "watch",
        note: `Beat is ${beat.bpm} BPM in ${beat.key}; write verse and chorus to compare against its energy contour.`,
      });
    }
  } else {
    checks.push({ key: "beat_fit", label: "Beat fit", status: "watch", note: "No beat attached to this song." });
  }

  // Structure completeness
  checks.push({
    key: "structure",
    label: "Structure",
    status: filled.length === 0 ? "weak" : filled.length >= 3 ? "ok" : "watch",
    note:
      filled.length === 0
        ? "No sections have content yet."
        : `${filled.length} of ${sections.length} sections have writing. Empty: ${sections
            .filter((s) => s.content.trim().length === 0)
            .map((s) => s.label ?? s.kind)
            .join(", ") || "none"}.`,
  });

  return {
    checks,
    metrics: {
      totalLines: lyricMetrics.totalLines,
      totalWords: lyricMetrics.totalWords,
      totalSyllables: lyricMetrics.totalSyllables,
      averageSyllablesPerLine: lyricMetrics.averageSyllablesPerLine,
      sectionCount: sections.length,
      emptySections: sections.filter((s) => s.content.trim().length === 0).length,
    },
    flags: lyricMetrics.flags.map((flag) => ({ kind: flag.kind, message: flag.message, detail: flag.detail })),
  };
}
