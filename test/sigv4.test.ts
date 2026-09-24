import { describe, expect, it } from "vitest";
import { amzDateStamp, encodeKeyPath, encodeRfc3986, presignR2Url, r2KeyFor, sha256Hex } from "../src/core/sigv4";

describe("R2 presigning", () => {
  it("produces a deterministic, well-formed signed URL", async () => {
    const url = await presignR2Url({
      endpoint: "https://ae604b602fdbcb1b48b41e975c6dbd19.r2.cloudflarestorage.com",
      bucket: "songwriting-beats",
      key: "audio/original/usr_1/beat_2/my beat.wav",
      method: "PUT",
      accessKeyId: "TESTKEY",
      secretAccessKey: "TESTSECRET",
      expiresIn: 3600,
      now: new Date("2026-09-22T10:00:00Z"),
    });

    const parsed = new URL(url);
    expect(parsed.host).toBe("ae604b602fdbcb1b48b41e975c6dbd19.r2.cloudflarestorage.com");
    expect(parsed.pathname).toBe("/songwriting-beats/audio/original/usr_1/beat_2/my%20beat.wav");
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(parsed.searchParams.get("X-Amz-Credential")).toBe("TESTKEY/20260922/auto/s3/aws4_request");
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for identical inputs and changes with the secret", async () => {
    const base = {
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "b",
      key: "audio/original/u/beat/file.wav",
      method: "GET" as const,
      accessKeyId: "AK",
      expiresIn: 900,
      now: new Date("2026-09-22T10:00:00Z"),
    };
    const first = await presignR2Url({ ...base, secretAccessKey: "S1" });
    const second = await presignR2Url({ ...base, secretAccessKey: "S1" });
    const third = await presignR2Url({ ...base, secretAccessKey: "S2" });
    expect(first).toBe(second);
    expect(first).not.toBe(third);
  });

  it("caps the expiry at seven days", async () => {
    const url = await presignR2Url({
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "b",
      key: "k",
      method: "GET",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      expiresIn: 10_000_000,
    });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("604800");
  });
});

describe("encoding helpers", () => {
  it("encodes path segments but keeps slashes", () => {
    expect(encodeKeyPath("a b/c+d/é")).toBe("a%20b/c%2Bd/%C3%A9");
  });

  it("encodes reserved characters", () => {
    expect(encodeRfc3986("a/b c")).toBe("a%2Fb%20c");
  });

  it("formats timestamps in SigV4 form", () => {
    const { amzDate, dateStamp } = amzDateStamp(new Date("2026-09-22T10:23:45.123Z"));
    expect(amzDate).toBe("20260922T102345Z");
    expect(dateStamp).toBe("20260922");
  });

  it("hashes with sha256 hex", async () => {
    const digest = await sha256Hex("abc");
    expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("scopes object keys per user and beat", () => {
    const key = r2KeyFor("usr_1", "beat_2", "My Beat (final).WAV");
    expect(key).toBe("audio/original/usr_1/beat_2/My_Beat__final_.WAV");
    expect(key.startsWith("audio/original/")).toBe(true);
  });
});
