import { Store } from "../db/store";
import { HttpError, json, readJson, type RouteContext, type Router } from "../http";
import { signedAudioUrl, streamObject } from "../core/storage";
import { storeAnalysisResult } from "../analysis/consumer";
import { nowIso } from "../util/ids";
import type { AnalysisJobMessage } from "../env";

/**
 * Machine-to-machine endpoints for a polling analysis worker (npm run analysis:worker).
 *
 * This is how a real DSP runtime runs TODAY without Docker: the local worker
 * claims a job, analyses the beat with the same Python engine the container
 * uses, and posts the profile back. Auth is a dedicated machine token, not a
 * user session — a worker must never be able to read songs.
 */
function requireMachine(ctx: RouteContext): void {
  const expected = ctx.env.ANALYSIS_MACHINE_TOKEN;
  if (!expected) {
    throw new HttpError(503, "Analysis machine token is not configured on this deployment");
  }
  const header = ctx.req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token || token !== expected) throw new HttpError(401, "Invalid analysis machine token");
}

export function registerAnalysisRoutes(router: Router): void {
  /** Claim the oldest queued analysis job (atomic). */
  router.post("/api/analysis/claim", async (ctx) => {
    requireMachine(ctx);
    const store = new Store(ctx.env.DB);

    const claimed = await ctx.env.DB.prepare(
      `UPDATE analysis_jobs
          SET status = 'running', started_at = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = (
          SELECT id FROM analysis_jobs
           WHERE status = 'queued'
           ORDER BY created_at ASC
           LIMIT 1
        )
        RETURNING *`,
    )
      .bind(nowIso(), nowIso())
      .first<{ id: string; beat_id: string; user_id: string }>();

    if (!claimed) return json({ job: null });

    const beat = await store.getBeat(claimed.beat_id, claimed.user_id);
    if (!beat) {
      await store.finishJob(claimed.id, "failed", "Beat no longer exists");
      return json({ job: null });
    }

    const audioUrl = await signedAudioUrl(ctx.env, beat.r2_key, 3600);
    await store.recordEvent("analysis_claimed", claimed.user_id, { beatId: beat.id, jobId: claimed.id });

    return json({
      job: {
        id: claimed.id,
        beatId: beat.id,
        title: beat.title,
        r2Key: beat.r2_key,
        mimeType: beat.mime_type,
        // Null when R2 S3 keys are not configured — the caller may fetch the
        // audio from /api/beats/:id/audio with the machine token instead.
        audioUrl,
      },
      workerUrl: ctx.url.origin,
    });
  });

  /** Submit a finished profile. */
  router.post("/api/analysis/submit", async (ctx) => {
    requireMachine(ctx);
    const store = new Store(ctx.env.DB);
    const body = await readJson<{
      jobId?: string;
      profile?: unknown;
      engine?: string;
      engineVersion?: string;
      error?: string;
    }>(ctx.req);

    if (!body.jobId) throw new HttpError(400, "jobId is required");
    const job = await store.getAnalysisJob(body.jobId);
    if (!job) throw new HttpError(404, "Job not found");

    const message: AnalysisJobMessage = {
      jobId: job.id,
      beatId: job.beat_id,
      userId: job.user_id,
      r2Key: "",
      enqueuedAt: job.created_at,
    };

    if (body.error) {
      await store.finishJob(job.id, "failed", body.error);
      await store.updateBeat(job.beat_id, job.user_id, { status: "FAILED", error: body.error });
      await store.recordEvent("analysis_failed", job.user_id, { beatId: job.beat_id, jobId: job.id, error: body.error });
      return json({ ok: true, status: "failed" });
    }

    if (!body.profile) throw new HttpError(400, "profile is required");

    const started = Date.now();
    const profile = await storeAnalysisResult(
      ctx.env,
      store,
      message,
      body.profile,
      body.engine ?? "zarlino-analysis",
      body.engineVersion ?? "",
    );
    await store.finishJob(job.id, "done", null);
    await store.recordEvent("analysis_completed", job.user_id, {
      beatId: job.beat_id,
      jobId: job.id,
      engine: body.engine ?? profile.engine,
      source: "poll-worker",
      durationMs: Date.now() - started,
    });

    return json({ ok: true, status: "done", bpm: profile.bpm, key: profile.key });
  });

  /** Audio for a claimed job. A machine token must not be able to browse beats,
   *  so this route only serves beats that have an analysis job attached. */
  router.get("/api/analysis/beat-audio/:beatId", async (ctx) => {
    requireMachine(ctx);
    const beatId = ctx.params["beatId"] ?? "";
    const store = new Store(ctx.env.DB);
    const job = await store.latestJobForBeat(beatId);
    if (!job) throw new HttpError(404, "No analysis job for that beat");
    const beat = await store.getBeat(beatId, job.user_id);
    if (!beat) throw new HttpError(404, "Beat not found");
    return streamObject(ctx.env, beat.r2_key, ctx.req.headers.get("range"));
  });

  /** Requeue jobs whose worker died mid-analysis (called from the ops path). */
  router.post("/api/analysis/requeue-stale", async (ctx) => {
    requireMachine(ctx);
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const result = await ctx.env.DB.prepare(
      `UPDATE analysis_jobs SET status = 'queued', error = 'Requeued: worker lease expired', updated_at = ?
        WHERE status = 'running' AND (started_at IS NULL OR started_at < ?)`,
    )
      .bind(nowIso(), cutoff)
      .run();
    return json({ ok: true, requeued: result.meta?.changes ?? 0 });
  });
}
