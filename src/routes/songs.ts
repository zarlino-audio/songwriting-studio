import { Store, type LyricVersionRow, type SongRow, type SongSectionRow } from "../db/store";
import { HttpError, json, noContent, optionalString, readJson, requireString, type RouteContext, type Router } from "../http";
import { id, nowIso } from "../util/ids";
import { analyseSongHealth } from "../core/songHealth";
import type { BeatProfile, SongSectionKind, SongSectionPayload } from "../types";
import { requireUserId } from "./auth";

const MAX_TITLE = 200;
const MAX_CONCEPT = 2000;
const MAX_SECTION_CONTENT = 20_000;
const VERSION_THROTTLE_MS = 120_000;

const DEFAULT_STRUCTURE: { kind: SongSectionKind; label: string }[] = [
  { kind: "intro", label: "Intro" },
  { kind: "verse", label: "Verse 1" },
  { kind: "pre-chorus", label: "Pre-Chorus" },
  { kind: "chorus", label: "Chorus" },
  { kind: "verse", label: "Verse 2" },
  { kind: "chorus", label: "Chorus" },
  { kind: "bridge", label: "Bridge" },
  { kind: "outro", label: "Outro" },
];

function mapSong(song: SongRow): Record<string, unknown> {
  return {
    id: song.id,
    beatId: song.beat_id,
    title: song.title,
    concept: song.concept,
    intention: song.intention,
    language: song.language,
    perspective: song.perspective,
    energy: song.energy,
    status: song.status,
    currentVersion: song.current_version,
    createdAt: song.created_at,
    updatedAt: song.updated_at,
    completedAt: song.completed_at,
  };
}

function mapSection(section: SongSectionRow): SongSectionPayload {
  return {
    id: section.id,
    position: section.position,
    kind: section.kind,
    label: section.label,
    content: section.content,
    barStart: section.bar_start,
    barEnd: section.bar_end,
  };
}

function sectionsFromStructure(
  structure: { kind: SongSectionKind; label?: string; barStart?: number | null; barEnd?: number | null }[],
  songId: string,
  userId: string,
): SongSectionRow[] {
  return structure.map((entry, index) => ({
    id: id("sec"),
    song_id: songId,
    user_id: userId,
    position: index,
    kind: entry.kind,
    label: entry.label ?? null,
    content: "",
    bar_start: entry.barStart ?? null,
    bar_end: entry.barEnd ?? null,
    updated_at: nowIso(),
  }));
}

/** Beat-aware starting structure — never forced, always editable (spec §26). */
function structureFromBeat(profile: BeatProfile): { kind: SongSectionKind; label?: string; barStart?: number; barEnd?: number }[] {
  const kindMap: Record<string, SongSectionKind> = {
    intro: "intro",
    verse: "verse",
    "pre-chorus": "pre-chorus",
    chorus: "chorus",
    bridge: "bridge",
    break: "break",
    outro: "outro",
    instrumental: "break",
  };
  const counts = new Map<string, number>();
  const structure = profile.sections.map((section) => {
    const kind = kindMap[section.type] ?? "custom";
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    const baseLabel = kind.charAt(0).toUpperCase() + kind.slice(1);
    return {
      kind,
      label: count > 1 ? `${baseLabel} ${count}` : baseLabel,
      barStart: section.bars[0],
      barEnd: section.bars[1],
    };
  });
  return structure.length > 0 ? structure : DEFAULT_STRUCTURE;
}

function snapshotPayload(song: SongRow, sections: SongSectionRow[]): string {
  return JSON.stringify({
    title: song.title,
    concept: song.concept,
    intention: song.intention,
    language: song.language,
    perspective: song.perspective,
    energy: song.energy,
    sections: sections.map(mapSection),
  });
}

async function hashSnapshot(snapshot: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseSectionsInput(value: unknown): SongSectionPayload[] {
  if (!Array.isArray(value)) throw new HttpError(400, "sections must be an array");
  return value.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const content = typeof record["content"] === "string" ? record["content"] : "";
    if (content.length > MAX_SECTION_CONTENT) throw new HttpError(400, "A section is too long");
    return {
      id: typeof record["id"] === "string" ? record["id"] : undefined,
      position: typeof record["position"] === "number" ? record["position"] : index,
      kind: typeof record["kind"] === "string" ? record["kind"] : "custom",
      label: typeof record["label"] === "string" ? record["label"].slice(0, 80) : null,
      content,
      barStart: typeof record["barStart"] === "number" ? record["barStart"] : null,
      barEnd: typeof record["barEnd"] === "number" ? record["barEnd"] : null,
    };
  });
}

async function loadSongBundle(store: Store, ctx: RouteContext, songId: string, userId: string) {
  const song = await store.getSong(songId, userId);
  if (!song) throw new HttpError(404, "Song not found");
  const sections = await store.listSections(songId);
  const payloadSections = sections.map(mapSection);
  const beat = song.beat_id ? await store.getBeat(song.beat_id, userId) : null;
  const analysis = song.beat_id ? await store.getAnalysis(song.beat_id) : null;
  let profile: BeatProfile | null = null;
  if (analysis?.profile_json) {
    try {
      profile = JSON.parse(analysis.profile_json) as BeatProfile;
    } catch {
      profile = null;
    }
  }
  const health = analyseSongHealth(payloadSections, profile, song.concept);
  void ctx;
  return { song, sections, payloadSections, beat, profile, health };
}

export function registerSongRoutes(router: Router): void {
  router.post("/api/songs", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const body = await readJson<{
      beatId?: string;
      title?: string;
      concept?: string;
      intention?: string;
      language?: string;
      perspective?: string;
      energy?: string;
      structure?: { kind: SongSectionKind; label?: string }[];
    }>(ctx.req);

    const beatId = optionalString(body.beatId, 60);
    let beat: { id: string; title: string } | null = null;
    let structure: { kind: SongSectionKind; label?: string; barStart?: number | null; barEnd?: number | null }[];

    if (beatId) {
      const beatRow = await store.getBeat(beatId, userId);
      if (!beatRow) throw new HttpError(404, "Beat not found");
      beat = { id: beatRow.id, title: beatRow.title };
      const analysis = await store.getAnalysis(beatId);
      if (analysis?.profile_json) {
        try {
          structure = structureFromBeat(JSON.parse(analysis.profile_json) as BeatProfile);
        } catch {
          structure = DEFAULT_STRUCTURE;
        }
      } else {
        structure = DEFAULT_STRUCTURE;
      }
    } else {
      structure = DEFAULT_STRUCTURE;
    }

    if (Array.isArray(body.structure) && body.structure.length > 0) {
      structure = body.structure
        .filter((entry) => entry && typeof entry.kind === "string")
        .slice(0, 40)
        .map((entry) => ({ kind: entry.kind, label: entry.label }));
      if (structure.length === 0) structure = DEFAULT_STRUCTURE;
    }

    const songId = id("song");
    const title = (optionalString(body.title, MAX_TITLE) || (beat ? `${beat.title} — new song` : "Untitled song")).slice(
      0,
      MAX_TITLE,
    );
    const song: SongRow = {
      id: songId,
      user_id: userId,
      beat_id: beatId,
      title,
      concept: optionalString(body.concept, MAX_CONCEPT),
      intention: optionalString(body.intention, 120),
      language: optionalString(body.language, 120),
      perspective: optionalString(body.perspective, 120),
      energy: optionalString(body.energy, 60),
      status: "draft",
      current_version: 1,
      created_at: nowIso(),
      updated_at: nowIso(),
      completed_at: null,
    };

    const sections = sectionsFromStructure(structure, songId, userId);
    await store.createSong(song, sections);
    await store.createVersion({
      id: id("ver"),
      song_id: songId,
      user_id: userId,
      version_no: 1,
      name: "Created",
      snapshot_json: snapshotPayload(song, sections),
      created_at: nowIso(),
    });
    await store.recordEvent("song_created", userId, { songId, beatId });

    return json({ song: mapSong(song), sections: sections.map(mapSection) }, { status: 201 });
  });

  router.get("/api/songs", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songs = await store.listSongs(userId, 100);
    const beats = await store.listBeats(userId, 100);
    const beatTitles = new Map(beats.map((beat) => [beat.id, beat.title]));
    return json({
      songs: songs.map((song) => ({
        ...mapSong(song),
        beatTitle: song.beat_id ? (beatTitles.get(song.beat_id) ?? null) : null,
      })),
    });
  });

  router.get("/api/songs/:id", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const bundle = await loadSongBundle(store, ctx, songId, userId);
    const versions = await store.listVersions(songId, 20);

    return json({
      song: mapSong(bundle.song),
      sections: bundle.payloadSections,
      health: bundle.health,
      beat: bundle.beat
        ? {
            id: bundle.beat.id,
            title: bundle.beat.title,
            status: bundle.beat.status,
            durationSeconds: bundle.beat.duration_seconds,
          }
        : null,
      profile: bundle.profile,
      versions: versions.map((version) => ({
        id: version.id,
        versionNo: version.version_no,
        name: version.name,
        createdAt: version.created_at,
      })),
    });
  });

  router.patch("/api/songs/:id", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const song = await store.getSong(songId, userId);
    if (!song) throw new HttpError(404, "Song not found");

    const body = await readJson<Record<string, unknown>>(ctx.req);
    await store.updateSong(songId, userId, {
      title: body["title"] !== undefined ? (optionalString(body["title"], MAX_TITLE) || song.title) : undefined,
      concept: body["concept"] !== undefined ? optionalString(body["concept"], MAX_CONCEPT) : undefined,
      intention: body["intention"] !== undefined ? optionalString(body["intention"], 120) : undefined,
      language: body["language"] !== undefined ? optionalString(body["language"], 120) : undefined,
      perspective: body["perspective"] !== undefined ? optionalString(body["perspective"], 120) : undefined,
      energy: body["energy"] !== undefined ? optionalString(body["energy"], 60) : undefined,
      status: body["status"] === "complete" || body["status"] === "draft" ? body["status"] : undefined,
      completed_at: body["status"] === "complete" ? nowIso() : body["status"] === "draft" ? null : undefined,
    });

    if (body["status"] === "complete") {
      await store.recordEvent("song_completed", userId, { songId });
    }
    const updated = await store.getSong(songId, userId);
    return json({ song: updated ? mapSong(updated) : null });
  });

  /** Autosave: replaces the sections and (throttled) snapshots a version. */
  router.post("/api/songs/:id/save", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const song = await store.getSong(songId, userId);
    if (!song) throw new HttpError(404, "Song not found");

    const body = await readJson<{
      sections?: unknown;
      song?: Record<string, unknown>;
      versionName?: string;
      createVersion?: boolean;
    }>(ctx.req);

    const incoming = parseSectionsInput(body.sections ?? []);
    const rows: SongSectionRow[] = incoming.map((section, index) => ({
      id: section.id && section.id.startsWith("sec_") ? section.id : id("sec"),
      song_id: songId,
      user_id: userId,
      position: index,
      kind: section.kind,
      label: section.label ?? null,
      content: section.content.slice(0, MAX_SECTION_CONTENT),
      bar_start: section.barStart ?? null,
      bar_end: section.barEnd ?? null,
      updated_at: nowIso(),
    }));

    await store.replaceSections(songId, userId, rows);

    if (body.song) {
      await store.updateSong(songId, userId, {
        title: body.song["title"] !== undefined ? (optionalString(body.song["title"], MAX_TITLE) || song.title) : undefined,
        concept: body.song["concept"] !== undefined ? optionalString(body.song["concept"], MAX_CONCEPT) : undefined,
        intention: body.song["intention"] !== undefined ? optionalString(body.song["intention"], 120) : undefined,
        language: body.song["language"] !== undefined ? optionalString(body.song["language"], 120) : undefined,
        perspective: body.song["perspective"] !== undefined ? optionalString(body.song["perspective"], 120) : undefined,
        energy: body.song["energy"] !== undefined ? optionalString(body.song["energy"], 60) : undefined,
      });
    }

    const updated = (await store.getSong(songId, userId)) ?? song;
    const snapshot = snapshotPayload(updated, rows);
    const hash = await hashSnapshot(snapshot);
    const latest = await store.listVersions(songId, 1);
    const latestVersion = latest[0];

    let createdVersionNo: number | null = null;
    const latestIsSame = latestVersion ? (await hashSnapshot(latestVersion.snapshot_json)) === hash : false;
    const staleEnough =
      !latestVersion || Date.now() - Date.parse(latestVersion.created_at) > VERSION_THROTTLE_MS;

    const explicit = Boolean(body.createVersion) || Boolean(body.versionName);
    if (!latestIsSame && (explicit || staleEnough)) {
      const versionNo = await store.nextVersionNo(songId);
      await store.createVersion({
        id: id("ver"),
        song_id: songId,
        user_id: userId,
        version_no: versionNo,
        name: optionalString(body.versionName, 120) ?? (explicit ? "Manual save" : "Autosave"),
        snapshot_json: snapshot,
        created_at: nowIso(),
      });
      await store.setCurrentVersion(songId, userId, versionNo);
      createdVersionNo = versionNo;
    }

    return json({
      savedAt: nowIso(),
      versionNo: createdVersionNo ?? updated.current_version,
      createdVersion: createdVersionNo !== null,
      sections: rows.map(mapSection),
      song: mapSong(updated),
    });
  });

  router.get("/api/songs/:id/versions", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const song = await store.getSong(songId, userId);
    if (!song) throw new HttpError(404, "Song not found");
    const versions = await store.listVersions(songId, 100);
    return json({
      versions: versions.map((version) => ({
        id: version.id,
        versionNo: version.version_no,
        name: version.name,
        createdAt: version.created_at,
        preview: previewOf(version),
      })),
    });
  });

  router.post("/api/songs/:id/versions", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const song = await store.getSong(songId, userId);
    if (!song) throw new HttpError(404, "Song not found");
    const body = await readJson<{ name?: string }>(ctx.req).catch(() => ({}) as { name?: string });

    const sections = await store.listSections(songId);
    const versionNo = await store.nextVersionNo(songId);
    await store.createVersion({
      id: id("ver"),
      song_id: songId,
      user_id: userId,
      version_no: versionNo,
      name: optionalString(body.name, 120) ?? "Snapshot",
      snapshot_json: snapshotPayload(song, sections),
      created_at: nowIso(),
    });
    await store.setCurrentVersion(songId, userId, versionNo);
    return json({ versionNo }, { status: 201 });
  });

  router.post("/api/songs/:id/versions/:versionId/restore", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const versionId = ctx.params["versionId"] ?? "";
    const song = await store.getSong(songId, userId);
    if (!song) throw new HttpError(404, "Song not found");
    const version = await store.getVersion(versionId, userId);
    if (!version || version.song_id !== songId) throw new HttpError(404, "Version not found");

    const parsed = JSON.parse(version.snapshot_json) as {
      title?: string;
      concept?: string | null;
      sections?: SongSectionPayload[];
    };
    const snapshotSections = parsed.sections ?? [];
    const rows: SongSectionRow[] = snapshotSections.map((section, index) => ({
      id: id("sec"),
      song_id: songId,
      user_id: userId,
      position: index,
      kind: section.kind,
      label: section.label ?? null,
      content: section.content ?? "",
      bar_start: section.barStart ?? null,
      bar_end: section.barEnd ?? null,
      updated_at: nowIso(),
    }));
    await store.replaceSections(songId, userId, rows);
    if (parsed.title) await store.updateSong(songId, userId, { title: parsed.title, concept: parsed.concept ?? null });

    // Restoring is itself a new version: nothing is ever destroyed (spec §31).
    const versionNo = await store.nextVersionNo(songId);
    await store.createVersion({
      id: id("ver"),
      song_id: songId,
      user_id: userId,
      version_no: versionNo,
      name: `Restored v${version.version_no}`,
      snapshot_json: version.snapshot_json,
      created_at: nowIso(),
    });
    await store.setCurrentVersion(songId, userId, versionNo);
    await store.recordEvent("song_version_restored", userId, { songId, restored: version.version_no });

    return json({ restoredFrom: version.version_no, versionNo, sections: rows.map(mapSection) });
  });

  /** Live session state (Durable Object) — autosave coordination + presence. */
  router.get("/api/songs/:id/live", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const song = await store.getSong(songId, userId);
    if (!song) throw new HttpError(404, "Song not found");
    const stub = ctx.env.SONG_SESSION.get(ctx.env.SONG_SESSION.idFromName(songId));
    return stub.fetch("https://session/live");
  });

  router.post("/api/songs/:id/live", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const song = await store.getSong(songId, userId);
    if (!song) throw new HttpError(404, "Song not found");
    const body = await ctx.req.text();
    const stub = ctx.env.SONG_SESSION.get(ctx.env.SONG_SESSION.idFromName(songId));
    return stub.fetch("https://session/live", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  });

  /** Real-time channel for the session (collaboration + autosave echo). */
  router.get("/api/songs/:id/ws", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const song = await store.getSong(songId, userId);
    if (!song) throw new HttpError(404, "Song not found");
    const stub = ctx.env.SONG_SESSION.get(ctx.env.SONG_SESSION.idFromName(songId));
    return stub.fetch("https://session/ws", ctx.req);
  });

  /** Health check (spec §27) — computed locally, free, always available. */
  router.get("/api/songs/:id/health", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const bundle = await loadSongBundle(store, ctx, songId, userId);
    return json({ health: bundle.health });
  });

  /** Export (spec §46): plain text, structure JSON and project metadata. */
  router.get("/api/songs/:id/export", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const bundle = await loadSongBundle(store, ctx, songId, userId);
    const format = (ctx.url.searchParams.get("format") ?? "txt").toLowerCase();

    await store.recordEvent("song_exported", userId, { songId, format });

    if (format === "json") {
      return json({
        song: mapSong(bundle.song),
        sections: bundle.payloadSections,
        health: bundle.health,
        beat: bundle.profile
          ? {
              bpm: bundle.profile.bpm,
              key: bundle.profile.key,
              time_signature: bundle.profile.time_signature,
              sections: bundle.profile.sections,
            }
          : null,
        exportedAt: nowIso(),
      });
    }

    const lines: string[] = [bundle.song.title.toUpperCase()];
    if (bundle.profile) lines.push(`${bundle.profile.bpm} BPM · ${bundle.profile.key}`);
    if (bundle.song.concept) lines.push(`Concept: ${bundle.song.concept}`);
    lines.push("");
    for (const section of bundle.payloadSections) {
      lines.push(`[${(section.label ?? section.kind).toUpperCase()}]`);
      lines.push(section.content || "(empty)");
      lines.push("");
    }
    lines.push(`— exported ${new Date().toISOString()}`);

    const filename = `${bundle.song.title.replace(/[^A-Za-z0-9-_ ]/g, "").trim().replace(/\s+/g, "-") || "song"}.txt`;
    return new Response(lines.join("\n"), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });

  router.delete("/api/songs/:id", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const songId = ctx.params["id"] ?? "";
    const song = await store.getSong(songId, userId);
    if (!song) throw new HttpError(404, "Song not found");
    await store.deleteSong(songId, userId);
    return noContent();
  });
}

function previewOf(version: LyricVersionRow): string {
  try {
    const parsed = JSON.parse(version.snapshot_json) as { sections?: SongSectionPayload[] };
    const text = (parsed.sections ?? [])
      .map((section) => section.content)
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 160);
  } catch {
    return "";
  }
}

export const SONG_TITLE_MAX = MAX_TITLE;
export const songHelpers = { mapSong, mapSection, snapshotPayload, DEFAULT_STRUCTURE };
export const songRequireTitle = requireString;
