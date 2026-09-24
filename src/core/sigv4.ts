/**
 * AWS SigV4 query-string signing for R2's S3-compatible API.
 *
 * This is what lets the browser upload a 500 MB beat straight to R2 and stream
 * it back for playback without the audio ever flowing through the Worker
 * (spec §4 and §53). If R2 credentials are absent we fall back to proxying
 * through the R2 binding — see routes/beats.ts.
 */

const encoder = new TextEncoder();

export interface PresignOptions {
  endpoint: string;
  bucket: string;
  key: string;
  method: "GET" | "PUT";
  accessKeyId: string;
  secretAccessKey: string;
  expiresIn: number;
  region?: string;
  now?: Date;
}

function toHex(buffer: ArrayBuffer): string {
  let out = "";
  for (const b of new Uint8Array(buffer)) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return toHex(digest);
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  return new Uint8Array(signature);
}

/** Percent-encode per RFC 3986 (UTF-8 aware), keeping only unreserved characters. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Encode an object key for the canonical URI: keep "/", encode everything else. */
export function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

export function amzDateStamp(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  // 20240101T000000Z
  const amzDate = iso.replace(/Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

/**
 * Returns a presigned URL. Only the `host` header is signed, so the client is
 * free to send any content-type (needed for browser PUT of audio files).
 */
export async function presignR2Url(options: PresignOptions): Promise<string> {
  const { endpoint, bucket, key, method, accessKeyId, secretAccessKey } = options;
  const region = options.region ?? "auto";
  const expiresIn = Math.min(Math.max(options.expiresIn, 1), 604_800);
  const url = new URL(endpoint);
  const { amzDate, dateStamp } = amzDateStamp(options.now ?? new Date());

  const canonicalUri = `/${bucket}/${encodeKeyPath(key)}`;
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  };

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k] ?? "")}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${url.host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex((await hmac(kSigning, stringToSign)).buffer as ArrayBuffer);

  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function r2KeyFor(userId: string, beatId: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
  return `audio/original/${userId}/${beatId}/${safe || "beat"}`;
}
