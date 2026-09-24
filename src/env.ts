/**
 * Worker bindings + configuration.
 *
 * Secrets are optional in the type so the Worker can boot (and report honestly
 * via /api/health) before every secret is configured; each integration checks
 * for its own credentials and degrades with a clear error instead of crashing.
 */
export interface Env {
  // --- Bindings -------------------------------------------------------------
  DB: D1Database;
  KV: KVNamespace;
  BEATS: R2Bucket | undefined;
  ANALYSIS_QUEUE: Queue<AnalysisJobMessage> | undefined;
  SONG_SESSION: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Present only in the container deployment (wrangler.containers.toml). */
  ANALYSIS?: DurableObjectNamespace;

  // --- Secrets --------------------------------------------------------------
  DEEPSEEK_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  SESSION_PEPPER?: string;
  ANALYSIS_SHARED_SECRET?: string;
  /** Bearer token the local analysis worker uses against /api/analysis/*. */
  ANALYSIS_MACHINE_TOKEN?: string;

  // --- Vars -----------------------------------------------------------------
  ENVIRONMENT: string;
  CF_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_S3_ENDPOINT: string;
  AI_GATEWAY_ENABLED: string;
  AI_GATEWAY_ID: string;
  AI_PROVIDER: string;
  AI_MODEL_FAST: string;
  AI_MODEL_CREATIVE: string;
  AI_MODEL_REASONING: string;
  ANALYSIS_MODE: string;
  ANALYSIS_DISPATCH: string;
  ANALYSIS_URL: string;
  UPLOAD_MAX_BYTES: string;
  ALLOWED_ORIGINS: string;
}

export interface AnalysisJobMessage {
  jobId: string;
  beatId: string;
  userId: string;
  r2Key: string;
  enqueuedAt: string;
}

export type AnalysisMode = "http" | "container" | "stub";

/**
 * How a queued analysis job reaches a runtime:
 *   queue - the Cloudflare Queue consumer calls the runtime (container or service)
 *   poll  - jobs wait in D1 and the local analysis worker claims them (npm run analysis:worker)
 */
export type AnalysisDispatch = "queue" | "poll";

export function analysisDispatch(env: Env): AnalysisDispatch {
  return (env.ANALYSIS_DISPATCH || "queue").toLowerCase() === "poll" ? "poll" : "queue";
}

export function analysisMode(env: Env): AnalysisMode {
  const mode = (env.ANALYSIS_MODE || "stub").toLowerCase();
  if (mode === "http" || mode === "container") return mode;
  return "stub";
}

export function uploadMaxBytes(env: Env): number {
  const n = Number(env.UPLOAD_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 524_288_000;
}

export function aiGatewayEnabled(env: Env): boolean {
  return (env.AI_GATEWAY_ENABLED || "").toLowerCase() !== "false" && Boolean(env.AI_GATEWAY_ID);
}

export function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
