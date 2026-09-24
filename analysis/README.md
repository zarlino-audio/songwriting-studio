# Audio analysis runtime

Python service that turns a beat into a **Beat Profile** (BPM, key, chords, sections, energy,
loudness, waveform) — the musical evidence every songwriting suggestion is built on.

The same engine runs in three places:

| Placement | How | When to use |
| --- | --- | --- |
| Cloudflare Container | `npm run deploy:containers` (needs Docker) | the target deployment |
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
  worker.py       polling worker: claim → analyse → submit
  analyze_file.py CLI: python -m app.analyze_file beat.wav
Dockerfile        container image (python:3.11-slim + numpy/scipy/PyAV)
requirements.txt  container deps (PyAV ships FFmpeg)
requirements-dev.txt  local deps (imageio-ffmpeg instead of PyAV on Windows)
tests/            synthetic-signal tests for the DSP
```

## Setup

```bash
npm run analysis:setup    # creates analysis/.venv and installs the right deps
npm run analysis:test     # 7 tests: known BPM, known triads, energy ramp, loudness, grid
npm run analysis:serve    # HTTP service on 127.0.0.1:8788
```

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
