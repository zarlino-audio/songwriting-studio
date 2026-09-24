import { describe, expect, it } from "vitest";
import { buildSongContext } from "../src/core/context";
import { buildUserPrompt, cacheKeyFor, isAiMode, parseSuggestion, tierForMode } from "../src/core/prompts";
import type { ArtistProfileRow, SongRow, SongSectionRow } from "../src/db/store";
import type { BeatProfile } from "../src/types";
import { buildStubProfile } from "../src/integrations/analysis";

const song: SongRow = {
  id: "song_1",
  user_id: "usr_1",
  beat_id: "beat_1",
  title: "Still Hungry",
  concept: "success without losing hunger",
  intention: "ambition",
  language: "English",
  perspective: "First person",
  energy: "Confident",
  status: "draft",
  current_version: 2,
  created_at: "2026-09-22T00:00:00.000Z",
  updated_at: "2026-09-22T00:00:00.000Z",
  completed_at: null,
};

const sections: SongSectionRow[] = [
  { id: "sec_1", song_id: "song_1", user_id: "usr_1", position: 0, kind: "verse", label: "Verse 1", content: "I came from the place where the lights stay low", bar_start: 0, bar_end: 8, updated_at: "x" },
  { id: "sec_2", song_id: "song_1", user_id: "usr_1", position: 1, kind: "chorus", label: "Chorus", content: "Still hungry", bar_start: 8, bar_end: 16, updated_at: "x" },
];

const profile: ArtistProfileRow = {
  user_id: "usr_1",
  languages_json: '["English","Ewe"]',
  style: "melodic Afro-fusion",
  perspective: "First person",
  themes_json: '["ambition"]',
  vocabulary_json: '["hunger","table"]',
  phrases_json: "[]",
  imagery_json: '["lights"]',
  taboo_json: '["blessed up"]',
  rhyme_preference: "Mostly near rhyme",
  sentence_length: "Short and punchy",
  structure_prefs_json: "[]",
  writing_samples_json: "[]",
  updated_at: "x",
};

const beatProfile: BeatProfile = buildStubProfile("beat_1", 180);

describe("song context builder (spec §15)", () => {
  it("selects only the current and previous sections", () => {
    const context = buildSongContext({
      profile,
      beat: { id: "beat_1", title: "Beat" },
      beatProfile,
      song,
      sections,
      currentSectionId: "sec_2",
      instruction: "make the hook bigger",
      selection: "Still hungry",
    });
    expect(context.current_section?.kind).toBe("chorus");
    expect(context.previous_sections).toHaveLength(1);
    expect(context.previous_sections[0]?.kind).toBe("verse");
    expect(context.artist.languages).toEqual(["English", "Ewe"]);
    expect(context.beat?.bpm).toBe(beatProfile.bpm);
  });

  it("truncates very long sections so the window stays bounded", () => {
    const long: SongSectionRow[] = [
      { ...(sections[0] as SongSectionRow), content: "a".repeat(5000) },
      { ...(sections[1] as SongSectionRow) },
    ];
    const context = buildSongContext({
      profile,
      beat: null,
      beatProfile: null,
      song,
      sections: long,
      currentSectionId: "sec_2",
      instruction: null,
      selection: null,
    });
    expect(context.previous_sections[0]?.content.length).toBeLessThan(1500);
    expect(context.previous_sections[0]?.content.endsWith("…")).toBe(true);
  });

  it("marks an empty current section and missing beat honestly", () => {
    const context = buildSongContext({
      profile: null,
      beat: null,
      beatProfile: null,
      song,
      sections,
      currentSectionId: null,
      instruction: null,
      selection: null,
    });
    expect(context.beat).toBeNull();
    expect(context.current_section).toBeNull();
    expect(context.artist.style).toBeNull();
  });
});

describe("prompts", () => {
  it("routes modes to the right model tier", () => {
    expect(tierForMode("rhyme")).toBe("fast");
    expect(tierForMode("hook")).toBe("creative");
    expect(tierForMode("critique")).toBe("reasoning");
  });

  it("validates modes", () => {
    expect(isAiMode("hook")).toBe(true);
    expect(isAiMode("write the whole song")).toBe(false);
  });

  it("includes the artist, beat and instruction evidence in the prompt", () => {
    const context = buildSongContext({
      profile,
      beat: { id: "beat_1", title: "Beat" },
      beatProfile,
      song,
      sections,
      currentSectionId: "sec_2",
      instruction: "tighter cadence",
      selection: "Still hungry",
    });
    const prompt = buildUserPrompt(context, "hook");
    expect(prompt).toContain("TASK MODE: hook");
    expect(prompt).toContain("melodic Afro-fusion");
    expect(prompt).toContain("tighter cadence");
    expect(prompt).toContain("SELECTED TEXT:");
    expect(prompt).toContain(String(beatProfile.bpm));
  });

  it("changes the cache key when the instruction changes", () => {
    const context = buildSongContext({
      profile,
      beat: null,
      beatProfile: null,
      song,
      sections,
      currentSectionId: "sec_1",
      instruction: "one",
      selection: null,
    });
    const other = buildSongContext({
      profile,
      beat: null,
      beatProfile: null,
      song,
      sections,
      currentSectionId: "sec_1",
      instruction: "two",
      selection: null,
    });
    expect(cacheKeyFor(context, "hook", "one", null)).not.toBe(cacheKeyFor(other, "hook", "two", null));
    expect(cacheKeyFor(context, "hook", "one", null)).toBe(cacheKeyFor(context, "hook", "one", null));
  });
});

describe("structured response parsing (spec §38)", () => {
  it("parses the JSON contract", () => {
    const suggestion = parseSuggestion(
      JSON.stringify({
        title: "Three directions",
        framing: "The beat lifts into the chorus.",
        options: [{ text: "I made it but…", why: "contrast" }, { text: "Still hungry" }],
        notes: ["keep it short"],
        cautions: ["avoid the generic line"],
      }),
      "hook",
    );
    expect(suggestion.options).toHaveLength(2);
    expect(suggestion.options[0]?.why).toBe("contrast");
    expect(suggestion.notes).toEqual(["keep it short"]);
  });

  it("recovers from prose wrapped JSON", () => {
    const suggestion = parseSuggestion(
      'Sure — here you go:\n```json\n{"title":"x","framing":"y","options":[{"text":"a line"}]}\n```',
      "hook",
    );
    expect(suggestion.options[0]?.text).toBe("a line");
  });

  it("falls back to numbered lists", () => {
    const suggestion = parseSuggestion("1. first option\n2. second option", "hook");
    expect(suggestion.options).toHaveLength(2);
    expect(suggestion.cautions[0]).toContain("not valid JSON");
  });

  it("reports unstructured answers instead of pretending", () => {
    const suggestion = parseSuggestion("I cannot help with that.", "hook");
    expect(suggestion.options).toHaveLength(0);
    expect(suggestion.raw).toContain("cannot help");
  });
});
