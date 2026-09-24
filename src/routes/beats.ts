import { uploadMaxBytes, analysisDispatch, type AnalysisJobMessage } from "../env";
import { Store } from "../db/store";
import {
  HttpError,
  json,
  noContent,
  optionalString,
  readJson,
  requireString,
  type RouteContext,
  type Router,
} from "../http";
import { r2KeyFor } from "../core/sigv4";
import {
  deleteObject,
  headObject,
  r2BucketAvailable,
  r2SigningConfigured,
  signedAudioUrl,
  signedUploadUrl,
  streamObject,
} from "../core/storage";
import { describeBeat } from "../core/beatIntel";
import { mergeProfile, type ProfilePatch } from "../core/profileEdit";
import { runAnalysisJob } from "../analysis/consumer";
import { id, nowIso } from "../util/ids";
import type { BeatProfile } from "../types";
import { requireUserId } from "./auth";

const MAX_TITLE = 200;

function profileFrom(json_: string | undefined | null): BeatProfile | null {
  if (!json_) return null;
  try {
    return JSON.parse(json_) as BeatProfile;
  } catch {
    return null;
  }
}

/** Compact shape for list views — never ship the whole profile in a list. */
function beatSummary(beat: {
  id: string;
  title: string;
  status: string;
  created_at: string;
  duration_seconds: number | null;
  original_filename: string | null;
  error: string | null;
}): Record<string, unknown> {
  return {
    id: beat.id,
    title: beat.title,
    status: beat.status,
    createdAt: beat.created_at,
    durationSeconds: beat.duration_seconds,
    originalFilename: beat.original_filename,
    error: beat.error,
  };
}

async function enqueueAnalysis(
  ctx: RouteContext,
  store: Store,
  beat: { id: string; user_id: string; r2_key: string; title: string },
): Promise<string> {
  const jobId = id("job");
  await store.createAnalysisJob({
    id: jobId,
    beat_id: beat.id,
    user_id: beat.user_id,
    status: "queued",
    attempts: 0,
    error: null,
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    updated_at: nowIso(),
  });
  await store.updateBeat(beat.id, beat.user_id, { status: "ANALYZING", error: null });

  const message: AnalysisJobMessage = {
    jobId,
    beatId: beat.id,
    userId: beat.user_id,
    r2Key: beat.r2_key,
    enqueuedAt: nowIso(),
  };

  const dispatch = analysisDispatch(ctx.env);
  if (dispatch === "poll") {
    // The job waits in D1 for the analysis worker (npm run analysis:worker) —
    // used when the runtime lives on a machine this Worker cannot reach.
    return jobId;
  }

  if (ctx.env.ANALYSIS_QUEUE) {
    await ctx.env.ANALYSIS_QUEUE.send(message);
  } else {
    // No queue bound (local dev): run inline without blocking the response.
    ctx.waitUntil(runAnalysisJob(ctx.env, store, message));
  }
  return jobId;
}

export function registerBeatRoutes(router: Router): void {
  /**
   * Step 1 of upload: create the beat and return a secure upload session.
   * Audio goes browser -> R2 directly when S3 credentials are configured
   * (spec §4); otherwise it is proxied through the Worker's R2 binding.
   */
  router.post("/api/beats/upload", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const body = await readJson<{
      filename?: string;
      mimeType?: string;
      sizeBytes?: number;
      title?: string;
    }>(ctx.req);

    const filename = requireString(body.filename, "filename", 300);
    const sizeBytes = typeof body.sizeBytes === "number" && body.sizeBytes > 0 ? body.sizeBytes : 0;
    const maxBytes = uploadMaxBytes(ctx.env);
    if (sizeBytes > maxBytes) {
      throw new HttpError(413, `File is larger than the ${Math.round(maxBytes / 1_048_576)} MB limit`);
    }

    if (!r2BucketAvailable(ctx.env) && !r2SigningConfigured(ctx.env)) {
      throw new HttpError(
        503,
        "Beat storage is not available yet: enable R2 on the Cloudflare account, then create the bucket and deploy.",
      );
    }

    const beatId = id("beat");
    const r2Key = r2KeyFor(userId, beatId, filename);
    const title = (optionalString(body.title, MAX_TITLE) || filename.replace(/\.[a-z0-9]+$/i, "")).slice(0, MAX_TITLE);

    await store.createBeat({
      id: beatId,
      user_id: userId,
      title,
      status: "UPLOADING",
      r2_key: r2Key,
      original_filename: filename,
      mime_type: optionalString(body.mimeType, 120),
      size_bytes: sizeBytes || null,
      duration_seconds: null,
      error: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    const expiresIn = 3600;
    const directUrl = await signedUploadUrl(ctx.env, r2Key, expiresIn);
    if (directUrl) {
      await store.createUploadSession({
        id: id("upl"),
        beat_id: beatId,
        user_id: userId,
        r2_key: r2Key,
        kind: "single",
        upload_id: null,
        parts_total: 1,
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        created_at: nowIso(),
      });
      return json(
        {
          beatId,
          upload: { mode: "direct", method: "PUT", url: directUrl, expiresIn },
          maxBytes,
        },
        { status: 201 },
      );
    }

    await store.createUploadSession({
      id: id("upl"),
      beat_id: beatId,
      user_id: userId,
      r2_key: r2Key,
      kind: "proxy",
      upload_id: null,
      parts_total: 1,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      created_at: nowIso(),
    });
    return json(
      {
        beatId,
        upload: { mode: "proxy", method: "PUT", url: `/api/beats/${beatId}/audio`, expiresIn },
        maxBytes,
      },
      { status: 201 },
    );
  });

  /** Proxy upload path (only used when presigned URLs are unavailable). */
  router.put("/api/beats/:id/audio", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const beatId = ctx.params["id"] ?? "";
    const beat = await store.getBeat(beatId, userId);
    if (!beat) throw new HttpError(404, "Beat not found");
    if (!ctx.env.BEATS) throw new HttpError(503, "R2 binding is not configured");

    const contentType = ctx.req.headers.get("content-type") ?? "application/octet-stream";
    if (!ctx.req.body) throw new HttpError(400, "Empty upload body");

    await ctx.env.BEATS.put(beat.r2_key, ctx.req.body, { httpMetadata: { contentType } });
    await store.updateBeat(beatId, userId, { mime_type: contentType });
    return json({ ok: true });
  });

  /** Step 2 of upload: confirm and hand the object to the analysis pipeline. */
  router.post("/api/beats/:id/complete", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const beatId = ctx.params["id"] ?? "";
    const beat = await store.getBeat(beatId, userId);
    if (!beat) throw new HttpError(404, "Beat not found");

    const head = await headObject(ctx.env, beat.r2_key);
    if (!head.exists) {
      throw new HttpError(400, "Upload was not found in storage — retry the upload");
    }

    await store.updateBeat(beatId, userId, {
      size_bytes: head.size ?? beat.size_bytes,
      mime_type: head.contentType ?? beat.mime_type,
    });
    await store.recordEvent("upload_success", userId, { beatId, sizeBytes: head.size ?? 0 });

    const jobId = await enqueueAnalysis(ctx, store, beat);
    return json({ ok: true, jobId, status: "ANALYZING" });
  });

  router.get("/api/beats", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const beats = await store.listBeats(userId, 100);
    return json({ beats: beats.map(beatSummary) });
  });

  router.get("/api/beats/:id", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const beatId = ctx.params["id"] ?? "";
    const beat = await store.getBeat(beatId, userId);
    if (!beat) throw new HttpError(404, "Beat not found");

    const analysis = await store.getAnalysis(beatId);
    const profile = profileFrom(analysis?.profile_json);
    const job = await store.latestJobForBeat(beatId);
    const cachedIntel = await ctx.env.KV.get<ReturnType<typeof describeBeat>>(`beat:intel:${beatId}`, "json");
    const intelligence = profile ? (cachedIntel ?? describeBeat(profile, beat.title)) : null;

    return json({
      beat: {
        ...beatSummary(beat),
        mimeType: beat.mime_type,
        sizeBytes: beat.size_bytes,
        r2Key: beat.r2_key,
      },
      profile,
      intelligence,
      analysisSource: analysis?.source ?? null,
      analysisEngine: analysis?.engine ?? null,
      job: job
        ? { id: job.id, status: job.status, error: job.error, updatedAt: job.updated_at, attempts: job.attempts }
        : null,
    });
  });

  /** Artist corrections to the analysis (spec §7). */
  router.patch("/api/beats/:id/profile", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const beatId = ctx.params["id"] ?? "";
    const beat = await store.getBeat(beatId, userId);
    if (!beat) throw new HttpError(404, "Beat not found");

    const existing = await store.getAnalysis(beatId);
    const profile = profileFrom(existing?.profile_json);
    if (!profile) throw new HttpError(409, "This beat has no analysis to correct yet");

    const patch = await readJson<ProfilePatch>(ctx.req);
    const next = mergeProfile(profile, patch);
    await store.upsertAnalysis({
      beat_id: beatId,
      user_id: userId,
      profile_json: JSON.stringify(next),
      engine: existing?.engine ?? next.engine,
      engine_version: existing?.engine_version ?? next.engine_version,
      source: "corrected",
      created_at: existing?.created_at ?? nowIso(),
      updated_at: nowIso(),
    });

    const intelligence = describeBeat(next, beat.title);
    await ctx.env.KV.put(`beat:intel:${beatId}`, JSON.stringify(intelligence), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
    await store.recordEvent("beat_profile_corrected", userId, { beatId });
    return json({ profile: next, intelligence });
  });

  router.post("/api/beats/:id/reanalyze", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const beatId = ctx.params["id"] ?? "";
    const beat = await store.getBeat(beatId, userId);
    if (!beat) throw new HttpError(404, "Beat not found");
    const jobId = await enqueueAnalysis(ctx, store, beat);
    return json({ ok: true, jobId });
  });

  /** Playback URL: signed R2 URL when possible, else the proxying stream route. */
  router.get("/api/beats/:id/audio-url", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const beatId = ctx.params["id"] ?? "";
    const beat = await store.getBeat(beatId, userId);
    if (!beat) throw new HttpError(404, "Beat not found");

    const direct = await signedAudioUrl(ctx.env, beat.r2_key, 3600);
    if (direct) return json({ mode: "direct", url: direct, expiresIn: 3600 });
    return json({ mode: "proxy", url: `/api/beats/${beatId}/audio`, expiresIn: 3600 });
  });

  router.get("/api/beats/:id/audio", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const beatId = ctx.params["id"] ?? "";
    const beat = await store.getBeat(beatId, userId);
    if (!beat) throw new HttpError(404, "Beat not found");
    return streamObject(ctx.env, beat.r2_key, ctx.req.headers.get("range"));
  });

  router.delete("/api/beats/:id", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const beatId = ctx.params["id"] ?? "";
    const beat = await store.getBeat(beatId, userId);
    if (!beat) throw new HttpError(404, "Beat not found");
    await deleteObject(ctx.env, beat.r2_key);
    await store.deleteBeat(beatId, userId);
    await store.recordEvent("beat_deleted", userId, { beatId });
    return noContent();
  });
}
