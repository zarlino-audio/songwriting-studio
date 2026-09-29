# Architecture

How the studio is put together, and why.

## 1. One repository, four runtimes

```
                         ┌──────────────────────────────────────────────┐
   browser  ──────────▶  │  Cloudflare Worker  (src/)                   │
   (React app,           │  • API + auth (PBKDF2, hashed sessions)      │
    served from          │  • R2 upload sessions (presigned PUT)        │
    the Worker's         │  • Beat/song/lyrics/idea/profile routes      │
    assets)              │  • AI routing (AI Gateway → provider)        │
                         │  • SongSessionDO (live session per song)     │
                         └───────┬───────────────┬──────────────────────┘
                                 │               │
              ┌──────────────────┘               └────────────────────┐
              ▼                                                       ▼
     ┌─────────────────┐                                   ┌────────────────────┐
     │ D1 (metadata)   │                                   │ R2 (audio)         │
     │ users, beats,   │                                   │ audio/original/…   │
     │ songs, versions │                                   └────────────────────┘
     │ ai_requests…    │                                            ▲
     └─────────────────┘                                            │ signed URL
              ▲                                                   │
              │ profile JSON                                      │
     ┌────────┴──────────────────────────────────────────────────┐ │
     │ analysis runtime (analysis/)                              │─┘
     │  A. Cloudflare Container (wrangler.containers.toml)        │
     │  B. HTTP service on any box (ANALYSIS_MODE=http)           │
     │  C. polling worker on a workstation (ANALYSIS_DISPATCH=poll)│
     └───────────────────────────────────────────────────────────┘
```

The analysis runtime is deliberately pluggable: the same Python engine runs in all three
placements, and the Worker never does heavy DSP itself.

Placement A is the live one. Its image is published to the Cloudflare registry by
`tools/publish-image.ps1`, which assembles it in Python (base layers from Docker Hub + one layer with
the wheels and app source) and pushes it over HTTPS — so no machine needs a working Docker engine.
With `image` set to that registry reference, `wrangler deploy` needs no Docker either. Two fields are
easy to get wrong: `main` must be `src/container-entry.ts` (the only entrypoint exporting the
`AnalysisService` Durable Object *and* re-exporting the default `fetch`/`queue` handlers —
`export *` alone drops the default export and wrangler rejects the deploy with "Queue handler is
missing"), and a Dockerfile-path `image` requires Docker at deploy time whereas a registry reference
does not.

## 2. Beat pipeline

```
POST /api/beats/upload        → beat row (UPLOADING) + upload session
                                direct: presigned R2 PUT (browser → R2, no Worker body)
                                proxy : PUT /api/beats/:id/audio (Worker → R2 binding)
POST /api/beats/:id/complete  → HEAD the object, create analysis_jobs row (queued), beat ANALYZING
   dispatch=queue             → Queue message → consumer → runtime → profile
   dispatch=poll              → the row waits for POST /api/analysis/claim (machine token)
POST /api/analysis/submit     → storeAnalysisResult(): profile → D1, beat READY, intel cached in KV
                                 (shared with the queue path — one commit point)
```

Failure handling: transient runtime errors retry with backoff (queue) or are reported by the
worker itself (poll); permanent errors mark the beat `FAILED` with the message, and the artist
can re-run from the UI. Nothing spins forever.

## 3. Data model (D1, `db/schema.sql`)

| Table | Purpose |
| --- | --- |
| `users`, `auth_sessions` | identity; session tokens are stored **hashed** |
| `artist_profiles` | voice: languages, themes, vocabulary, imagery, taboo, rhyme + length prefs, samples |
| `beats`, `upload_sessions` | audio metadata + upload state |
| `beat_analyses`, `analysis_jobs` | the profile (source: analysis \| corrected) and job history |
| `songs`, `song_sections`, `lyric_versions` | the writing surface and its version history |
| `ai_requests`, `ai_feedback` | every AI call (cost, latency, tokens, gateway id) and what the artist kept |
| `ideas` | idea bank |
| `events` | product observability (Songs Finished first) |

Songs store sections as rows with a position and bar range: drag-reorder, per-section health and
beat alignment all work off that, while versions are whole-song JSON snapshots.

## 4. The Beat Profile contract

`src/types.ts` and `analysis/app/analysis/features.py` implement the same shape:

```jsonc
{
  "bpm": 103.36, "bpm_confidence": 0.99,
  "key": "F major", "key_confidence": 0.42, "scale": "major",
  "time_signature": "4/4", "duration_seconds": 12.0,
  "energy": { "overall": 0.55, "curve": [/* per bar */], "by_section": {"chorus": 0.86} },
  "mood": ["warm"],
  "rhythm": { "density": 0.7, "syncopation": 0.4, "swing": 0.0, "groove": "straight",
              "transient_density": 1.7, "complexity": 0.55,
              "beat_grid": [/* seconds */], "downbeats": [/* seconds */],
              "beats_per_bar": 4, "bar_count": 5 },
  "harmony": { "chords": [{"chord":"Fm","start":0,"end":0.58,"confidence":0.6}],
               "progression": ["Fm"], "harmonic_tension": [/* per bar */] },
  "sections": [{"type":"verse","start":0,"end":12,"energy":0.55,"confidence":0.6,"bars":[0,5]}],
  "technical": { "sample_rate": 44100, "channels": 1, "lufs": -14.2, "peak_db": -0.5,
                 "dynamic_range_db": 6.1, "waveform": [{"min":-0.4,"max":0.4}],
                 "silence_regions": [] },
  "warnings": ["Key confidence is low — check the detected key before relying on it."]
}
```

Two rules keep this honest:

1. **Everything is a signal.** `warnings` names every low-confidence estimate, and the artist can
   correct BPM, key, sections and energy in the UI. Corrections set `source = corrected` and feed
   every later AI request.
2. **The Worker defends itself.** `normalizeProfile()` coerces, clamps and defaults whatever the
   runtime returns, so an older/newer engine can never break the app.

### DSP notes (analysis/app/analysis/features.py)

- **Tempo** — log-magnitude spectral flux → autocorrelation with comb scoring (harmonics 1–5),
  folded into 70–180 BPM; confidence from the peak's margin over the distribution.
- **Beats** — phase search over the onset envelope, then local refinement (±18 % of a period).
- **Downbeats** — the bar phase whose beats carry the most 30–160 Hz energy.
- **Key** — harmonic-folded chroma (each spectral bin votes for its fundamental, corrected for the
  log-frequency nature of pitch) → Krumhansl–Schmuckler correlation over 24 keys; confidence from
  the margin over the runner-up.
- **Chords** — beat-synchronous chroma vs 48 triad templates with a root-support bonus, smoothed
  over three beats, run-length encoded into chord events.
- **Sections** — per-bar feature matrix (chroma + 5 band energies + energy) → self-similarity →
  checkerboard-kernel novelty → peak picking with a minimum length, labelled heuristically
  (intro/verse/pre-chorus/chorus/bridge/outro) from position and relative energy.
- **Loudness** — ITU-R BS.1770 K-weighting (bilinear-designed biquads) with absolute + relative
  gating; **dynamic range** from the 95th/10th percentile of block RMS.
- **Waveform/silence** — min/max peaks per bucket, silence runs below −50 dBFS.

The test suite (`analysis/tests/test_analysis.py`) proves the measurements with synthetic signals:
click tracks at known BPMs, known triads, an energy ramp and a level comparison.

## 5. Song context and prompting

`buildSongContext()` assembles exactly what the model needs (spec §15): artist profile, beat
profile, song metadata, current section, previous sections (truncated and bounded), the artist's
instruction and their current selection. Nothing else is sent. `renderContextForPrompt()` turns it
into compact text, and local metrics (syllables, rhyme groups, flags) are appended so the model and
the editor see the same numbers.

`src/core/prompts.ts` holds the stance prompt (collaborator, never autonomous; never rewrite
silently), per-mode guidance, tier selection (fast / creative / reasoning) and a tolerant parser
for the structured JSON contract — with fallbacks for prose-wrapped JSON, numbered lists and
unstructured answers (which are surfaced honestly rather than dressed up).

The artist's taboo list is **enforced after** the model answers: options containing a taboo phrase
are removed and reported in `cautions`, rather than trusted to the prompt.

## 6. Cost control

| Layer | What happens |
| --- | --- |
| Local, free | syllable/word counts, rhyme keys and groups, repetition, clichés, song health, beat intelligence |
| KV cache | identical context + mode + instruction reuse the stored answer (24 h), and the gateway may cache too |
| Tiering | rhyme/rewrite/simplify → fast; hooks/concepts/contrast → creative; critique/story → reasoning |
| Logging | every call stores provider, model, tokens, cost, latency, cache hit, route and gateway log id |

## 7. Real-time session (SongSessionDO)

One Durable Object per song: autosave revisions, live editor state, participant heartbeats and a
WebSocket fan-out for collaboration. D1 remains the system of record — the DO only owns the
in-flight session, so a restart never loses writing.

## 8. Security boundary

- Secrets (provider keys, R2 keys, session pepper, machine token) live only in Worker secrets.
  The browser talks solely to the Worker.
- Every beat, song, section, version, idea and analysis row is scoped by `user_id`; routes re-check
  ownership on each request (verified live: an anonymous request returns 401).
- Audio is served either through a short-lived signed R2 URL or through an authenticated route;
  the analysis runtime has its own machine token and can only fetch audio for beats that have a job.
- Sessions are 30 days, tokens stored hashed, passwords PBKDF2-SHA256 (100k iterations).
- User audio and lyrics are never used as training data.
