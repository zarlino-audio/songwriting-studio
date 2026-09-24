import type { BeatProfile, BeatSection } from "../types";
import { clamp, round } from "../util/ids";

/**
 * Artist corrections to the machine-generated beat profile (spec §7: the profile
 * is a signal, not a truth — the artist must be able to correct it).
 *
 * Only known fields are accepted; nothing here can inject arbitrary JSON into
 * the stored profile.
 */
export interface ProfilePatch {
  bpm?: unknown;
  key?: unknown;
  scale?: unknown;
  time_signature?: unknown;
  duration_seconds?: unknown;
  mood?: unknown;
  energy?: { overall?: unknown; by_section?: unknown };
  rhythm?: {
    density?: unknown;
    syncopation?: unknown;
    swing?: unknown;
    groove?: unknown;
    beats_per_bar?: unknown;
  };
  sections?: unknown;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseSections(value: unknown): BeatSection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections: BeatSection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const start = num(record["start"]);
    const end = num(record["end"]);
    if (start === undefined || end === undefined || end <= start) continue;
    const barsRaw = Array.isArray(record["bars"]) ? record["bars"] : [];
    const barStart = num(barsRaw[0]) ?? 0;
    const barEnd = num(barsRaw[1]) ?? 0;
    sections.push({
      type: (text(record["type"]) ?? "instrumental") as BeatSection["type"],
      label: text(record["label"]),
      start,
      end,
      energy: clamp(num(record["energy"]) ?? 0.5, 0, 1),
      confidence: clamp(num(record["confidence"]) ?? 1, 0, 1),
      bars: [Math.max(0, Math.round(barStart)), Math.max(0, Math.round(barEnd))],
    });
  }
  return sections.length > 0 ? sections : undefined;
}

export function mergeProfile(profile: BeatProfile, patch: ProfilePatch): BeatProfile {
  const next: BeatProfile = JSON.parse(JSON.stringify(profile)) as BeatProfile;
  const edited: string[] = [];

  const bpm = num(patch.bpm);
  if (bpm !== undefined) {
    next.bpm = clamp(round(bpm, 3), 20, 400);
    next.bpm_confidence = 1;
    edited.push("bpm");
  }

  const key = text(patch.key);
  if (key) {
    next.key = key;
    next.key_confidence = 1;
    edited.push("key");
  }

  const scale = text(patch.scale);
  if (scale) next.scale = scale;

  const timeSignature = text(patch.time_signature);
  if (timeSignature) {
    next.time_signature = timeSignature;
    edited.push("time_signature");
  }

  const duration = num(patch.duration_seconds);
  if (duration !== undefined && duration > 0) next.duration_seconds = round(duration, 3);

  if (Array.isArray(patch.mood)) {
    next.mood = patch.mood.filter((m): m is string => typeof m === "string").slice(0, 8);
  }

  if (patch.energy) {
    const overall = num(patch.energy.overall);
    if (overall !== undefined) next.energy.overall = clamp(overall, 0, 1);
    const bySection = patch.energy.by_section;
    if (bySection && typeof bySection === "object") {
      for (const [sectionName, value] of Object.entries(bySection as Record<string, unknown>)) {
        const parsed = num(value);
        if (parsed !== undefined) next.energy.by_section[sectionName] = clamp(parsed, 0, 1);
      }
      edited.push("energy");
    }
  }

  if (patch.rhythm) {
    const density = num(patch.rhythm.density);
    if (density !== undefined) {
      next.rhythm.density = clamp(density, 0, 1);
      edited.push("density");
    }
    const syncopation = num(patch.rhythm.syncopation);
    if (syncopation !== undefined) next.rhythm.syncopation = clamp(syncopation, 0, 1);
    const swing = num(patch.rhythm.swing);
    if (swing !== undefined) next.rhythm.swing = clamp(swing, 0, 1);
    const groove = text(patch.rhythm.groove);
    if (groove) next.rhythm.groove = groove;
    const beatsPerBar = num(patch.rhythm.beats_per_bar);
    if (beatsPerBar !== undefined) next.rhythm.beats_per_bar = clamp(Math.round(beatsPerBar), 1, 16);
  }

  const sections = parseSections(patch.sections);
  if (sections) {
    next.sections = sections;
    // Keep the per-section energy map roughly in sync with edited sections.
    const bySection: Record<string, number> = { ...next.energy.by_section };
    for (const section of sections) {
      const existing = bySection[section.type];
      bySection[section.type] = existing === undefined ? section.energy : round((existing + section.energy) / 2, 3);
    }
    next.energy.by_section = bySection;
    edited.push("sections");
  }

  next.warnings = [...next.warnings.filter((warning) => !warning.startsWith("Artist corrected:")), `Artist corrected: ${edited.join(", ") || "profile"}`];
  return next;
}
