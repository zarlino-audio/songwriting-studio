# Setup and operations

Everything needed to run, deploy and operate the studio on the Zarlino Cloudflare account.

---

## 1. What already exists (created 2026-09-24)

| Resource | Name | Id / notes |
| --- | --- | --- |
| D1 | `songwriting-studio` | `0ec6c770-7b9d-4ecb-808a-f4e410e5d842` (WEUR), schema applied |
| KV | `SONGWRITING_KV` | `a7131623431446d1acf3ab4da4749b04` |
| R2 | `songwriting-beats` | created after R2 was enabled on the account |
| Queues | `songwriting-analysis`, `songwriting-analysis-dlq` | consumer bound in `wrangler.toml` |
| Worker | `zarlino-songwriting-studio` | https://zarlino-songwriting-studio.zarlino001.workers.dev |
| Worker secrets | `DEEPSEEK_API_KEY`, `SESSION_PEPPER`, `ANALYSIS_MACHINE_TOKEN` | set 2026-09-24 |

## 2. Local development

```powershell
npm install
npm --prefix web install
Copy-Item .dev.vars.example .dev.vars    # fill in DEEPSEEK_API_KEY (+ SESSION_PEPPER, ANALYSIS_MACHINE_TOKEN)
npm run db:local                          # apply db/schema.sql to the local D1
npm run analysis:setup                    # python venv for the DSP engine
npm run analysis:serve                    # terminal 2: analysis service on :8788
npm run dev                               # terminal 1: worker + API on :8787
npm run dev:web                           # optional: vite dev server on :5173 (proxies /api)
```

`ANALYSIS_DISPATCH` defaults to `poll` in `wrangler.toml`, so a locally running Worker will also
hand jobs to the polling worker instead of trying to reach `ANALYSIS_URL` — set
`ANALYSIS_DISPATCH = "queue"` if you want the in-process/HTTP path locally.

## 3. Secrets

| Secret | Why | How |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | LLM provider key | `wrangler secret put DEEPSEEK_API_KEY` |
| `SESSION_PEPPER` | mixed into password + session hashes | generate 48 hex chars |
| `ANALYSIS_MACHINE_TOKEN` | lets the polling analysis worker claim jobs | generate 48 hex chars |
| `AI_GATEWAY_TOKEN` | *optional* — Cloudflare API token with AI Gateway permissions | `wrangler secret put AI_GATEWAY_TOKEN` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | *optional* — enables direct browser→R2 uploads and signed playback | R2 → Manage R2 API Tokens → Create API token (Object Read & Write) |

`tools/push-secrets.ps1` pushes everything from `.dev.vars` without printing values:

```powershell
powershell -ExecutionPolicy Bypass -File ./tools/push-secrets.ps1
```

### R2 S3 keys (recommended)

Without them the app still works, but uploads and playback are proxied through the Worker. For
500 MB files you want the direct path:

1. Cloudflare dashboard → R2 → **Manage R2 API Tokens** → Create API token → *Object Read & Write*
   (scoped to `songwriting-beats`).
2. Add `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` to `.dev.vars` and push them.
3. Reload `/api/health`: `r2Signing` should flip to `true`, and `POST /api/beats/upload` starts
   returning `mode: "direct"`.

### AI Gateway (optional but recommended)

The Worker calls AI Gateway first and falls back to the provider directly if the gateway rejects the
request (recorded per request as `meta.route`). To make the gateway path work, create a Cloudflare
API token with **AI Gateway: Run** and set `AI_GATEWAY_TOKEN`. Requests then appear in the gateway's
logs/analytics with caching, while `DEEPSEEK_API_KEY` remains the BYOK key.
## 4. Deploy

Two modes. **Cloud-only is the target:** after step 4B is set up, nothing in production
(analysis included) runs on a workstation, and deploys happen on push.

### 4A. From a machine (dev / break-glass)

```powershell
npm run db:remote      # apply schema changes to production D1
npm run deploy         # build web/ and deploy the Worker
npm run deploy:containers   # ...with the Cloudflare Container analysis runtime (needs Docker)
```

Live checks:

```powershell
powershell -ExecutionPolicy Bypass -File ./tools/smoke.ps1        # 24 end-to-end checks
Invoke-RestMethod https://zarlino-songwriting-studio.zarlino001.workers.dev/api/health
```

### 4B. Cloud-only (no workstation, no Docker) — the current setup

Everything needed to run the product lives in Cloudflare: the Worker serves the app and the API,
the `AnalysisService` container runs the DSP, and Deploys are done either from any machine or by
Workers Builds on push.

**Publish the analysis image without Docker** (image is referenced from the Cloudflare registry, so
deploys never need a Docker engine):

```powershell
powershell -ExecutionPolicy Bypass -File ./tools/publish-image.ps1 -Tag 0.4.0
# then set that reference in wrangler.containers.toml:
# image = "registry.cloudflare.com/<account id>/zarlino-songwriting-analysis:0.4.0"
npm run deploy:containers
```

`tools/publish_container_image.py` does what wrangler does, in Python over HTTPS: pull
`python:3.11-slim` (linux/amd64) from Docker Hub, unpack the `analysis/requirements.txt` wheels into
site-packages plus the app source, mint short-lived registry credentials through the Cloudflare API,
and push blobs + manifest to `registry.cloudflare.com`. Run it with `--dry-run` to build the layer
and print the digests without pushing.

**Optional: let Workers Builds deploy on push** (still no Docker, because the image is a registry
reference rather than a Dockerfile path):

1. **Workers & Pages → zarlino-songwriting-studio → Settings → Builds → Connect**
2. Authorise GitHub, pick `zarlino-audio/songwriting-studio`, production branch `main`
3. Set **Deploy command** to `npm run deploy:containers` (default build command `npm ci` is correct —
   `prebuild:web` installs `web/`'s dependencies)

Switching `image` back to `./analysis/Dockerfile` makes wrangler build the image itself, which needs
Docker on whichever machine (or build environment) runs the deploy — Workers Builds can do that too,
but nothing else here does.

Verify from anywhere:

```powershell
npx wrangler containers list                            # status per container application
npx wrangler containers images list                     # published tags
npx wrangler tail --config wrangler.containers.toml     # live Worker/container logs
node tools/smoke.mjs --url https://zarlino-songwriting-studio.zarlino001.workers.dev --wait 240
```

**What is cloud-only:**

| Piece | Runs where | Why it is independent |
| --- | --- | --- |
| Web app + API | Worker (assets + routes) | serverless |
| Analysis DSP | `AnalysisService` container | image in the Cloudflare registry, `standard-1` instance |
| Queue, DB, KV, R2 | Queues / D1 / KV / R2 | serverless |
| Image build | anywhere (Python, no Docker) | `tools/publish-image.ps1` |
| Deploys | any machine, or push to `main` with Workers Builds | no Docker, no workstation runtime |

The polling worker (`npm run analysis:worker`) stays in the repo as a development tool and a
fallback runtime, but production does not need it: with `ANALYSIS_DISPATCH=queue` and
`ANALYSIS_MODE=container`, jobs go R2 → Queue → container → D1.

Rollback from anywhere: `npx wrangler rollback` (previous Worker version) or
`npx wrangler deploy --config wrangler.containers.toml --containers-rollout=none` (Worker-only).

## 5. Running real analysis

Three placements, one engine (`analysis/app/analysis`):

### A. Polling worker (works today, no Docker)

```powershell
$env:ANALYSIS_API_URL = "https://zarlino-songwriting-studio.zarlino001.workers.dev"
$env:ANALYSIS_MACHINE_TOKEN = "<from .dev.vars>"
npm run analysis:worker          # add --once to process a single job
```

The worker claims queued jobs, pulls the audio (signed URL or the machine audio route), runs the
DSP, and submits the profile. Start it with a Startup shortcut or Task Scheduler entry to keep it
running like the executive daemon.

### B. HTTP service on a VM (the RDP box, a small VPS, …)

```powershell
npm run analysis:serve -- -Port 8788 -Secret "<shared secret>"
```

Then set `ANALYSIS_DISPATCH = "queue"`, `ANALYSIS_MODE = "http"`, `ANALYSIS_URL = "https://<host>:8788"`
and `ANALYSIS_SHARED_SECRET` on the Worker. The service needs to be reachable from Cloudflare and
protected by the shared secret.

### C. Cloudflare Container (what the product is designed for)

Requires a Workers Paid plan, plus **one** of these two build paths:

**C1 — build locally (Docker Desktop running):**

```powershell
docker info                    # must succeed before deploying
npm run deploy:containers      # wrangler deploy --config wrangler.containers.toml
wrangler containers list       # check status; first provisioning takes a few minutes
```

Wrangler builds the image from `analysis/Dockerfile` and pushes it, so Docker must be running on the
machine that deploys (the image builds for `linux/amd64`). Windows needs hardware virtualization
enabled in firmware for the Docker engine to start — check `systeminfo` for
`Virtualization Enabled In Firmware: Yes`.

**C2 — build in the cloud (no Docker anywhere):**

Connect the GitHub repo to the Worker once in the dashboard (**Workers & Pages → the Worker →
Settings → Builds → Connect**), and set the **Deploy command** to `npm run deploy:containers`.
Workers Builds runs Dockerfile builds in its own environment, so pushes to `main` publish the image
and roll out the container. Keep the production branch deploy as a full `wrangler deploy` —
`wrangler versions upload` does not publish images.

**Worker-only deploy without Docker** (useful when the image is not ready yet):

```powershell
npx wrangler deploy --config wrangler.containers.toml --containers-rollout=none
```

That publishes Worker code only; the container keeps running its previous image.

`wrangler.containers.toml` binds `AnalysisService` (`instance_type = "standard-1"`, `sleepAfter`
10 min) and sets `ANALYSIS_MODE=container`, `ANALYSIS_DISPATCH=queue`. Two fields are easy to get
wrong: `image` must be the **Dockerfile path** (`./analysis/Dockerfile`, not the directory) and
`main` must be **`src/container-entry.ts`** — the only entrypoint that exports the container class.
The container uses PyAV (FFmpeg wheels) so it needs no system FFmpeg; locally the same code uses the
`imageio-ffmpeg` binary because PyAV has no Windows/Python 3.11 wheel.

Validate the config without deploying:

```powershell
npx wrangler deploy --dry-run --config wrangler.containers.toml --outdir $env:TEMP\swsdry
```

## 6. Operations

- **Logs**: `npm run tail` (Worker), `wrangler tail --config wrangler.containers.toml` for the
  container deployment, and the polling worker's console output.
- **Stuck jobs**: `POST /api/analysis/requeue-stale` (machine token) returns `running` jobs older
  than 30 minutes to `queued`.
- **Health**: `GET /api/health` reports database, KV, R2 binding + signing, queue binding, AI key,
  analysis mode/detail and hints for anything missing. `/api/observability/overview` reports
  product counters (Songs Finished, suggestions kept, AI spend).
- **Costs**: every AI row in `ai_requests` carries tokens, cost, latency, cache flag and route.
  `npm run db:query:remote -- "SELECT mode, COUNT(*), SUM(cost_usd) FROM ai_requests GROUP BY mode"`.

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `503 Beat storage is not available yet` | R2 not enabled on the account, or the bucket is missing |
| Upload returns `mode: "proxy"` although R2 keys were set | keys not pushed to the Worker (`r2Signing` in `/api/health` shows which) |
| Beat stuck in `ANALYZING` | no analysis runtime is claiming jobs: start `npm run analysis:worker` (poll mode) or check the service/container |
| `AI provider error 401 … AiGatewayError` | gateway requires auth — set `AI_GATEWAY_TOKEN`, or leave it unset and the Worker uses the provider directly |
| `409 That email is already registered` | the smoke test reuses `--email`; pass a new one |
| PowerShell helper parse errors | keep every `.ps1` pure ASCII: Windows PowerShell 5.1 reads files as ANSI and an em dash swallows the closing quote |
| `wrangler deploy` "fetch failed" | transient; re-run it (bindings and secrets are unaffected) |
| `wrangler deploy --config wrangler.containers.toml` fails: "The Docker CLI is needed to build the configured image" | `image` in that config points at a Dockerfile. Either give Docker to the machine that deploys, or publish the image first (`tools/publish-image.ps1`) and reference it as `registry.cloudflare.com/...` — registry references need no Docker |
| Docker Desktop installs but the engine will not start | firmware virtualization is off: `systeminfo` must report `Virtualization Enabled In Firmware: Yes` (a remote VM needs nested virtualization from the host) |

## 8. Known gaps (deliberate, next steps)

- **Multipart upload** for files > 500 MB is not wired yet (a single presigned PUT covers up to
  5 GiB); the schema already carries upload-session kinds for it.
- **PDF/DOCX export** is not implemented yet (TXT + JSON are).
- **Voice notes / ASR / humming analysis** are v1.5–v2 per the spec and are not built.
- **Vectorize** semantic memory is not in use yet; the artist profile + judged feedback are the
  retrieval sources today.
- Container image publishing needs either local Docker (engine requires firmware virtualization) or
the Workers Builds connection (C2). Until one of those is in place the analysis runtime runs as the
polling worker — the same Python engine, verified by the DSP tests and the live smoke test.
