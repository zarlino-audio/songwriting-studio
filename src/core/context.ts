import type { ArtistProfileRow, SongRow, SongSectionRow } from "../db/store";
import { parseJsonArray } from "../db/store";
import type { BeatProfile, SongContext } from "../types";

export interface SongContextInput {
  profile: ArtistProfileRow | null;
  beat: { id: string; title: string } | null;
  beatProfile: BeatProfile | null;
  song: SongRow;
  sections: SongSectionRow[];
  currentSectionId: string | null;
  instruction: string | null;
  selection: string | null;
  /** Recent accepted/rejected suggestions — the artist voice memory (spec §18–19). */
  feedback?: { accepted: number; chosen_text: string | null; edited_text: string | null; mode: string }[];
}

const MAX_SECTION_CHARS = 1400;
const MAX_PREVIOUS_SECTIONS = 6;

function truncate(value: string, max = MAX_SECTION_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/**
 * Builds the dynamic Song Context (spec §15) instead of blindly forwarding the
 * database. Everything the model sees about the song comes through here.
 */
export function buildSongContext(input: SongContextInput): SongContext {
  const { profile, song, sections, beatProfile } = input;
  const currentIndex = input.currentSectionId ? sections.findIndex((s) => s.id === input.currentSectionId) : -1;
  const current = currentIndex >= 0 ? sections[currentIndex] ?? null : null;

  const previous = (currentIndex >= 0 ? sections.slice(0, currentIndex) : sections)
    .slice(-MAX_PREVIOUS_SECTIONS)
    .map((section) => ({
      kind: section.kind,
      label: section.label,
      content: truncate(section.content),
    }));

  return {
    artist: {
      languages: parseJsonArray(profile?.languages_json),
      style: profile?.style ?? null,
      themes: parseJsonArray(profile?.themes_json),
      vocabulary: parseJsonArray(profile?.vocabulary_json).slice(0, 40),
      taboo: parseJsonArray(profile?.taboo_json).slice(0, 20),
      rhyme_preference: profile?.rhyme_preference ?? null,
      sentence_length: profile?.sentence_length ?? null,
    },
    beat:
      beatProfile && input.beat
        ? {
            id: input.beat.id,
            title: input.beat.title,
            bpm: beatProfile.bpm,
            key: beatProfile.key,
            time_signature: beatProfile.time_signature,
            duration_seconds: beatProfile.duration_seconds,
            energy_overall: beatProfile.energy.overall,
            energy_by_section: beatProfile.energy.by_section,
            sections: beatProfile.sections.map((s) => ({
              type: s.type,
              start: s.start,
              end: s.end,
              energy: s.energy,
            })),
            density: beatProfile.rhythm.density,
            syncopation: beatProfile.rhythm.syncopation,
            mood: beatProfile.mood,
          }
        : null,
    song: {
      id: song.id,
      title: song.title,
      concept: song.concept,
      intention: song.intention,
      language: song.language,
      perspective: song.perspective,
      energy: song.energy,
    },
    current_section: current
      ? { id: current.id, kind: current.kind, label: current.label, content: current.content }
      : null,
    previous_sections: previous,
    instruction: input.instruction,
    selection: input.selection,
  };
}

/** Compact text rendering of the context that goes into the prompt. */
export function renderContextForPrompt(ctx: SongContext): string {
  const lines: string[] = [];
  lines.push(`SONG: ${ctx.song.title}`);
  if (ctx.song.concept) lines.push(`Concept: ${ctx.song.concept}`);
  if (ctx.song.intention) lines.push(`Intention: ${ctx.song.intention}`);
  if (ctx.song.language) lines.push(`Language: ${ctx.song.language}`);
  if (ctx.song.perspective) lines.push(`Perspective: ${ctx.song.perspective}`);
  if (ctx.song.energy) lines.push(`Target energy: ${ctx.song.energy}`);

  if (ctx.beat) {
    lines.push(
      `BEAT: ${ctx.beat.bpm} BPM, ${ctx.beat.key}, ${ctx.beat.time_signature}, ${ctx.beat.duration_seconds}s, ` +
        `energy ${ctx.beat.energy_overall.toFixed(2)}, density ${ctx.beat.density.toFixed(2)}, syncopation ${ctx.beat.syncopation.toFixed(2)}`,
    );
    const sections = ctx.beat.sections
      .map((s) => `${s.type} ${s.start.toFixed(0)}-${s.end.toFixed(0)}s (${s.energy.toFixed(2)})`)
      .join(", ");
    if (sections) lines.push(`Beat structure: ${sections}`);
    if (ctx.beat.mood.length > 0) lines.push(`Beat mood: ${ctx.beat.mood.join(", ")}`);
  }

  const artist: string[] = [];
  if (ctx.artist.style) artist.push(`style: ${ctx.artist.style}`);
  if (ctx.artist.languages.length > 0) artist.push(`languages: ${ctx.artist.languages.join("/")}`);
  if (ctx.artist.themes.length > 0) artist.push(`themes: ${ctx.artist.themes.join(", ")}`);
  if (ctx.artist.vocabulary.length > 0) artist.push(`vocabulary: ${ctx.artist.vocabulary.slice(0, 15).join(", ")}`);
  if (ctx.artist.taboo.length > 0) artist.push(`never use: ${ctx.artist.taboo.join(", ")}`);
  if (ctx.artist.rhyme_preference) artist.push(`rhyme preference: ${ctx.artist.rhyme_preference}`);
  if (artist.length > 0) lines.push(`ARTIST: ${artist.join(" | ")}`);

  if (ctx.previous_sections.length > 0) {
    lines.push("EXISTING SECTIONS:");
    for (const section of ctx.previous_sections) {
      lines.push(`[${section.label ?? section.kind.toUpperCase()}]`);
      lines.push(section.content || "(empty)");
    }
  }

  if (ctx.current_section) {
    lines.push(`CURRENT SECTION: ${ctx.current_section.label ?? ctx.current_section.kind.toUpperCase()}`);
    lines.push(ctx.current_section.content || "(empty)");
  }

  if (ctx.selection) {
    lines.push("SELECTED TEXT:");
    lines.push(ctx.selection);
  }
  if (ctx.instruction) {
    lines.push(`ARTIST INSTRUCTION: ${ctx.instruction}`);
  }
  return lines.join("\n");
}
