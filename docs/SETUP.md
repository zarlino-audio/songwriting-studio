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

```powershell
npm run db:remote      # apply schema changes to production D1
npm run deploy         # build web/ and deploy the Worker
```

Live checks:

```powershell
powershell -ExecutionPolicy Bypass -File ./tools/smoke.ps1        # 24 end-to-end checks
Invoke-RestMethod https://zarlino-songwriting-studio.zarlino001.workers.dev/api/health
```

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

Requires **Docker running locally** (wrangler builds and pushes the image) and a Workers Paid plan.

```powershell
npm run deploy:containers      # wrangler deploy --config wrangler.containers.toml
wrangler containers list       # check status; first provisioning takes a few minutes
```

`wrangler.containers.toml` binds `AnalysisService` (`instance_type = "standard-1"`, `sleepAfter`
10 min) and sets `ANALYSIS_MODE=container`, `ANALYSIS_DISPATCH=queue`. The container uses PyAV
(FFmpeg wheels) so it needs no system FFmpeg; locally the same code uses the `imageio-ffmpeg`
binary because PyAV has no Windows/Python 3.11 wheel.

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

## 8. Known gaps (deliberate, next steps)

- **Multipart upload** for files > 500 MB is not wired yet (a single presigned PUT covers up to
  5 GiB); the schema already carries upload-session kinds for it.
- **PDF/DOCX export** is not implemented yet (TXT + JSON are).
- **Voice notes / ASR / humming analysis** are v1.5–v2 per the spec and are not built.
- **Vectorize** semantic memory is not in use yet; the artist profile + judged feedback are the
  retrieval sources today.
- The container image has not been built on this machine (Docker is not installed) — the Python
  engine it will run is the same one verified by the DSP tests and the live smoke test.
