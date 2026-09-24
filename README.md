# Zarlino Songwriting Studio

A Cloudflare-native songwriting workspace: **upload a beat, see what it is giving, write with it.**
The AI is a collaborator — every suggestion is optional, and nothing it returns is ever applied without
the artist accepting it.

Built for the Zarlino Cloudflare account and reusing its resources (account, KV, queues, R2, AI
Gateway), with the analysis runtime as a Cloudflare Container.

```
UPLOAD BEAT → ANALYSE → BEAT PROFILE → SONG → WRITE / ASK AI → KEEP OR DISCARD → VERSIONS → EXPORT
```

---

## What is in this repo

| Path | What it is |
| --- | --- |
| `src/` | Cloudflare Worker: API, auth, R2 upload signing, queue consumer, `SongSessionDO` (live session), AI routing |
| `web/` | React + TypeScript + Tailwind frontend (lyric editor, beat player, AI panel, idea bank) — built into the Worker's assets |
| `analysis/` | Python audio-analysis service (numpy/scipy): tempo, beats, key, chords, sections, energy, loudness — runs as a Cloudflare Container or on any box |
| `db/schema.sql` | D1 schema (idempotent) |
| `test/` | Vitest suite for the Worker/shared logic |
| `analysis/tests/` | Pytest suite for the DSP engine (synthetic signals: known-BPM click tracks, known triads, energy ramps) |
| `tools/` | PowerShell helpers (local analysis setup/run/test) |
| `docs/` | Architecture, setup and operations notes |

---

## Features implemented (MVP slice)

**Beat**
- Upload WAV / MP3 / M4A / FLAC / AAC — browser → R2 directly with a presigned PUT (audio never flows
  through the Worker request body), with progress and a Worker-proxied fallback when R2 keys are absent.
- Queue-driven analysis: `R2 → Queue → analysis runtime → beat profile → D1 (+ KV cache)`.
- Beat profile: BPM + confidence, key + confidence, time signature, bars, beat grid, downbeats, chords +
  progression, sections (intro/verse/pre-chorus/chorus/bridge/outro), per-bar energy curve, LUFS, peak,
  dynamic range, waveform peaks, silence regions, mood tags — each with warnings where confidence is low.
- "What this beat is giving": plain-language summary, songwriting characteristics, and the musical
  evidence behind every claim.
- Artist corrections: BPM / key / sections / energy are editable, and corrections drive every later suggestion.

**Writing**
- Lyric editor: sections with drag-reorder, kinds, labels, bar ranges, live syllable + word counts,
  rhyme gutter (end-rhyme groups, near rhymes), repetition and cliché flags.
- Autosave (debounced) into D1, throttled version snapshots, manual "Save version" (⌘/Ctrl+S),
  restore from any version — restoring creates a new version rather than destroying history.
- Beat-synchronised player: waveform, section markers, bar grid, loop a section, playback speed,
  metronome, keyboard shortcuts (Space / L / M / ← →).
- Song health check: concept, story, hook, lyrics, repetition, contrast, rhythm, emotion, beat fit —
  analytical, not complimentary.

**AI**
- One entry point, 13 modes: concept, hook, rhyme, cadence, metaphor, story, contrast, melody, rewrite,
  simplify, intensify, personalize, challenge-me critique.
- Dynamic Song Context (artist + beat + song + current/previous sections + instruction + selection) —
  never the whole database.
- Model tiers (fast / creative / reasoning) routed through **AI Gateway**, provider-agnostic
  (DeepSeek today; swap the provider with one env var), with KV response caching and per-request cost,
  latency, token and gateway-log-id logging.
- Artist Voice System: preferences, taboo phrases (enforced server-side, not just requested in the
  prompt), writing samples, and accepted/rejected suggestion memory.

**Also**
- Privacy by default: every beat/song is scoped to the authenticated user, signed URLs for audio,
  no public objects, sessions stored hashed.
- Idea bank, artist profile, observability counters (Songs Finished first, never message counts).
- Exports: `.txt` lyrics (with BPM/key/beat header) and `.json` (song + structure + health + beat).

---

## Quick start

```powershell
# 1. Worker deps + frontend deps
npm install
npm --prefix web install

# 2. Local secrets (never committed)
Copy-Item .dev.vars.example .dev.vars     # then fill in DEEPSEEK_API_KEY etc.

# 3. Local database schema
npm run db:local

# 4. Local analysis runtime (separate terminal)
npm run analysis:setup
npm run analysis:serve                    # http://127.0.0.1:8788

# 5. Run the Worker + UI
npm run dev                               # http://127.0.0.1:8787  (API + built UI)
npm run dev:web                           # http://127.0.0.1:5173  (UI dev server, proxies /api)
```

Then open the app, create an account, upload a beat, and start writing.

## Tests

```powershell
npm test              # Worker + shared logic (vitest)
npm run analysis:test # DSP engine (pytest, synthetic signals)
npm run typecheck     # Worker types
npm --prefix web run build   # frontend type check + build
```

## Deploy

See `docs/SETUP.md` for the full checklist (R2 activation, S3 keys, secrets, D1 schema, container
deployment). Short version once the account side is ready:

```powershell
npm run db:remote                     # apply the schema to production D1
npm run deploy                        # build the UI, deploy the Worker (analysis over HTTP)
npm run deploy:containers             # same, but with the analysis Cloudflare Container (needs Docker)
```

## Cloudflare resources used

| Resource | Name | Notes |
| --- | --- | --- |
| D1 | `songwriting-studio` | relational metadata (users, beats, songs, versions, AI log) |
| KV | `SONGWRITING_KV` | AI response cache, beat-intelligence cache, rate limits |
| R2 | `songwriting-beats` | canonical audio storage (original beats) |
| Queue | `songwriting-analysis` (+ `-dlq`) | analysis jobs, never blocking the UI |
| Durable Object | `SongSessionDO` | one per active songwriting session |
| Container | `zarlino-songwriting-analysis` | optional: the analysis runtime itself |
| AI Gateway | `songwriting-studio` | central LLM routing, caching and logging |

## Documentation

- `docs/ARCHITECTURE.md` — how the pieces fit, data flow, contracts, security boundaries.
- `docs/SETUP.md` — account setup, secrets, deployment, operations, troubleshooting.
