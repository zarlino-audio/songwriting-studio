import type { Env } from "../env";
import { presignR2Url } from "./sigv4";

/** True when direct-to-R2 (presigned S3) access is available. */
export function r2SigningConfigured(env: Env): boolean {
  return Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

export function r2BucketAvailable(env: Env): boolean {
  return Boolean(env.BEATS);
}

/** Short-lived signed URL so the browser (or analysis service) talks to R2 directly. */
export async function signedAudioUrl(env: Env, key: string, expiresIn = 3600): Promise<string | null> {
  if (!r2SigningConfigured(env)) return null;
  return presignR2Url({
    endpoint: env.R2_S3_ENDPOINT,
    bucket: env.R2_BUCKET,
    key,
    method: "GET",
    accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
    expiresIn,
  });
}

export async function signedUploadUrl(env: Env, key: string, expiresIn = 3600): Promise<string | null> {
  if (!r2SigningConfigured(env)) return null;
  return presignR2Url({
    endpoint: env.R2_S3_ENDPOINT,
    bucket: env.R2_BUCKET,
    key,
    method: "PUT",
    accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
    expiresIn,
  });
}

export interface ObjectHead {
  exists: boolean;
  size?: number;
  contentType?: string;
}

export async function headObject(env: Env, key: string): Promise<ObjectHead> {
  if (!env.BEATS) return { exists: false };
  const head = await env.BEATS.head(key);
  if (!head) return { exists: false };
  return {
    exists: true,
    size: head.size,
    contentType: head.httpMetadata?.contentType,
  };
}

export async function deleteObject(env: Env, key: string): Promise<void> {
  if (!env.BEATS) return;
  try {
    await env.BEATS.delete(key);
  } catch {
    // Deleting a missing object is not an error worth surfacing.
  }
}

/**
 * Streams an R2 object (with byte-range support) — used only when presigned
 * URLs are unavailable, e.g. during local development.
 */
export async function streamObject(env: Env, key: string, rangeHeader: string | null): Promise<Response> {
  if (!env.BEATS) {
    return new Response(JSON.stringify({ error: "R2 binding is not configured" }), { status: 503 });
  }
  const range = parseRange(rangeHeader);
  const object = await env.BEATS.get(key, range ? { range } : undefined);
  if (!object) return new Response(JSON.stringify({ error: "Object not found" }), { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=0, no-store");

  let status = 200;
  if (range && object.range) {
    const start = "offset" in object.range ? object.range.offset ?? 0 : 0;
    const length = "length" in object.range ? object.range.length ?? 0 : 0;
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${object.size}`);
    status = 206;
  }
  return new Response(object.body, { status, headers });
}

function parseRange(header: string | null): R2Range | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (startRaw === "" && endRaw === "") return undefined;
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix)) return undefined;
    return { suffix };
  }
  const offset = Number(startRaw);
  if (!Number.isFinite(offset)) return undefined;
  if (endRaw === "") return { offset };
  const end = Number(endRaw);
  if (!Number.isFinite(end) || end < offset) return undefined;
  return { offset, length: end - offset + 1 };
}
