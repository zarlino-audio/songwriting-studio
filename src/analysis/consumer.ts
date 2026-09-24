import type { AnalysisJobMessage, Env } from "../env";
import { Store } from "../db/store";
import { AnalysisUnavailableError, normalizeProfile, requestAnalysis } from "../integrations/analysis";
import { describeBeat } from "../core/beatIntel";
import { signedAudioUrl } from "../core/storage";
import { nowIso } from "../util/ids";
import type { BeatProfile } from "../types";

/**
 * Analysis pipeline (spec §5 / §35): R2 object -> analysis runtime -> beat profile.
 *
 * `storeAnalysisResult` is the single place a profile is committed, shared by the
 * queue consumer, the container/service runtime and the polling analysis worker.
 * Transient failures (runtime unreachable) are retried with backoff; permanent
 * ones mark the beat FAILED so the artist sees the truth instead of a spinner.
 */
export async function storeAnalysisResult(
  env: Env,
  store: Store,
  job: AnalysisJobMessage,
  rawProfile: unknown,
  engine: string,
  engineVersion: string,
): Promise<BeatProfile> {
  const { profile } = normalizeProfile(rawProfile);
  const beat = await store.getBeat(job.beatId, job.userId);
  const title = beat?.title ?? "Beat";

  await store.upsertAnalysis({
    beat_id: job.beatId,
    user_id: job.userId,
    profile_json: JSON.stringify(profile),
    engine: engine || profile.engine,
    engine_version: engineVersion || profile.engine_version,
    source: "analysis",
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  await store.updateBeat(job.beatId, job.userId, {
    status: "READY",
    duration_seconds: profile.duration_seconds,
    error: null,
  });

  // Cache the interpretation so list/detail reads are cheap (spec §36).
  const intelligence = describeBeat(profile, title);
  await env.KV.put(`beat:intel:${job.beatId}`, JSON.stringify(intelligence), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  return profile;
}

export async function runAnalysisJob(
  env: Env,
  store: Store,
  job: AnalysisJobMessage,
  attempt = 1,
): Promise<void> {
  try {
    await store.markJobRunning(job.jobId);
    await store.recordEvent("analysis_started", job.userId, { beatId: job.beatId, jobId: job.jobId });

    const audioUrl = await signedAudioUrl(env, job.r2Key, 3600);
    const started = Date.now();
    const result = await requestAnalysis(env, { beatId: job.beatId, audioUrl });
    const durationMs = Date.now() - started;

    await storeAnalysisResult(env, store, job, result.profile, result.engine, result.engineVersion);
    await store.finishJob(job.jobId, "done", null);
    await store.recordEvent("analysis_completed", job.userId, {
      beatId: job.beatId,
      jobId: job.jobId,
      engine: result.engine,
      durationMs,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const transient = error instanceof AnalysisUnavailableError;

    if (transient && attempt < 3) {
      await store.recordEvent("analysis_retry", job.userId, { beatId: job.beatId, attempt });
      throw error; // the caller decides on backoff
    }

    await store.finishJob(job.jobId, "failed", detail);
    await store.updateBeat(job.beatId, job.userId, { status: "FAILED", error: detail });
    await store.recordEvent("analysis_failed", job.userId, {
      beatId: job.beatId,
      jobId: job.jobId,
      error: detail,
    });
  }
}

/** Cloudflare Queue consumer for analysis jobs. */
export async function handleAnalysisBatch(
  batch: MessageBatch<AnalysisJobMessage>,
  env: Env,
): Promise<void> {
  const store = new Store(env.DB);
  for (const message of batch.messages) {
    try {
      await runAnalysisJob(env, store, message.body, message.attempts);
      message.ack();
    } catch {
      if (message.attempts < 3) message.retry({ delaySeconds: 20 * Math.max(1, message.attempts) });
      else message.ack();
    }
  }
}
