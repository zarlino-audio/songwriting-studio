import type { AiSuggestionResponse, BeatIntelligence, BeatProfile, SongSectionPayload } from "@shared/types";

const TOKEN_KEY = "sws_token";
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body && typeof init.body === "string") {
    headers.set("content-type", "application/json");
  }
  if (token) headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const record = (payload ?? {}) as { error?: string; detail?: string };
    throw new ApiError(response.status, record.error ?? `Request failed (${response.status})`, record.detail);
  }
  return payload as T;
}

/** Upload with progress (fetch has no upload progress events). */
function uploadWithProgress(
  url: string,
  file: File | Blob,
  options: { headers?: Record<string, string>; onProgress?: (ratio: number) => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url.startsWith("http") ? url : `${API_BASE}${url}`);
    for (const [key, value] of Object.entries(options.headers ?? {})) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && options.onProgress) options.onProgress(event.loaded / event.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, `Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new ApiError(0, "Upload failed — network error"));
    xhr.send(file);
  });
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface BeatSummary {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  durationSeconds: number | null;
  originalFilename: string | null;
  error: string | null;
}

export interface SongSummary {
  id: string;
  beatId: string | null;
  title: string;
  concept: string | null;
  intention: string | null;
  language: string | null;
  perspective: string | null;
  energy: string | null;
  status: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  beatTitle?: string | null;
}

export interface BeatDetail {
  beat: BeatSummary & { mimeType: string | null; sizeBytes: number | null; r2Key: string };
  profile: BeatProfile | null;
  intelligence: BeatIntelligence | null;
  analysisSource: string | null;
  analysisEngine: string | null;
  job: { id: string; status: string; error: string | null; updatedAt: string; attempts: number } | null;
}

export interface SongDetail {
  song: SongSummary;
  sections: SongSectionPayload[];
  health: SongHealth;
  beat: { id: string; title: string; status: string; durationSeconds: number | null } | null;
  profile: BeatProfile | null;
  versions: { id: string; versionNo: number; name: string | null; createdAt: string }[];
}

export interface SongHealth {
  checks: { key: string; label: string; status: "ok" | "watch" | "weak"; note: string }[];
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

export interface AiSuggestionResponseEnvelope {
  requestId: string;
  suggestion: AiSuggestionResponse;
  meta: {
    tier: string;
    provider: string;
    model: string;
    cached: boolean;
    latencyMs: number;
    costUsd: number;
    gatewayLogId: string | null;
  };
}

export interface ArtistProfile {
  languages: string[];
  style: string | null;
  perspective: string | null;
  themes: string[];
  vocabulary: string[];
  phrases: string[];
  imagery: string[];
  taboo: string[];
  rhymePreference: string | null;
  sentenceLength: string | null;
  structurePrefs: string[];
  writingSamples: string[];
  updatedAt: string | null;
}

export interface HealthReport {
  ok: boolean;
  environment: string;
  checks: Record<string, boolean>;
  tables: number;
  analysis: { mode: string; detail: string };
  ai: { provider: string; gatewayEnabled: boolean; models: Record<string, string> };
  hints: string[];
}

export const api = {
  // --- auth ---------------------------------------------------------------
  authStatus: () => request<{ authenticated: boolean; user: AuthUser | null }>("/api/auth/status"),
  register: (email: string, password: string, displayName?: string) =>
    request<{ token: string; user: AuthUser }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, displayName }),
    }),
  login: (email: string, password: string) =>
    request<{ token: string; user: AuthUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  // --- beats --------------------------------------------------------------
  listBeats: () => request<{ beats: BeatSummary[] }>("/api/beats"),
  getBeat: (beatId: string) => request<BeatDetail>(`/api/beats/${beatId}`),
  reanalyzeBeat: (beatId: string) => request<{ ok: boolean; jobId: string }>(`/api/beats/${beatId}/reanalyze`, { method: "POST" }),
  correctBeatProfile: (beatId: string, patch: Record<string, unknown>) =>
    request<{ profile: BeatProfile; intelligence: BeatIntelligence }>(`/api/beats/${beatId}/profile`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteBeat: (beatId: string) => request<null>(`/api/beats/${beatId}`, { method: "DELETE" }),
  beatAudioUrl: (beatId: string) => request<{ mode: string; url: string }>(`/api/beats/${beatId}/audio-url`),

  async uploadBeat(
    file: File,
    title: string | undefined,
    onProgress?: (ratio: number) => void,
  ): Promise<string> {
    const session = await request<{
      beatId: string;
      upload: { mode: "direct" | "proxy"; method: string; url: string };
    }>("/api/beats/upload", {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        title,
      }),
    });

    const headers: Record<string, string> = {};
    if (session.upload.mode === "proxy") {
      headers["content-type"] = file.type || "application/octet-stream";
      const token = getToken();
      if (token) headers["authorization"] = `Bearer ${token}`;
    }
    await uploadWithProgress(session.upload.url, file, { headers, onProgress });
    await request<{ ok: boolean; jobId: string }>(`/api/beats/${session.beatId}/complete`, { method: "POST" });
    return session.beatId;
  },

  /** Playable URL for <audio>/wavesurfer: signed R2 URL, or the auth-token proxy. */
  async beatPlaybackUrl(beatId: string): Promise<string> {
    const { mode, url } = await api.beatAudioUrl(beatId);
    if (mode === "direct") return url;
    const token = getToken();
    return `${API_BASE}${url}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  },

  // --- songs --------------------------------------------------------------
  listSongs: () => request<{ songs: SongSummary[] }>("/api/songs"),
  createSong: (input: {
    beatId?: string;
    title?: string;
    concept?: string;
    intention?: string;
    language?: string;
    perspective?: string;
    energy?: string;
  }) => request<{ song: SongSummary; sections: SongSectionPayload[] }>("/api/songs", { method: "POST", body: JSON.stringify(input) }),
  getSong: (songId: string) => request<SongDetail>(`/api/songs/${songId}`),
  patchSong: (songId: string, patch: Record<string, unknown>) =>
    request<{ song: SongSummary }>(`/api/songs/${songId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  saveSong: (
    songId: string,
    payload: { sections: SongSectionPayload[]; song?: Record<string, unknown>; versionName?: string; createVersion?: boolean },
  ) => request<{ savedAt: string; versionNo: number; createdVersion: boolean }>(`/api/songs/${songId}/save`, { method: "POST", body: JSON.stringify(payload) }),
  listVersions: (songId: string) =>
    request<{ versions: { id: string; versionNo: number; name: string | null; createdAt: string; preview: string }[] }>(
      `/api/songs/${songId}/versions`,
    ),
  snapshotVersion: (songId: string, name: string) =>
    request<{ versionNo: number }>(`/api/songs/${songId}/versions`, { method: "POST", body: JSON.stringify({ name }) }),
  restoreVersion: (songId: string, versionId: string) =>
    request<{ restoredFrom: number; versionNo: number; sections: SongSectionPayload[] }>(
      `/api/songs/${songId}/versions/${versionId}/restore`,
      { method: "POST" },
    ),
  songHealth: (songId: string) => request<{ health: SongHealth }>(`/api/songs/${songId}/health`),
  deleteSong: (songId: string) => request<null>(`/api/songs/${songId}`, { method: "DELETE" }),
  exportSong: (songId: string, format: "txt" | "json") => {
    const token = getToken();
    return `${API_BASE}/api/songs/${songId}/export?format=${format}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  },

  // --- ai -----------------------------------------------------------------
  aiStatus: () => request<{ status: { provider: string; gatewayEnabled: boolean; models: Record<string, string>; keyPresent: boolean } }>("/api/ai/status"),
  suggest: (input: {
    songId: string;
    sectionId?: string | null;
    mode: string;
    instruction?: string;
    selection?: string;
    refresh?: boolean;
  }) => request<AiSuggestionResponseEnvelope>("/api/ai/suggest", { method: "POST", body: JSON.stringify(input) }),
  aiFeedback: (input: { requestId: string; optionIndex?: number; accepted: boolean; chosenText?: string; editedText?: string }) =>
    request<{ ok: boolean }>("/api/ai/feedback", { method: "POST", body: JSON.stringify(input) }),

  // --- ideas --------------------------------------------------------------
  listIdeas: () =>
    request<{ ideas: { id: string; kind: string; text: string; tags: string[]; createdAt: string; songId: string | null }[] }>(
      "/api/ideas",
    ),
  createIdea: (input: { kind: string; text: string; songId?: string; tags?: string[] }) =>
    request<{ id: string }>("/api/ideas", { method: "POST", body: JSON.stringify(input) }),
  deleteIdea: (ideaId: string) => request<null>(`/api/ideas/${ideaId}`, { method: "DELETE" }),

  // --- profile + system ---------------------------------------------------
  getProfile: () => request<{ profile: ArtistProfile }>("/api/profile"),
  saveProfile: (patch: Partial<ArtistProfile>) => request<{ profile: ArtistProfile }>("/api/profile", { method: "PUT", body: JSON.stringify(patch) }),
  health: () => request<HealthReport>("/api/health"),
  observability: () =>
    request<{
      window: string;
      songsStarted: number;
      songsCompleted: number;
      beatsUploaded: number;
      suggestionsGenerated: number;
      suggestionsAccepted: number;
      aiSpendUsd: number;
    }>("/api/observability/overview"),
};
