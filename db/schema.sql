-- Zarlino Songwriting Studio — D1 schema
-- Idempotent: safe to re-run against local or remote D1.
--
--   npm run db:local     (local dev database)
--   npm run db:remote    (production database)

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

-- Artist voice system: retrieval + preferences, never fine-tuning (spec §18)
CREATE TABLE IF NOT EXISTS artist_profiles (
  user_id             TEXT PRIMARY KEY,
  languages_json      TEXT NOT NULL DEFAULT '[]',
  style               TEXT,
  perspective         TEXT,
  themes_json         TEXT NOT NULL DEFAULT '[]',
  vocabulary_json     TEXT NOT NULL DEFAULT '[]',
  phrases_json        TEXT NOT NULL DEFAULT '[]',
  imagery_json        TEXT NOT NULL DEFAULT '[]',
  taboo_json          TEXT NOT NULL DEFAULT '[]',
  rhyme_preference    TEXT,
  sentence_length     TEXT,
  structure_prefs_json TEXT NOT NULL DEFAULT '[]',
  writing_samples_json TEXT NOT NULL DEFAULT '[]',
  updated_at          TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Beats + analysis
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS beats (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  title             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'UPLOADING', -- UPLOADING|ANALYZING|READY|FAILED
  r2_key            TEXT NOT NULL,
  original_filename TEXT,
  mime_type         TEXT,
  size_bytes        INTEGER,
  duration_seconds  REAL,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_beats_user ON beats(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id          TEXT PRIMARY KEY,
  beat_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- single | multipart | proxy
  upload_id   TEXT,
  parts_total INTEGER NOT NULL DEFAULT 1,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_beat ON upload_sessions(beat_id);

-- Machine-generated beat profile. `source` records whether the artist corrected it.
CREATE TABLE IF NOT EXISTS beat_analyses (
  beat_id       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  profile_json  TEXT NOT NULL,
  engine        TEXT NOT NULL,
  engine_version TEXT,
  source        TEXT NOT NULL DEFAULT 'analysis', -- analysis | corrected
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_beat_analyses_user ON beat_analyses(user_id);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id           TEXT PRIMARY KEY,
  beat_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_beat ON analysis_jobs(beat_id);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status ON analysis_jobs(status, updated_at);

-- ---------------------------------------------------------------------------
-- Songs, sections, versions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS songs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  beat_id         TEXT,
  title           TEXT NOT NULL,
  concept         TEXT,
  intention       TEXT,
  language        TEXT,
  perspective     TEXT,
  energy          TEXT,
  status          TEXT NOT NULL DEFAULT 'draft', -- draft | complete
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_songs_user ON songs(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS song_sections (
  id         TEXT PRIMARY KEY,
  song_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  position   INTEGER NOT NULL,
  kind       TEXT NOT NULL,          -- intro|verse|pre-chorus|chorus|bridge|outro|...
  label      TEXT,
  content    TEXT NOT NULL DEFAULT '',
  bar_start  INTEGER,
  bar_end    INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_sections_song ON song_sections(song_id, position);

CREATE TABLE IF NOT EXISTS lyric_versions (
  id            TEXT PRIMARY KEY,
  song_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  version_no    INTEGER NOT NULL,
  name          TEXT,
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lyric_versions_song ON lyric_versions(song_id, version_no DESC);

-- ---------------------------------------------------------------------------
-- AI interactions + personal writing memory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_requests (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  song_id           TEXT,
  section_id        TEXT,
  mode              TEXT NOT NULL,
  tier              TEXT NOT NULL,
  provider          TEXT,
  model             TEXT,
  instruction       TEXT,
  selection         TEXT,
  context_json      TEXT,
  response_json     TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  cached            INTEGER NOT NULL DEFAULT 0,
  gateway_log_id    TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_requests_user ON ai_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_requests_song ON ai_requests(song_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_feedback (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  option_index INTEGER,
  accepted     INTEGER NOT NULL,
  chosen_text  TEXT,
  edited_text  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_request ON ai_feedback(request_id);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_user ON ai_feedback(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ideas (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  song_id    TEXT,
  kind       TEXT NOT NULL,          -- hook|lyric|title|concept|one-liner|metaphor|story|melody|voice-note
  text       TEXT NOT NULL,
  tags_json  TEXT NOT NULL DEFAULT '[]',
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ideas_user ON ideas(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Observability (spec §54): what the product is actually used for
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  name       TEXT NOT NULL,
  props_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at DESC);
