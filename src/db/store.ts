import { nowIso } from "../util/ids";

/**
 * D1 access layer. Every statement is parameterised; every read is bounded.
 * Rows are returned in snake_case (database shape) — API routes map to
 * camelCase for the frontend.
 */

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string;
  password_salt: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

export interface ArtistProfileRow {
  user_id: string;
  languages_json: string;
  style: string | null;
  perspective: string | null;
  themes_json: string;
  vocabulary_json: string;
  phrases_json: string;
  imagery_json: string;
  taboo_json: string;
  rhyme_preference: string | null;
  sentence_length: string | null;
  structure_prefs_json: string;
  writing_samples_json: string;
  updated_at: string;
}

export interface BeatRow {
  id: string;
  user_id: string;
  title: string;
  status: string;
  r2_key: string;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface UploadSessionRow {
  id: string;
  beat_id: string;
  user_id: string;
  r2_key: string;
  kind: string;
  upload_id: string | null;
  parts_total: number;
  expires_at: string;
  created_at: string;
}

export interface BeatAnalysisRow {
  beat_id: string;
  user_id: string;
  profile_json: string;
  engine: string;
  engine_version: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface AnalysisJobRow {
  id: string;
  beat_id: string;
  user_id: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface SongRow {
  id: string;
  user_id: string;
  beat_id: string | null;
  title: string;
  concept: string | null;
  intention: string | null;
  language: string | null;
  perspective: string | null;
  energy: string | null;
  status: string;
  current_version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SongSectionRow {
  id: string;
  song_id: string;
  user_id: string;
  position: number;
  kind: string;
  label: string | null;
  content: string;
  bar_start: number | null;
  bar_end: number | null;
  updated_at: string;
}

export interface LyricVersionRow {
  id: string;
  song_id: string;
  user_id: string;
  version_no: number;
  name: string | null;
  snapshot_json: string;
  created_at: string;
}

export interface AiRequestRow {
  id: string;
  user_id: string;
  song_id: string | null;
  section_id: string | null;
  mode: string;
  tier: string;
  provider: string | null;
  model: string | null;
  instruction: string | null;
  selection: string | null;
  context_json: string | null;
  response_json: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  latency_ms: number;
  cached: number;
  gateway_log_id: string | null;
  error: string | null;
  created_at: string;
}

export interface IdeaRow {
  id: string;
  user_id: string;
  song_id: string | null;
  kind: string;
  text: string;
  tags_json: string;
  source: string;
  created_at: string;
  updated_at: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class Store {
  constructor(private readonly db: D1Database) {}

  // --- Users ---------------------------------------------------------------
  async createUser(user: UserRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        user.id,
        user.email,
        user.display_name,
        user.password_hash,
        user.password_salt,
        user.created_at,
        user.updated_at,
      )
      .run();
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    return this.db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<UserRow>();
  }

  async getUserById(userId: string): Promise<UserRow | null> {
    return this.db.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first<UserRow>();
  }

  // --- Sessions ------------------------------------------------------------
  async createSession(session: SessionRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(session.id, session.user_id, session.token_hash, session.created_at, session.expires_at, session.last_seen_at)
      .run();
  }

  async getSessionByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    return this.db.prepare(`SELECT * FROM auth_sessions WHERE token_hash = ?`).bind(tokenHash).first<SessionRow>();
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?`)
      .bind(nowIso(), sessionId)
      .run();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM auth_sessions WHERE id = ?`).bind(sessionId).run();
  }

  async deleteExpiredSessions(): Promise<void> {
    await this.db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`).bind(nowIso()).run();
  }

  // --- Artist profile ------------------------------------------------------
  async getProfile(userId: string): Promise<ArtistProfileRow | null> {
    return this.db.prepare(`SELECT * FROM artist_profiles WHERE user_id = ?`).bind(userId).first<ArtistProfileRow>();
  }

  async upsertProfile(row: ArtistProfileRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO artist_profiles (
           user_id, languages_json, style, perspective, themes_json, vocabulary_json, phrases_json,
           imagery_json, taboo_json, rhyme_preference, sentence_length, structure_prefs_json,
           writing_samples_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           languages_json = excluded.languages_json,
           style = excluded.style,
           perspective = excluded.perspective,
           themes_json = excluded.themes_json,
           vocabulary_json = excluded.vocabulary_json,
           phrases_json = excluded.phrases_json,
           imagery_json = excluded.imagery_json,
           taboo_json = excluded.taboo_json,
           rhyme_preference = excluded.rhyme_preference,
           sentence_length = excluded.sentence_length,
           structure_prefs_json = excluded.structure_prefs_json,
           writing_samples_json = excluded.writing_samples_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        row.user_id,
        row.languages_json,
        row.style,
        row.perspective,
        row.themes_json,
        row.vocabulary_json,
        row.phrases_json,
        row.imagery_json,
        row.taboo_json,
        row.rhyme_preference,
        row.sentence_length,
        row.structure_prefs_json,
        row.writing_samples_json,
        row.updated_at,
      )
      .run();
  }

  // --- Beats ---------------------------------------------------------------
  async createBeat(beat: BeatRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO beats (id, user_id, title, status, r2_key, original_filename, mime_type, size_bytes,
                            duration_seconds, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        beat.id,
        beat.user_id,
        beat.title,
        beat.status,
        beat.r2_key,
        beat.original_filename,
        beat.mime_type,
        beat.size_bytes,
        beat.duration_seconds,
        beat.error,
        beat.created_at,
        beat.updated_at,
      )
      .run();
  }

  async getBeat(beatId: string, userId: string): Promise<BeatRow | null> {
    return this.db
      .prepare(`SELECT * FROM beats WHERE id = ? AND user_id = ?`)
      .bind(beatId, userId)
      .first<BeatRow>();
  }

  async listBeats(userId: string, limit = 50): Promise<BeatRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM beats WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(userId, limit)
      .all<BeatRow>();
    return res.results ?? [];
  }

  async updateBeat(
    beatId: string,
    userId: string,
    patch: Partial<Pick<BeatRow, "title" | "status" | "duration_seconds" | "error" | "mime_type" | "size_bytes">>,
  ): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(nowIso(), beatId, userId);
    await this.db
      .prepare(`UPDATE beats SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
      .bind(...values)
      .run();
  }

  async deleteBeat(beatId: string, userId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM beats WHERE id = ? AND user_id = ?`).bind(beatId, userId),
      this.db.prepare(`DELETE FROM beat_analyses WHERE beat_id = ? AND user_id = ?`).bind(beatId, userId),
      this.db.prepare(`DELETE FROM analysis_jobs WHERE beat_id = ? AND user_id = ?`).bind(beatId, userId),
      this.db.prepare(`DELETE FROM upload_sessions WHERE beat_id = ? AND user_id = ?`).bind(beatId, userId),
    ]);
  }

  // --- Upload sessions -----------------------------------------------------
  async createUploadSession(row: UploadSessionRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO upload_sessions (id, beat_id, user_id, r2_key, kind, upload_id, parts_total, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.beat_id,
        row.user_id,
        row.r2_key,
        row.kind,
        row.upload_id,
        row.parts_total,
        row.expires_at,
        row.created_at,
      )
      .run();
  }

  async getUploadSession(sessionId: string, userId: string): Promise<UploadSessionRow | null> {
    return this.db
      .prepare(`SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?`)
      .bind(sessionId, userId)
      .first<UploadSessionRow>();
  }

  async deleteUploadSession(sessionId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM upload_sessions WHERE id = ?`).bind(sessionId).run();
  }

  // --- Analysis ------------------------------------------------------------
  async upsertAnalysis(row: BeatAnalysisRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO beat_analyses (beat_id, user_id, profile_json, engine, engine_version, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(beat_id) DO UPDATE SET
           profile_json = excluded.profile_json,
           engine = excluded.engine,
           engine_version = excluded.engine_version,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .bind(
        row.beat_id,
        row.user_id,
        row.profile_json,
        row.engine,
        row.engine_version,
        row.source,
        row.created_at,
        row.updated_at,
      )
      .run();
  }

  async getAnalysis(beatId: string): Promise<BeatAnalysisRow | null> {
    return this.db.prepare(`SELECT * FROM beat_analyses WHERE beat_id = ?`).bind(beatId).first<BeatAnalysisRow>();
  }

  async createAnalysisJob(row: AnalysisJobRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO analysis_jobs (id, beat_id, user_id, status, attempts, error, created_at, started_at, finished_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.beat_id,
        row.user_id,
        row.status,
        row.attempts,
        row.error,
        row.created_at,
        row.started_at,
        row.finished_at,
        row.updated_at,
      )
      .run();
  }

  async getAnalysisJob(jobId: string): Promise<AnalysisJobRow | null> {
    return this.db.prepare(`SELECT * FROM analysis_jobs WHERE id = ?`).bind(jobId).first<AnalysisJobRow>();
  }

  async latestJobForBeat(beatId: string): Promise<AnalysisJobRow | null> {
    return this.db
      .prepare(`SELECT * FROM analysis_jobs WHERE beat_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(beatId)
      .first<AnalysisJobRow>();
  }

  async markJobRunning(jobId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE analysis_jobs SET status = 'running', started_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), nowIso(), jobId)
      .run();
  }

  async finishJob(jobId: string, status: "done" | "failed", error: string | null): Promise<void> {
    await this.db
      .prepare(`UPDATE analysis_jobs SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
      .bind(status, error, nowIso(), nowIso(), jobId)
      .run();
  }

  // --- Songs ---------------------------------------------------------------
  async createSong(song: SongRow, sections: SongSectionRow[]): Promise<void> {
    const statements = [
      this.db
        .prepare(
          `INSERT INTO songs (id, user_id, beat_id, title, concept, intention, language, perspective, energy,
                              status, current_version, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          song.id,
          song.user_id,
          song.beat_id,
          song.title,
          song.concept,
          song.intention,
          song.language,
          song.perspective,
          song.energy,
          song.status,
          song.current_version,
          song.created_at,
          song.updated_at,
          song.completed_at,
        ),
      ...sections.map((section) =>
        this.db
          .prepare(
            `INSERT INTO song_sections (id, song_id, user_id, position, kind, label, content, bar_start, bar_end, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            section.id,
            section.song_id,
            section.user_id,
            section.position,
            section.kind,
            section.label,
            section.content,
            section.bar_start,
            section.bar_end,
            section.updated_at,
          ),
      ),
    ];
    await this.db.batch(statements);
  }

  async getSong(songId: string, userId: string): Promise<SongRow | null> {
    return this.db.prepare(`SELECT * FROM songs WHERE id = ? AND user_id = ?`).bind(songId, userId).first<SongRow>();
  }

  async listSongs(userId: string, limit = 50): Promise<SongRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM songs WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`)
      .bind(userId, limit)
      .all<SongRow>();
    return res.results ?? [];
  }

  async updateSong(
    songId: string,
    userId: string,
    patch: Partial<
      Pick<
        SongRow,
        "title" | "concept" | "intention" | "language" | "perspective" | "energy" | "status" | "completed_at"
      >
    >,
  ): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(nowIso(), songId, userId);
    await this.db
      .prepare(`UPDATE songs SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
      .bind(...values)
      .run();
  }

  async deleteSong(songId: string, userId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM songs WHERE id = ? AND user_id = ?`).bind(songId, userId),
      this.db.prepare(`DELETE FROM song_sections WHERE song_id = ? AND user_id = ?`).bind(songId, userId),
      this.db.prepare(`DELETE FROM lyric_versions WHERE song_id = ? AND user_id = ?`).bind(songId, userId),
    ]);
  }

  // --- Sections ------------------------------------------------------------
  async listSections(songId: string): Promise<SongSectionRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM song_sections WHERE song_id = ? ORDER BY position ASC`)
      .bind(songId)
      .all<SongSectionRow>();
    return res.results ?? [];
  }

  async getSection(sectionId: string, userId: string): Promise<SongSectionRow | null> {
    return this.db
      .prepare(`SELECT * FROM song_sections WHERE id = ? AND user_id = ?`)
      .bind(sectionId, userId)
      .first<SongSectionRow>();
  }

  /** Wholesale replace of a song's sections (used by autosave). */
  async replaceSections(songId: string, userId: string, sections: SongSectionRow[]): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`DELETE FROM song_sections WHERE song_id = ? AND user_id = ?`).bind(songId, userId),
      ...sections.map((section) =>
        this.db
          .prepare(
            `INSERT INTO song_sections (id, song_id, user_id, position, kind, label, content, bar_start, bar_end, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            section.id,
            section.song_id,
            section.user_id,
            section.position,
            section.kind,
            section.label,
            section.content,
            section.bar_start,
            section.bar_end,
            section.updated_at,
          ),
      ),
    ];
    await this.db.batch(statements);
  }

  // --- Versions ------------------------------------------------------------
  async createVersion(row: LyricVersionRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO lyric_versions (id, song_id, user_id, version_no, name, snapshot_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, row.song_id, row.user_id, row.version_no, row.name, row.snapshot_json, row.created_at)
      .run();
  }

  async nextVersionNo(songId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COALESCE(MAX(version_no), 0) AS n FROM lyric_versions WHERE song_id = ?`)
      .bind(songId)
      .first<{ n: number }>();
    return (row?.n ?? 0) + 1;
  }

  async listVersions(songId: string, limit = 50): Promise<LyricVersionRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM lyric_versions WHERE song_id = ? ORDER BY version_no DESC LIMIT ?`)
      .bind(songId, limit)
      .all<LyricVersionRow>();
    return res.results ?? [];
  }

  async getVersion(versionId: string, userId: string): Promise<LyricVersionRow | null> {
    return this.db
      .prepare(`SELECT * FROM lyric_versions WHERE id = ? AND user_id = ?`)
      .bind(versionId, userId)
      .first<LyricVersionRow>();
  }

  async setCurrentVersion(songId: string, userId: string, versionNo: number): Promise<void> {
    await this.db
      .prepare(`UPDATE songs SET current_version = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(versionNo, nowIso(), songId, userId)
      .run();
  }

  // --- AI ------------------------------------------------------------------
  async recordAiRequest(row: AiRequestRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ai_requests (id, user_id, song_id, section_id, mode, tier, provider, model, instruction, selection,
                                  context_json, response_json, prompt_tokens, completion_tokens, cost_usd, latency_ms,
                                  cached, gateway_log_id, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.user_id,
        row.song_id,
        row.section_id,
        row.mode,
        row.tier,
        row.provider,
        row.model,
        row.instruction,
        row.selection,
        row.context_json,
        row.response_json,
        row.prompt_tokens,
        row.completion_tokens,
        row.cost_usd,
        row.latency_ms,
        row.cached,
        row.gateway_log_id,
        row.error,
        row.created_at,
      )
      .run();
  }

  async getAiRequest(requestId: string, userId: string): Promise<AiRequestRow | null> {
    return this.db
      .prepare(`SELECT * FROM ai_requests WHERE id = ? AND user_id = ?`)
      .bind(requestId, userId)
      .first<AiRequestRow>();
  }

  async listRecentAiRequests(userId: string, limit = 20): Promise<AiRequestRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM ai_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(userId, limit)
      .all<AiRequestRow>();
    return res.results ?? [];
  }

  async recordAiFeedback(row: {
    id: string;
    request_id: string;
    user_id: string;
    option_index: number | null;
    accepted: number;
    chosen_text: string | null;
    edited_text: string | null;
    created_at: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ai_feedback (id, request_id, user_id, option_index, accepted, chosen_text, edited_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.request_id,
        row.user_id,
        row.option_index,
        row.accepted,
        row.chosen_text,
        row.edited_text,
        row.created_at,
      )
      .run();
  }

  /** Accepted / rejected examples for the artist voice system (spec §18–19). */
  async listJudgedFeedback(userId: string, limit = 40): Promise<
    { accepted: number; chosen_text: string | null; edited_text: string | null; mode: string; created_at: string }[]
  > {
    const res = await this.db
      .prepare(
        `SELECT f.accepted AS accepted, f.chosen_text AS chosen_text, f.edited_text AS edited_text,
                r.mode AS mode, f.created_at AS created_at
           FROM ai_feedback f
           JOIN ai_requests r ON r.id = f.request_id
          WHERE f.user_id = ?
          ORDER BY f.created_at DESC
          LIMIT ?`,
      )
      .bind(userId, limit)
      .all<{ accepted: number; chosen_text: string | null; edited_text: string | null; mode: string; created_at: string }>();
    return res.results ?? [];
  }

  // --- Ideas ---------------------------------------------------------------
  async createIdea(row: IdeaRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ideas (id, user_id, song_id, kind, text, tags_json, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, row.user_id, row.song_id, row.kind, row.text, row.tags_json, row.source, row.created_at, row.updated_at)
      .run();
  }

  async listIdeas(userId: string, limit = 100): Promise<IdeaRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM ideas WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(userId, limit)
      .all<IdeaRow>();
    return res.results ?? [];
  }

  async updateIdea(ideaId: string, userId: string, patch: { text?: string; kind?: string; tags_json?: string }): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(value as string);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(nowIso(), ideaId, userId);
    await this.db
      .prepare(`UPDATE ideas SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
      .bind(...values)
      .run();
  }

  async deleteIdea(ideaId: string, userId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM ideas WHERE id = ? AND user_id = ?`).bind(ideaId, userId).run();
  }

  // --- Observability -------------------------------------------------------
  async recordEvent(name: string, userId: string | null, props: Record<string, unknown> = {}): Promise<void> {
    await this.db
      .prepare(`INSERT INTO events (id, user_id, name, props_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(`evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, userId, name, JSON.stringify(props), nowIso())
      .run();
  }

  async countsByEvent(userId: string, sinceIso: string): Promise<{ name: string; count: number }[]> {
    const res = await this.db
      .prepare(`SELECT name, COUNT(*) AS count FROM events WHERE user_id = ? AND created_at >= ? GROUP BY name`)
      .bind(userId, sinceIso)
      .all<{ name: string; count: number }>();
    return res.results ?? [];
  }

  /** Cheap table-existence probe used by /api/health. */
  async tableCount(): Promise<number> {
    const res = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .first<{ n: number }>();
    return res?.n ?? 0;
  }
}

export function parseJsonArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map((v) => str(v)).filter(Boolean) : [];
  } catch {
    return [];
  }
}
