import { Store, parseJsonArray } from "../db/store";
import { HttpError, json, readJson, type RouteContext, type Router } from "../http";
import { analysisHealth } from "../integrations/analysis";
import { aiStatus } from "../integrations/ai";
import { r2BucketAvailable, r2SigningConfigured } from "../core/storage";
import { nowIso } from "../util/ids";
import { requireUserId } from "./auth";
import type { Env } from "../env";

function mapProfile(row: {
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
} | null) {
  return {
    languages: parseJsonArray(row?.languages_json),
    style: row?.style ?? null,
    perspective: row?.perspective ?? null,
    themes: parseJsonArray(row?.themes_json),
    vocabulary: parseJsonArray(row?.vocabulary_json),
    phrases: parseJsonArray(row?.phrases_json),
    imagery: parseJsonArray(row?.imagery_json),
    taboo: parseJsonArray(row?.taboo_json),
    rhymePreference: row?.rhyme_preference ?? null,
    sentenceLength: row?.sentence_length ?? null,
    structurePrefs: parseJsonArray(row?.structure_prefs_json),
    writingSamples: parseJsonArray(row?.writing_samples_json),
    updatedAt: row?.updated_at ?? null,
  };
}

function stringArray(value: unknown, max = 60): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** Artist Voice System (spec §18) — retrieval + preferences, never fine-tuning. */
export function registerProfileRoutes(router: Router): void {
  router.get("/api/profile", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const row = await store.getProfile(userId);
    return json({ profile: mapProfile(row) });
  });

  router.put("/api/profile", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const existing = await store.getProfile(userId);
    const body = await readJson<Record<string, unknown>>(ctx.req);

    const merged = {
      user_id: userId,
      languages_json: body["languages"] !== undefined ? JSON.stringify(stringArray(body["languages"], 20)) : existing?.languages_json ?? "[]",
      style: body["style"] !== undefined ? (typeof body["style"] === "string" ? body["style"].slice(0, 200) : null) : existing?.style ?? null,
      perspective:
        body["perspective"] !== undefined
          ? typeof body["perspective"] === "string"
            ? body["perspective"].slice(0, 200)
            : null
          : existing?.perspective ?? null,
      themes_json: body["themes"] !== undefined ? JSON.stringify(stringArray(body["themes"], 40)) : existing?.themes_json ?? "[]",
      vocabulary_json:
        body["vocabulary"] !== undefined ? JSON.stringify(stringArray(body["vocabulary"], 80)) : existing?.vocabulary_json ?? "[]",
      phrases_json: body["phrases"] !== undefined ? JSON.stringify(stringArray(body["phrases"], 60)) : existing?.phrases_json ?? "[]",
      imagery_json: body["imagery"] !== undefined ? JSON.stringify(stringArray(body["imagery"], 60)) : existing?.imagery_json ?? "[]",
      taboo_json: body["taboo"] !== undefined ? JSON.stringify(stringArray(body["taboo"], 40)) : existing?.taboo_json ?? "[]",
      rhyme_preference:
        body["rhymePreference"] !== undefined
          ? typeof body["rhymePreference"] === "string"
            ? body["rhymePreference"].slice(0, 120)
            : null
          : existing?.rhyme_preference ?? null,
      sentence_length:
        body["sentenceLength"] !== undefined
          ? typeof body["sentenceLength"] === "string"
            ? body["sentenceLength"].slice(0, 120)
            : null
          : existing?.sentence_length ?? null,
      structure_prefs_json:
        body["structurePrefs"] !== undefined
          ? JSON.stringify(stringArray(body["structurePrefs"], 20))
          : existing?.structure_prefs_json ?? "[]",
      writing_samples_json:
        body["writingSamples"] !== undefined
          ? JSON.stringify(stringArray(body["writingSamples"], 20))
          : existing?.writing_samples_json ?? "[]",
      updated_at: nowIso(),
    };

    await store.upsertProfile(merged);
    await store.recordEvent("artist_profile_updated", userId, {});
    return json({ profile: mapProfile({ ...merged, updated_at: merged.updated_at }) });
  });

  /**
   * Observability (spec §54–55). The headline number is Songs Finished —
   * never messages or tokens.
   */
  router.get("/api/observability/overview", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const counts = await store.countsByEvent(userId, since);
    const songs = await store.listSongs(userId, 200);
    const beats = await store.listBeats(userId, 200);
    const byName = new Map(counts.map((entry) => [entry.name, entry.count]));

    const completed = songs.filter((song) => song.status === "complete").length;
    const requests = await store.listRecentAiRequests(userId, 100);
    const withFeedback = requests.length;

    return json({
      window: "30d",
      songsStarted: songs.length,
      songsCompleted: completed,
      completionRate: songs.length > 0 ? Math.round((completed / songs.length) * 100) / 100 : 0,
      beatsUploaded: byName.get("upload_success") ?? beats.length,
      aiRequests: withFeedback,
      suggestionsGenerated: byName.get("suggestion_generated") ?? 0,
      suggestionsAccepted: byName.get("suggestion_accepted") ?? 0,
      suggestionsRejected: byName.get("suggestion_rejected") ?? 0,
      exports: byName.get("song_exported") ?? 0,
      aiSpendUsd: Math.round(requests.reduce((sum, row) => sum + row.cost_usd, 0) * 10_000) / 10_000,
      events: counts,
    });
  });

  /** Configuration health, so a broken deployment is obvious (spec §53). */
  router.get("/api/health", async (ctx) => {
    const env: Env = ctx.env;
    const store = new Store(env.DB);
    let tables = 0;
    let dbOk = true;
    try {
      tables = await store.tableCount();
    } catch {
      dbOk = false;
    }
    const analysis = await analysisHealth(env);
    const ai = aiStatus(env);

    const checks = {
      database: dbOk && tables >= 10,
      kv: true,
      r2Binding: r2BucketAvailable(env),
      r2Signing: r2SigningConfigured(env),
      queue: Boolean(env.ANALYSIS_QUEUE),
      aiKey: ai.keyPresent,
      analysisRuntime: analysis.ok,
    };
    const ok = checks.database && checks.aiKey;

    return json({
      ok,
      environment: env.ENVIRONMENT,
      time: nowIso(),
      checks,
      tables,
      analysis: { mode: analysis.mode, detail: analysis.detail },
      ai: { provider: ai.provider, gatewayEnabled: ai.gatewayEnabled, models: ai.models },
      hints: buildHints(checks, analysis.detail),
    });
  });
}

function buildHints(checks: Record<string, boolean>, analysisDetail: string): string[] {
  const hints: string[] = [];
  if (!checks["r2Binding"]) hints.push("R2 bucket binding missing — enable R2 on the Cloudflare account and create the bucket.");
  if (!checks["r2Signing"]) hints.push("R2 S3 keys not set — uploads/playback fall back to proxying through the Worker.");
  if (!checks["queue"]) hints.push("Analysis queue binding missing — analysis runs inline.");
  if (!checks["aiKey"]) hints.push("AI provider key missing — set DEEPSEEK_API_KEY with `wrangler secret put`.");
  if (!checks["analysisRuntime"]) hints.push(`Analysis runtime not reachable: ${analysisDetail}`);
  if (!checks["database"]) hints.push("Database schema missing — run `npm run db:remote`.");
  return hints;
}

/** Bound dependency injection for tests: routes never import the store class directly. */
export function makeRouteContext(partial: Partial<RouteContext> & { env: Env }): RouteContext {
  const url = partial.url ?? new URL("https://example.com/");
  return {
    req: partial.req ?? new Request(url),
    env: partial.env,
    url,
    params: partial.params ?? {},
    userId: partial.userId,
    waitUntil: partial.waitUntil ?? (() => undefined),
  };
}

export const __testing = { HttpError };
