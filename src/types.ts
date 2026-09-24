/**
 * Domain types shared by the Worker, the analysis service contract and the
 * frontend (kept structurally identical to the Beat Profile in spec §7).
 */

export interface SilenceRegion {
  start: number;
  end: number;
}

export interface WaveformPeak {
  /** [min, max] in -1..1 per bucket */
  min: number;
  max: number;
}

export interface ChordEvent {
  chord: string;
  start: number;
  end: number;
  confidence: number;
}

export type SectionType =
  | "intro"
  | "verse"
  | "pre-chorus"
  | "chorus"
  | "bridge"
  | "break"
  | "outro"
  | "instrumental";

export interface BeatSection {
  type: SectionType;
  label?: string;
  start: number;
  end: number;
  energy: number;
  confidence: number;
  bars: [number, number];
}

export interface BeatProfile {
  version: 1;
  engine: string;
  engine_version: string;
  created_at: string;

  bpm: number;
  bpm_confidence: number;
  key: string;
  key_confidence: number;
  scale: string;
  time_signature: string;
  duration_seconds: number;

  energy: {
    overall: number;
    /** per-bar energy, 0..1 */
    curve: number[];
    by_section: Record<string, number>;
  };

  mood: string[];

  rhythm: {
    density: number;
    syncopation: number;
    swing: number;
    groove: string;
    transient_density: number;
    complexity: number;
    /** seconds of each detected beat */
    beat_grid: number[];
    /** seconds of each detected downbeat */
    downbeats: number[];
    beats_per_bar: number;
    bar_count: number;
  };

  harmony: {
    chords: ChordEvent[];
    progression: string[];
    harmonic_tension: number[];
  };

  sections: BeatSection[];

  technical: {
    sample_rate: number;
    channels: number;
    lufs: number;
    peak_db: number;
    dynamic_range_db: number;
    waveform: WaveformPeak[];
    silence_regions: SilenceRegion[];
  };

  /** Analysis warnings (e.g. low tempo confidence) — signals, not truths. */
  warnings: string[];
}

export interface BeatIntelligence {
  headline: string;
  summary: string;
  characteristics: string[];
  evidence: string[];
}

export type SongSectionKind =
  | "intro"
  | "verse"
  | "pre-chorus"
  | "chorus"
  | "post-chorus"
  | "bridge"
  | "rap"
  | "break"
  | "outro"
  | "custom";

export interface SongSectionPayload {
  id?: string;
  position: number;
  kind: SongSectionKind | string;
  label?: string | null;
  content: string;
  barStart?: number | null;
  barEnd?: number | null;
}

export type AiMode =
  | "concept"
  | "hook"
  | "rhyme"
  | "cadence"
  | "metaphor"
  | "story"
  | "contrast"
  | "melody"
  | "rewrite"
  | "simplify"
  | "intensify"
  | "personalize"
  | "critique";

export type AiTier = "fast" | "creative" | "reasoning";

export interface AiOption {
  id: string;
  text: string;
  why?: string;
}

export interface AiSuggestionResponse {
  mode: AiMode;
  title: string;
  /** Short framing of the direction(s) the model proposes (spec §38). */
  framing: string;
  options: AiOption[];
  notes: string[];
  cautions: string[];
  /** Set when the model's answer could not be parsed as structured output. */
  raw?: string;
}

export interface SongContext {
  artist: {
    languages: string[];
    style: string | null;
    themes: string[];
    vocabulary: string[];
    taboo: string[];
    rhyme_preference: string | null;
    sentence_length: string | null;
  };
  beat: {
    id: string;
    title: string;
    bpm: number;
    key: string;
    time_signature: string;
    duration_seconds: number;
    energy_overall: number;
    energy_by_section: Record<string, number>;
    sections: { type: string; start: number; end: number; energy: number }[];
    density: number;
    syncopation: number;
    mood: string[];
  } | null;
  song: {
    id: string;
    title: string;
    concept: string | null;
    intention: string | null;
    language: string | null;
    perspective: string | null;
    energy: string | null;
  };
  current_section: { id: string; kind: string; label: string | null; content: string } | null;
  previous_sections: { kind: string; label: string | null; content: string }[];
  instruction: string | null;
  selection: string | null;
}

export interface ApiError {
  error: string;
  detail?: string;
}
