# Audio analysis runtime

Python service that turns a beat into a **Beat Profile** (BPM, key, chords, sections, energy,
loudness, waveform) — the musical evidence every songwriting suggestion is built on.

The same engine runs in three places:

| Placement | How | When to use |
| --- | --- | --- |
| Cloudflare Container | `tools/publish-image.ps1 -Tag <v>` then `npm run deploy:containers` | the live deployment (no Docker needed) |
| HTTP service | `npm run analysis:serve` | a VM / the RDP box |
| Polling worker | `npm run analysis:worker` | a workstation, no Docker required |

## Layout

```
app/
  analysis/
    io.py         audio decoding (PyAV, or the FFmpeg CLI binary)
    features.py   the DSP: tempo, beats, downbeats, chroma, key, chords, sections,
                  energy, LUFS, dynamic range, waveform, silence
    __init__.py
  server.py       HTTP API: GET /health, POST /analyze
  worker.py       polling worker: claim → analyse → submit  synth.py        synthetic beats with known ground truth (used by probe and tests)
  probe.py        python -m app.probe [--verbose] [--roundtrip]
  diagnose.py     python -m app.diagnose <file>  (why the engine believes what it believes)  analyze_file.py CLI: python -m app.analyze_file beat.wav
Dockerfile        container image (python:3.11-slim + numpy/scipy/PyAV)
requirements.txt  container deps (PyAV ships FFmpeg)
requirements-dev.txt  local deps (imageio-ffmpeg instead of PyAV on Windows)
tests/            synthetic-signal tests for the DSP
```

## Setup

```bash
npm run analysis:setup    # creates analysis/.venv and installs the right deps
npm run analysis:test     # 19 tests: known BPM, known keys/chords, regressions, loudness, grid
npm run analysis:serve    # HTTP service on 127.0.0.1:8788
```

## How the estimates are made

The engine runs **two STFT resolutions** because the two jobs need different trade-offs:

| Pass | Frame / hop | Feeds |
| --- | --- | --- |
| fast | 2048 / 512 (~23 ms) | onsets, tempo, beat grid, rhythm, energy |
| fine | 8192 / 2048 (~2.7 Hz bins) | chroma, bass chroma, bass roots, key |

A 2048-point FFT cannot separate Ab (207.7 Hz) from A (220 Hz), so a minor pad used to leak into the
major-third bin and flip the key to its relative major. Three decisions follow from that and from
real beats that were reported wrong:

1. **Pitch-class energy is a density, not a bin count.** Bins are weighted by their share of a
   semitone, because at 2.7 Hz bins a semitone near 100 Hz spans 4 bins and one near 2 kHz spans
   50 — a plain sum lets hats and snare noise swamp the tonal content and flattens every pitch
   class to ~8%. The chroma is also capped at 1.2 kHz: percussion above that carries no key.
2. **Only fundamentals vote, and only sustained low notes vote.** Folding odd harmonics without
   proving the fundamental exists manufactures notes nobody played (F's 5th harmonic read as A and
   G's 3rd as D, which is how a minor beat became major). Kick frames are excluded from the bass
   root histogram — a 55 Hz thump is A no matter what the bass plays.
3. **The mode is decided from aggregated third evidence**, not from one correlation: the key-profile
   difference, the full chroma, the bass chroma and the kick-free root histogram all vote on the
   third above the tonic. Relative major/minor is genuinely close on some beats, and when it stays
   close the profile says so through `key_confidence` and `warnings`.

Tempo does not come from the strongest autocorrelation peak either — that peak is happily a 5:4
subharmonic (a 95 BPM beat read as 76 BPM). Every candidate *and its musical relatives* is scored on
grid salience, regularity, coverage and a tempo prior, and the winner is then refined against a fine
pulse lattice over the whole file, which is what gets 94.0 down to 93.95 instead of 95.0. Octave
ambiguity is still reported rather than guessed: when the double or half scores nearly as well, the
profile carries a warning naming the alternative.

Measured on the beats that exposed the bugs (synthetic ground truth first, then real files):

| Beat | Before | After | Truth |
| --- | --- | --- | --- |
| Afro R&B type beat | 76.00 BPM, F major | 95.01 BPM, F minor | F minor, ~94 BPM |
| Highlife groove (live percussion) | n/a | 65.62 BPM, A minor (+ octave warning) | ambiguous by design |
| Click track @ 104 | 103.36 BPM | 103.92 BPM | 104 |
| Synthetic 94/104/76/140 | — | within 0.05 BPM, 5/5 keys | exact |

`python -m app.probe` prints that synthetic table; `python -m app.diagnose <file>` prints the evidence
behind a real file's numbers (chroma rows, root histogram, tempo families, drift).

## HTTP contract

```
GET  /health
  -> { ok, engine, version, max_seconds, auth_required }

POST /analyze
  body: { "beat_id": "beat_x", "audio_url": "<signed R2 URL>" }
        (or raw audio bytes with a content-type other than application/json)
  headers: x-analysis-key: <ANALYSIS_SHARED_SECRET>   (when configured)
  -> { "profile": { …Beat Profile… }, "engine": "zarlino-analysis", "engine_version": "0.1.0" }
```

## Decoders

- **PyAV** (`av`) — used in the container; ships FFmpeg's demuxers/decoders as wheels.
- **FFmpeg CLI** (`imageio-ffmpeg`, or `ffmpeg` on PATH, or `FFMPEG_BINARY`) — used on platforms
  without a PyAV wheel (Windows + Python 3.11 builds from source and needs FFmpeg headers).

`decode()` prefers PyAV, retries with the CLI when a file path was given, and reports which backend
it used. Both paths normalise to 22.05 kHz mono float32 for analysis while preserving the original
sample rate and channel count in the profile.

## Honesty rules encoded in the engine

- Estimates carry confidence values; anything weak is added to `warnings` rather than hidden.
- `estimate_key` reports the margin over the runner-up key, not a made-up certainty.
- Sections are labelled heuristically from position and relative energy; confidence is capped at
  0.75 because that is what the method supports.
- The stub engine (`ANALYSIS_MODE=stub`) exists only so the app can run without a runtime — it
  labels its own output as a stub in `warnings`.
