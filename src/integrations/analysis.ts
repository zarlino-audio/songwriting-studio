import { analysisDispatch, analysisMode, type Env } from "../env";
import type { BeatProfile } from "../types";
import { deriveMood } from "../core/beatIntel";
import { clamp, round } from "../util/ids";

/**
 * Client for the audio-analysis runtime (spec §6).
 *
 * Three modes:
 *   http      - a persistent service (local machine / VM / RDP box) reached over HTTPS
 *   container - the same service running as a Cloudflare Container on this account
 *   stub      - deterministic placeholder profile so the product works before the
 *               runtime exists (clearly labelled as a stub in `warnings`)
 *
 * The service receives an audio URL (short-lived, signed) rather than the audio
 * being pushed through the application layer repeatedly.
 */

export interface AnalysisRequest {
  beatId: string;
  audioUrl: string | null;
  /** Used only when no signed URL is available (worker proxies the bytes). */
  audioBytes?: ArrayBuffer;
  mimeType?: string;
}

export interface AnalysisResult {
  profile: BeatProfile;
  engine: string;
  engineVersion: string;
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seeded(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/** Deterministic placeholder used by ANALYSIS_MODE=stub. */
export function buildStubProfile(beatId: string, durationSeconds = 192): BeatProfile {
  const random = seeded(hashSeed(beatId));
  const bpm = Math.round(88 + random() * 52);
  const minor = random() > 0.45;
  const keyNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const tonic = keyNames[Math.floor(random() * keyNames.length)] ?? "F#";
  const barSeconds = (60 / bpm) * 4;
  const barCount = Math.max(16, Math.floor(durationSeconds / barSeconds));
  const curve: number[] = [];
  for (let bar = 0; bar < barCount; bar++) {
    const phase = bar / barCount;
    const arch = 0.35 + 0.45 * Math.sin(Math.PI * phase) + (random() - 0.5) * 0.08;
    curve.push(round(clamp(arch, 0, 1), 3));
  }
  const beatGrid: number[] = [];
  for (let i = 0; i * (60 / bpm) < durationSeconds; i++) beatGrid.push(round(i * (60 / bpm), 3));

  const rawSections: BeatProfile["sections"] = [
    { type: "intro", start: 0, end: round(barSeconds * 8, 2), energy: curve[4] ?? 0.3, confidence: 0.4, bars: [0, 8] },
    { type: "verse", start: round(barSeconds * 8, 2), end: round(barSeconds * 24, 2), energy: 0.5, confidence: 0.4, bars: [8, 24] },
    { type: "chorus", start: round(barSeconds * 24, 2), end: round(barSeconds * 40, 2), energy: 0.85, confidence: 0.4, bars: [24, 40] },
    { type: "outro", start: round(barSeconds * 40, 2), end: round(durationSeconds, 2), energy: 0.35, confidence: 0.4, bars: [40, barCount] },
  ];
  const sections = rawSections.filter((section) => section.start < durationSeconds);

  const profile: BeatProfile = {
    version: 1,
    engine: "stub",
    engine_version: "0",
    created_at: new Date().toISOString(),
    bpm,
    bpm_confidence: 0.5,
    key: `${tonic} ${minor ? "minor" : "major"}`,
    key_confidence: 0.4,
    scale: minor ? "natural minor" : "major",
    time_signature: "4/4",
    duration_seconds: durationSeconds,
    energy: {
      overall: round(curve.reduce((a, b) => a + b, 0) / Math.max(curve.length, 1), 3),
      curve,
      by_section: { intro: 0.32, verse: 0.52, chorus: 0.86 },
    },
    mood: [],
    rhythm: {
      density: round(0.4 + random() * 0.45, 3),
      syncopation: round(random() * 0.7, 3),
      swing: round(random() * 0.2, 3),
      groove: "straight",
      transient_density: round(2 + random() * 4, 2),
      complexity: round(random(), 3),
      beat_grid: beatGrid,
      downbeats: beatGrid.filter((_, index) => index % 4 === 0),
      beats_per_bar: 4,
      bar_count: barCount,
    },
    harmony: { chords: [], progression: [], harmonic_tension: [] },
    sections,
    technical: {
      sample_rate: 44100,
      channels: 2,
      lufs: round(-14 + random() * 6, 2),
      peak_db: round(-1 + random(), 2),
      dynamic_range_db: round(4 + random() * 6, 2),
      waveform: Array.from({ length: 400 }, (_, index) => {
        const value = clamp(Math.abs(Math.sin(index / 17)) * 0.8 + random() * 0.2, 0, 1);
        return { min: -round(value, 3), max: round(value * 0.95, 3) };
      }),
      silence_regions: [],
    },
    warnings: [
      "Stub analysis: no real DSP ran. Point ANALYSIS_URL at the analysis service (or deploy the Container) to replace this profile.",
    ],
  };
  profile.mood = deriveMood(profile);
  return profile;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/**
 * Defensive normalisation: an analysis service running an older/newer engine
 * must never be able to break the app. Missing pieces are filled with honest
 * defaults and recorded in `warnings`.
 */
export function normalizeProfile(raw: unknown, fallbackDuration = 0): { profile: BeatProfile; warnings: string[] } {
  const warnings: string[] = [];
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const sectors = (input["sections"] as unknown[]) ?? [];
  const sections: BeatProfile["sections"] = Array.isArray(sectors)
    ? sectors
        .map((entry) => {
          const record = (entry ?? {}) as Record<string, unknown>;
          const bars = Array.isArray(record["bars"]) ? record["bars"] : [];
          return {
            type: (typeof record["type"] === "string" ? record["type"] : "instrumental") as BeatProfile["sections"][number]["type"],
            label: typeof record["label"] === "string" ? record["label"] : undefined,
            start: asNumber(record["start"], 0),
            end: asNumber(record["end"], 0),
            energy: clamp(asNumber(record["energy"], 0.5), 0, 1),
            confidence: clamp(asNumber(record["confidence"], 0.5), 0, 1),
            bars: [asNumber(bars[0], 0), asNumber(bars[1], 0)] as [number, number],
          };
        })
        .filter((section) => section.end > section.start)
    : [];
  if (sections.length === 0) warnings.push("No sections were detected in the profile.");

  const rhythm = (input["rhythm"] as Record<string, unknown>) ?? {};
  const energy = (input["energy"] as Record<string, unknown>) ?? {};
  const technical = (input["technical"] as Record<string, unknown>) ?? {};
  const harmony = (input["harmony"] as Record<string, unknown>) ?? {};

  const waveformRaw = Array.isArray(technical["waveform"]) ? (technical["waveform"] as unknown[]) : [];
  const waveform = waveformRaw
    .map((entry) => {
      if (Array.isArray(entry) && entry.length >= 2) {
        return { min: asNumber(entry[0], 0), max: asNumber(entry[1], 0) };
      }
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        return { min: asNumber(record["min"], 0), max: asNumber(record["max"], 0) };
      }
      return null;
    })
    .filter((entry): entry is { min: number; max: number } => entry !== null);

  const chordsRaw = Array.isArray(harmony["chords"]) ? (harmony["chords"] as unknown[]) : [];
  const chords = chordsRaw
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const chord = typeof record["chord"] === "string" ? record["chord"] : "";
      if (!chord) return null;
      return {
        chord,
        start: asNumber(record["start"], 0),
        end: asNumber(record["end"], 0),
        confidence: clamp(asNumber(record["confidence"], 0.5), 0, 1),
      };
    })
    .filter((entry): entry is BeatProfile["harmony"]["chords"][number] => entry !== null);

  const duration = asNumber(input["duration_seconds"], fallbackDuration);
  const profile: BeatProfile = {
    version: 1,
    engine: typeof input["engine"] === "string" ? input["engine"] : "unknown",
    engine_version: typeof input["engine_version"] === "string" ? input["engine_version"] : "",
    created_at: new Date().toISOString(),
    bpm: clamp(asNumber(input["bpm"], 0), 0, 400),
    bpm_confidence: clamp(asNumber(input["bpm_confidence"], 0.5), 0, 1),
    key: typeof input["key"] === "string" && input["key"] ? input["key"] : "unknown",
    key_confidence: clamp(asNumber(input["key_confidence"], 0.4), 0, 1),
    scale: typeof input["scale"] === "string" ? input["scale"] : "",
    time_signature: typeof input["time_signature"] === "string" ? input["time_signature"] : "4/4",
    duration_seconds: duration,
    energy: {
      overall: clamp(asNumber(energy["overall"], 0.5), 0, 1),
      curve: asNumberArray(energy["curve"]).map((v) => clamp(v, 0, 1)),
      by_section:
        energy["by_section"] && typeof energy["by_section"] === "object"
          ? Object.fromEntries(
              Object.entries(energy["by_section"] as Record<string, unknown>).map(([k, v]) => [k, clamp(asNumber(v, 0), 0, 1)]),
            )
          : {},
    },
    mood: Array.isArray(input["mood"]) ? (input["mood"] as unknown[]).filter((m): m is string => typeof m === "string") : [],
    rhythm: {
      density: clamp(asNumber(rhythm["density"], 0.5), 0, 1),
      syncopation: clamp(asNumber(rhythm["syncopation"], 0), 0, 1),
      swing: clamp(asNumber(rhythm["swing"], 0), 0, 1),
      groove: typeof rhythm["groove"] === "string" ? rhythm["groove"] : "straight",
      transient_density: asNumber(rhythm["transient_density"], 0),
      complexity: clamp(asNumber(rhythm["complexity"], 0.5), 0, 1),
      beat_grid: asNumberArray(rhythm["beat_grid"]),
      downbeats: asNumberArray(rhythm["downbeats"]),
      beats_per_bar: Math.max(1, Math.round(asNumber(rhythm["beats_per_bar"], 4))),
      bar_count: Math.max(0, Math.round(asNumber(rhythm["bar_count"], 0))),
    },
    harmony: {
      chords,
      progression: Array.isArray(harmony["progression"])
        ? (harmony["progression"] as unknown[]).filter((c): c is string => typeof c === "string")
        : [],
      harmonic_tension: asNumberArray(harmony["harmonic_tension"]),
    },
    sections,
    technical: {
      sample_rate: Math.round(asNumber(technical["sample_rate"], 0)),
      channels: Math.round(asNumber(technical["channels"], 0)),
      lufs: asNumber(technical["lufs"], -14),
      peak_db: asNumber(technical["peak_db"], 0),
      dynamic_range_db: asNumber(technical["dynamic_range_db"], 0),
      waveform,
      silence_regions: Array.isArray(technical["silence_regions"])
        ? (technical["silence_regions"] as unknown[])
            .map((entry) => {
              const record = (entry ?? {}) as Record<string, unknown>;
              return { start: asNumber(record["start"], 0), end: asNumber(record["end"], 0) };
            })
            .filter((region) => region.end > region.start)
        : [],
    },
    warnings: Array.isArray(input["warnings"]) ? (input["warnings"] as unknown[]).filter((w): w is string => typeof w === "string") : [],
  };

  if (profile.bpm <= 0) warnings.push("Tempo could not be estimated.");
  if (profile.key === "unknown") warnings.push("Key could not be estimated.");
  if (profile.mood.length === 0) profile.mood = deriveMood(profile);
  profile.warnings = [...new Set([...profile.warnings, ...warnings])];
  return { profile, warnings: profile.warnings };
}

export class AnalysisUnavailableError extends Error {}

export async function requestAnalysis(env: Env, request: AnalysisRequest): Promise<AnalysisResult> {
  const mode = analysisMode(env);

  if (mode === "stub") {
    const { profile } = normalizeProfile(buildStubProfile(request.beatId));
    return { profile, engine: "stub", engineVersion: "0" };
  }

  const payload = JSON.stringify({
    beat_id: request.beatId,
    audio_url: request.audioUrl,
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.ANALYSIS_SHARED_SECRET) headers["x-analysis-key"] = env.ANALYSIS_SHARED_SECRET;

  let response: Response;
  if (mode === "container") {
    if (!env.ANALYSIS) {
      throw new AnalysisUnavailableError(
        "ANALYSIS_MODE=container but no ANALYSIS binding — deploy with wrangler.containers.toml",
      );
    }
    const stub = env.ANALYSIS.get(env.ANALYSIS.idFromName("analysis"));
    response = await stub.fetch("http://analysis/analyze", { method: "POST", headers, body: payload });
  } else {
    const base = (env.ANALYSIS_URL || "").replace(/\/$/, "");
    if (!base) throw new AnalysisUnavailableError("ANALYSIS_URL is not configured");
    response = await fetch(`${base}/analyze`, { method: "POST", headers, body: payload });
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new AnalysisUnavailableError(`Analysis service error ${response.status}: ${detail.slice(0, 300)}`);
  }

  const body = (await response.json()) as Record<string, unknown>;
  const rawProfile = body["profile"] ?? body;
  const { profile } = normalizeProfile(rawProfile);
  return {
    profile,
    engine: profile.engine,
    engineVersion: profile.engine_version,
  };
}

export interface AnalysisHealth {
  mode: string;
  ok: boolean;
  detail: string;
}

export async function analysisHealth(env: Env): Promise<AnalysisHealth> {
  const mode = analysisMode(env);
  if (analysisDispatch(env) === "poll") {
    return { mode: "poll-worker", ok: true, detail: "jobs are claimed by the polling analysis worker" };
  }
  if (mode === "stub") return { mode, ok: true, detail: "stub profile generator (no real DSP)" };
  if (mode === "container") {
    if (!env.ANALYSIS) return { mode, ok: false, detail: "container binding missing" };
    try {
      const stub = env.ANALYSIS.get(env.ANALYSIS.idFromName("analysis"));
      const res = await stub.fetch("http://analysis/health");
      return { mode, ok: res.ok, detail: res.ok ? "container responding" : `container HTTP ${res.status}` };
    } catch (error) {
      return { mode, ok: false, detail: `container unreachable: ${(error as Error).message}` };
    }
  }
  try {
    const base = (env.ANALYSIS_URL || "").replace(/\/$/, "");
    if (!base) return { mode, ok: false, detail: "ANALYSIS_URL not set" };
    const res = await fetch(`${base}/health`);
    return { mode, ok: res.ok, detail: res.ok ? "service responding" : `HTTP ${res.status}` };
  } catch (error) {
    return { mode, ok: false, detail: `unreachable: ${(error as Error).message}` };
  }
}
