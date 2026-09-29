#!/usr/bin/env node
/**
 * Live end-to-end smoke test.
 *
 *   node tools/smoke.mjs --url https://<worker>.workers.dev [--wait 120] [--audio track.mp3]
 *
 * Verifies the whole vertical slice against a real deployment:
 *   health -> register/login -> beat upload -> analysis job -> (wait for the
 *   analysis runtime) -> beat profile -> song -> autosave -> version -> AI call
 *   -> export -> observability
 *
 * Without --audio it generates its own click-track WAV in memory, so no audio
 * assets are needed. Pass --audio <file> to push a real track instead (how the
 * container runtime is exercised with track-length audio).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  const value = process.argv[i + 1] ?? "true";
  if (key) args.set(key, value);
}

const BASE = (args.get("url") ?? process.env.STUDIO_URL ?? "https://zarlino-songwriting-studio.zarlino001.workers.dev").replace(/\/$/, "");
const WAIT_SECONDS = Number(args.get("wait") ?? "0");
const EMAIL = args.get("email") ?? `smoke+${Date.now()}@example.com`;
const PASSWORD = args.get("password") ?? `Smoke-${Math.random().toString(36).slice(2, 10)}-1a`;

let token = null;
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(path, { method = "GET", body, auth = true, raw = false, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (auth && token) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  } else if (body !== undefined) {
    init.body = body;
  }
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, ok: response.ok, payload };
}

/** 16-bit mono WAV click track: accents on every 4th beat plus a bass root. */
function makeClickTrack(bpm = 104, seconds = 12, sampleRate = 44100) {
  const samples = new Int16Array(seconds * sampleRate);
  const beatSamples = Math.round((60 / bpm) * sampleRate);
  for (let beat = 0; beat * beatSamples < samples.length; beat++) {
    const start = beat * beatSamples;
    const accent = beat % 4 === 0;
    const clickLength = Math.round(0.02 * sampleRate);
    for (let i = 0; i < clickLength && start + i < samples.length; i++) {
      const envelope = Math.exp(-i / (clickLength / 5));
      const tone = Math.sin((2 * Math.PI * (accent ? 2200 : 1500) * i) / sampleRate);
      samples[start + i] += Math.round(9000 * envelope * tone);
    }
  }
  for (let i = 0; i < samples.length; i++) {
    const bass = Math.sin((2 * Math.PI * 110 * i) / sampleRate) * 2500;
    samples[i] = Math.max(-32000, Math.min(32000, samples[i] + Math.round(bass)));
  }

  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i], 44 + i * 2);
  return buffer;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`\nSmoke test against ${BASE}\n${"-".repeat(60)}`);

  // 1 — health
  const health = await api("/api/health", { auth: false });
  record("health endpoint responds", health.ok, `status ${health.status}`);
  const checks = health.payload?.checks ?? {};
  record("database schema present", checks.database === true, `${health.payload?.tables ?? 0} tables`);
  record("R2 binding present", checks.r2Binding === true);
  record("AI key configured", checks.aiKey === true, `provider ${health.payload?.ai?.provider ?? "?"}`);
  if (Array.isArray(health.payload?.hints) && health.payload.hints.length > 0) {
    console.log("      hints:", health.payload.hints.join(" | "));
  }

  // 2 — register (fall back to login when the address already exists)
  let auth = await api("/api/auth/register", { method: "POST", auth: false, body: { email: EMAIL, password: PASSWORD } });
  if (auth.status === 409) auth = await api("/api/auth/login", { method: "POST", auth: false, body: { email: EMAIL, password: PASSWORD } });
  token = auth.payload?.token ?? null;
  record("account created / signed in", auth.ok && Boolean(token), `status ${auth.status}`);
  if (!token) return finish();

  const me = await api("/api/auth/status");
  record("session resolves", me.ok && me.payload?.authenticated === true, me.payload?.user?.email ?? "");

  // 3 — upload a beat (proxy path is used until R2 S3 keys are configured)
  //     `--audio <file>` uploads a real track instead of the built-in click track,
  //     which is how the container path is exercised with track-length audio.
  const audioPath = args.get("audio");
  let wav;
  let filename = "smoke-click-104.wav";
  let mimeType = "audio/wav";
  let title = "Smoke click 104";
  if (audioPath) {
    wav = readFileSync(audioPath);
    filename = basename(audioPath);
    mimeType = filename.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : mimeType;
    title = `Smoke ${filename}`;
    console.log(`      using ${filename} (${(wav.length / 1e6).toFixed(1)} MB)`);
  } else {
    wav = makeClickTrack();
  }
  const upload = await api("/api/beats/upload", {
    method: "POST",
    body: { filename, mimeType, sizeBytes: wav.length, title },
  });
  record("upload session created", upload.ok, `mode ${upload.payload?.upload?.mode ?? "?"}`);
  if (!upload.ok) return finish();

  const beatId = upload.payload.beatId;
  const mode = upload.payload.upload.mode;
  const putResponse = mode === "direct"
    ? await fetch(upload.payload.upload.url, { method: "PUT", body: wav })
    : await api(upload.payload.upload.url, { method: "PUT", body: wav, raw: true, headers: { "content-type": mimeType } });
  const putOk = mode === "direct" ? putResponse.ok : putResponse.ok;
  record("audio stored", Boolean(putOk), `mode ${mode}`);

  const complete = await api(`/api/beats/${beatId}/complete`, { method: "POST" });
  record("analysis job queued", complete.ok, complete.payload?.jobId ?? "");

  // 4 — wait for the analysis worker (started separately) to publish the profile
  let detail = null;
  if (WAIT_SECONDS > 0) {
    const deadline = Date.now() + WAIT_SECONDS * 1000;
    while (Date.now() < deadline) {
      detail = await api(`/api/beats/${beatId}`);
      const status = detail.payload?.beat?.status;
      if (status === "READY" || status === "FAILED") break;
      await sleep(3000);
    }
  } else {
    detail = await api(`/api/beats/${beatId}`);
  }

  const status = detail?.payload?.beat?.status;
  record("beat analysed", status === "READY", `status ${status ?? "?"}${detail?.payload?.beat?.error ? ` — ${detail.payload.beat.error}` : ""}`);
  const profile = detail?.payload?.profile ?? null;
  if (profile) {
    // The built-in click track is 104 BPM; a file passed with --audio has its own
    // tempo, so the check only asserts a plausible range in that case.
    const tempoOk = audioPath
      ? profile.bpm >= 50 && profile.bpm <= 200
      : Math.abs(profile.bpm - 104) <= 6;
    record(
      audioPath ? "tempo detected (plausible range)" : "tempo detected ~104 BPM",
      tempoOk,
      `${profile.bpm} BPM (conf ${profile.bpm_confidence})`,
    );
    record("key detected", typeof profile.key === "string" && profile.key !== "unknown", profile.key);
    record(
      "profile is complete",
      profile.rhythm.beat_grid.length > 4 && profile.sections.length > 0 && profile.energy.curve.length > 4,
      `${profile.rhythm.beat_grid.length} beats, ${profile.sections.length} sections, ${profile.energy.curve.length} energy points`,
    );
    record("beat intelligence written", Boolean(detail.payload.intelligence?.summary), detail.payload.intelligence?.headline ?? "");
  }

  // 5 — create a song from the beat and write into it
  const song = await api("/api/songs", {
    method: "POST",
    body: { beatId, title: "Smoke song", concept: "testing the whole pipeline" },
  });
  record("song created from beat", song.ok, `${song.payload?.sections?.length ?? 0} sections`);

  let songId = song.payload?.song?.id ?? null;
  if (songId) {
    const sections = (song.payload.sections ?? []).map((section, index) => ({
      ...section,
      content:
        index === 0
          ? "I came from the place where the lights stay low\nNow everybody wants to know"
          : index === 1
            ? "Still hungry, still hungry"
            : section.content,
    }));
    const saved = await api(`/api/songs/${songId}/save`, { method: "POST", body: { sections, versionName: "Smoke write" } });
    record("autosave + version snapshot", saved.ok, `v${saved.payload?.versionNo ?? "?"}`);

    const versions = await api(`/api/songs/${songId}/versions`);
    record("version history readable", versions.ok && (versions.payload?.versions?.length ?? 0) >= 2, `${versions.payload?.versions?.length ?? 0} versions`);

    const health = await api(`/api/songs/${songId}/health`);
    const checkCount = health.payload?.health?.checks?.length ?? 0;
    record("song health check runs", health.ok && checkCount >= 8, `${checkCount} checks, ${health.payload?.health?.metrics?.totalLines ?? 0} lines`);

    const exportResponse = await fetch(`${BASE}/api/songs/${songId}/export?format=txt&token=${encodeURIComponent(token)}`);
    const lyrics = await exportResponse.text();
    record("lyric export works", exportResponse.ok && lyrics.includes("STILL HUNGRY") === false && lyrics.length > 40, `${lyrics.length} chars`);
  }

  // 6 — one real AI call (beat-aware, using the analysed profile)
  const suggestion = await api("/api/ai/suggest", {
    method: "POST",
    body: { songId, mode: "hook", instruction: "make the hook repeatable and conversational" },
  });
  const optionCount = suggestion.payload?.suggestion?.options?.length ?? 0;
  record(
    "AI suggestion returned options",
    suggestion.ok && optionCount > 0,
    suggestion.ok
      ? `${optionCount} options · ${suggestion.payload.meta.model} · ${suggestion.payload.meta.latencyMs}ms · $${suggestion.payload.meta.costUsd}`
      : `${suggestion.status} ${suggestion.payload?.detail ?? suggestion.payload?.error ?? ""}`,
  );

  if (suggestion.ok && optionCount > 0) {
    const feedback = await api("/api/ai/feedback", {
      method: "POST",
      body: { requestId: suggestion.payload.requestId, optionIndex: 0, accepted: true, chosenText: suggestion.payload.suggestion.options[0].text },
    });
    record("feedback recorded", feedback.ok);
  }

  // 7 — observability + isolation
  const overview = await api("/api/observability/overview");
  record("observability counters", overview.ok, `songs ${overview.payload?.songsStarted}, AI ${overview.payload?.aiRequests}`);

  const beats = await api("/api/beats");
  const otherBeat = await api(`/api/beats/${beatId}`);
  record("own beat readable", otherBeat.ok);
  const anonymous = await api("/api/beats", { auth: false });
  record("unauthenticated access rejected", anonymous.status === 401, `status ${anonymous.status}`);

  finish();
}

function finish() {
  const failed = results.filter((entry) => !entry.ok);
  console.log(`${"-".repeat(60)}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("failed:");
    for (const entry of failed) console.log(`  - ${entry.name} ${entry.detail}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("smoke test crashed:", error);
  process.exit(2);
});
