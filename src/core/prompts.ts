import type { AiMode, AiSuggestionResponse, AiTier, SongContext } from "../types";
import { renderContextForPrompt } from "./context";

/** The shared stance prompt: collaborator, never autonomous songwriter. */
export const SYSTEM_PROMPT = `You are a songwriting collaborator inside the artist's own workspace.

Rules you never break:
- The artist is the final decision-maker. Never rewrite their writing unless they explicitly asked.
- Offer options and directions; do not produce a finished song and present it as done.
- Ground every suggestion in the beat evidence and the artist's existing lines you were given.
- Prefer specificity, voice, emotion, memorability and performability over "poetic" language.
- Actively avoid: clichés, generic motivational language, filler lines, overused imagery, forced slang,
  excessive perfect rhymes, and lines that could not be performed aloud.
- Write in the artist's stated language(s) and stay in their perspective. If they mix languages, mix them
  the way they do — never mock or stereotype.
- Be honest about weaknesses. If asked to critique, critique the work, never the artist.

Output format — reply with a single JSON object and nothing else:
{
  "title": "short label for this suggestion set",
  "framing": "1-3 sentences describing the direction(s) you see, and why they fit THIS beat and THIS song",
  "options": [ { "text": "the suggested lyric or line", "why": "short musical/writing reason" } ],
  "notes": ["optional craft notes"],
  "cautions": ["optional honest warnings about what will not work"]
}
Return between 3 and 5 options. Options must be alternatives to each other, not a sequence of a finished song.`;

const MODE_GUIDANCE: Record<AiMode, { instruction: string; optionCount: string; tier: AiTier }> = {
  concept: {
    instruction:
      "Propose distinct concepts/directions the artist could take. Each option is a concept stated in one or two lines, not lyrics.",
    optionCount: "3-4",
    tier: "creative",
  },
  hook: {
    instruction:
      "Propose hook directions. Each option is a hook line (or two) that could carry the section, chosen for repetition and syllable shape against the beat.",
    optionCount: "4-5",
    tier: "creative",
  },
  rhyme: {
    instruction:
      "Work on rhyme. Offer options that improve the rhyme scheme — including near rhymes and internal rhyme — while keeping the meaning.",
    optionCount: "4-5",
    tier: "fast",
  },
  cadence: {
    instruction:
      "Work on cadence. Rewrite the selected/extracted line with different rhythmic density, and state the syllable count change in 'why'.",
    optionCount: "4",
    tier: "fast",
  },
  metaphor: {
    instruction: "Offer metaphors for the idea in play. Concrete, specific, not decorative.",
    optionCount: "4",
    tier: "creative",
  },
  story: {
    instruction:
      "Suggest where the story should go next given the sections that already exist. Options are narrative moves, not full verses.",
    optionCount: "3",
    tier: "reasoning",
  },
  contrast: {
    instruction: "Propose a contrasting move for this section relative to the rest of the song (energy, perspective, tense, image world).",
    optionCount: "3",
    tier: "creative",
  },
  melody: {
    instruction:
      "Suggest melodic direction only: contour, stress placement, syllable density, repetition and call-and-response structure. Never claim to produce a finished performance.",
    optionCount: "3-4",
    tier: "creative",
  },
  rewrite: {
    instruction:
      "Rewrite keeping the meaning. Give alternatives; the artist's original must survive untouched.",
    optionCount: "4-5",
    tier: "fast",
  },
  simplify: {
    instruction: "Make the writing more natural and speakable — fewer words, clearer images, no filler.",
    optionCount: "4",
    tier: "fast",
  },
  intensify: {
    instruction: "Make the writing hit harder. Stronger verbs and images; no volume-by-vagueness.",
    optionCount: "4",
    tier: "creative",
  },
  personalize: {
    instruction:
      "Move the writing toward the artist's own voice using their stated vocabulary, themes and past accepted lines.",
    optionCount: "4",
    tier: "creative",
  },
  critique: {
    instruction:
      "Critique honestly (Challenge Me): name one concrete strength, then the specific weaknesses with evidence from the lines (predictable rhyme, weak payoff, monotone cadence, cliché, mismatch with beat energy). Each option is a concrete fix.",
    optionCount: "3-5",
    tier: "reasoning",
  },
};

export function modeGuidance(mode: AiMode): { instruction: string; optionCount: string; tier: AiTier } {
  return MODE_GUIDANCE[mode] ?? MODE_GUIDANCE.rewrite;
}

export function tierForMode(mode: AiMode): AiTier {
  return modeGuidance(mode).tier;
}

export function isAiMode(value: unknown): value is AiMode {
  return typeof value === "string" && value in MODE_GUIDANCE;
}

export function buildUserPrompt(ctx: SongContext, mode: AiMode): string {
  const guidance = modeGuidance(mode);
  return [
    `TASK MODE: ${mode}`,
    guidance.instruction,
    `Return ${guidance.optionCount} options in the JSON format described.`,
    "",
    "CONTEXT",
    "-------",
    renderContextForPrompt(ctx),
    "-------",
    "Every option must be usable as-is in the artist's section. Do not explain the JSON.",
  ].join("\n");
}

/** Cache key: identical context + mode + instruction => reuse (spec §36). */
export function cacheKeyFor(ctx: SongContext, mode: AiMode, instruction: string | null, selection: string | null): string {
  return JSON.stringify({
    mode,
    song: ctx.song,
    current: ctx.current_section,
    previous: ctx.previous_sections,
    beat: ctx.beat
      ? {
          bpm: ctx.beat.bpm,
          key: ctx.beat.key,
          energy: ctx.beat.energy_overall,
          sections: ctx.beat.sections,
        }
      : null,
    artist: {
      style: ctx.artist.style,
      languages: ctx.artist.languages,
      themes: ctx.artist.themes,
    },
    instruction,
    selection,
  });
}

function coerceString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Tolerant parse: models sometimes wrap JSON in prose or code fences. */
export function parseSuggestion(raw: string, mode: AiMode): AiSuggestionResponse {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      const optionsRaw = Array.isArray(parsed["options"]) ? (parsed["options"] as unknown[]) : [];
      const options = optionsRaw
        .map((entry, index) => {
          if (typeof entry === "string") return { id: `o${index + 1}`, text: entry };
          if (entry && typeof entry === "object") {
            const record = entry as Record<string, unknown>;
            const optionText = coerceString(record["text"] ?? record["line"] ?? record["option"]);
            if (!optionText) return null;
            return {
              id: `o${index + 1}`,
              text: optionText,
              why: coerceString(record["why"] ?? record["reason"]) || undefined,
            };
          }
          return null;
        })
        .filter((option): option is { id: string; text: string; why?: string } => option !== null);

      if (options.length > 0) {
        return {
          mode,
          title: coerceString(parsed["title"]) || `${mode} suggestions`,
          framing: coerceString(parsed["framing"] ?? parsed["summary"]),
          options,
          notes: Array.isArray(parsed["notes"]) ? (parsed["notes"] as unknown[]).map(coerceString).filter(Boolean) : [],
          cautions: Array.isArray(parsed["cautions"])
            ? (parsed["cautions"] as unknown[]).map(coerceString).filter(Boolean)
            : [],
        };
      }
    } catch {
      // fall through to the numbered-list parser
    }
  }

  // Fallback: "1. line" style lists.
  const numbered = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(\d+[.)]|[-*])\s+/.test(line))
    .map((line, index) => ({ id: `o${index + 1}`, text: line.replace(/^(\d+[.)]|[-*])\s+/, "") }));

  if (numbered.length > 0) {
    return {
      mode,
      title: `${mode} suggestions`,
      framing: "",
      options: numbered.slice(0, 6),
      notes: [],
      cautions: ["Response was not valid JSON — parsed as a plain list."],
    };
  }

  return {
    mode,
    title: `${mode} suggestions`,
    framing: "",
    options: [],
    notes: [],
    cautions: ["The model did not return structured options."],
    raw: text.slice(0, 4000),
  };
}
