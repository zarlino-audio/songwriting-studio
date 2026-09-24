import { Store, parseJsonArray } from "../db/store";
import { HttpError, json, optionalString, readJson, type RouteContext, type Router } from "../http";
import { buildSongContext } from "../core/context";
import { buildUserPrompt, cacheKeyFor, isAiMode, parseSuggestion, SYSTEM_PROMPT, tierForMode } from "../core/prompts";
import { AiUnavailableError, aiStatus, callAi } from "../integrations/ai";
import type { AiMode, AiSuggestionResponse, AiTier, BeatProfile, SongSectionPayload } from "../types";
import { id, nowIso } from "../util/ids";
import { analyseLyrics } from "../core/text";
import { requireUserId } from "./auth";

const MAX_INSTRUCTION = 2000;
const MAX_SELECTION = 4000;

function profileFrom(jsonText: string | null | undefined): BeatProfile | null {
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as BeatProfile;
  } catch {
    return null;
  }
}

function sectionsFromRows(
  rows: { id: string; kind: string; label: string | null; content: string; position: number; bar_start: number | null; bar_end: number | null }[],
): SongSectionPayload[] {
  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    kind: row.kind,
    label: row.label,
    content: row.content,
    barStart: row.bar_start,
    barEnd: row.bar_end,
  }));
}

/** Enforce the artist's own taboo list (spec §18) — never trust the model with it. */
function applyTaboo(suggestion: AiSuggestionResponse, taboo: string[]): AiSuggestionResponse {
  if (taboo.length === 0) return suggestion;
  const lower = taboo.map((entry) => entry.toLowerCase()).filter(Boolean);
  const allowed: typeof suggestion.options = [];
  const removed: string[] = [];
  for (const option of suggestion.options) {
    const text = option.text.toLowerCase();
    const hit = lower.find((entry) => entry.length > 2 && text.includes(entry));
    if (hit) removed.push(hit);
    else allowed.push(option);
  }
  if (removed.length === 0) return suggestion;
  return {
    ...suggestion,
    options: allowed,
    cautions: [...suggestion.cautions, `Removed ${removed.length} option(s) that used your taboo phrase(s): ${[...new Set(removed)].join(", ")}`],
  };
}

export function registerAiRoutes(router: Router): void {
  router.get("/api/ai/status", async (ctx) => {
    return json({ status: aiStatus(ctx.env) });
  });

  router.get("/api/ai/history", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const limitParam = Number(ctx.url.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;
    const rows = await store.listRecentAiRequests(userId, limit);
    return json({
      requests: rows.map((row) => ({
        id: row.id,
        mode: row.mode,
        tier: row.tier,
        model: row.model,
        instruction: row.instruction,
        createdAt: row.created_at,
        cached: Boolean(row.cached),
        costUsd: row.cost_usd,
        latencyMs: row.latency_ms,
        error: row.error,
        response: row.response_json ? (JSON.parse(row.response_json) as unknown) : null,
      })),
    });
  });

  /**
   * The single AI entry point (spec §11–§14, §38).
   * Everything the model sees comes from the Song Context (spec §15).
   */
  router.post("/api/ai/suggest", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const body = await readJson<{
      songId?: string;
      sectionId?: string;
      mode?: string;
      instruction?: string;
      selection?: string;
      tier?: string;
      refresh?: boolean;
    }>(ctx.req);

    const songId = optionalString(body.songId, 60);
    if (!songId) throw new HttpError(400, "songId is required");
    if (!isAiMode(body.mode)) throw new HttpError(400, "Unknown suggestion mode");

    const song = await store.getSong(songId, userId);
    if (!song) throw new HttpError(404, "Song not found");

    const sectionRows = await store.listSections(songId);
    const payloadSections = sectionsFromRows(sectionRows);
    const sectionId = optionalString(body.sectionId, 60) ?? payloadSections[0]?.id ?? null;
    const profileRow = await store.getProfile(userId);
    const beat = song.beat_id ? await store.getBeat(song.beat_id, userId) : null;
    const analysis = song.beat_id ? await store.getAnalysis(song.beat_id) : null;
    const feedback = await store.listJudgedFeedback(userId, 25);

    const instruction = optionalString(body.instruction, MAX_INSTRUCTION);
    const selectionRaw = optionalString(body.selection, MAX_SELECTION);
    // If the artist highlighted nothing, work from the current section's text.
    const currentSection = payloadSections.find((section) => section.id === sectionId) ?? null;
    const selection = selectionRaw && selectionRaw.length > 0 ? selectionRaw : currentSection?.content ?? null;

    const context = buildSongContext({
      profile: profileRow,
      beat: beat ? { id: beat.id, title: beat.title } : null,
      beatProfile: profileFrom(analysis?.profile_json),
      song,
      sections: sectionRows,
      currentSectionId: sectionId,
      instruction,
      selection,
      feedback: feedback.map((entry) => ({
        accepted: entry.accepted,
        chosen_text: entry.chosen_text,
        edited_text: entry.edited_text,
        mode: entry.mode,
      })),
    });

    const mode = body.mode as AiMode;
    const tierOverride = body.tier === "fast" || body.tier === "creative" || body.tier === "reasoning" ? (body.tier as AiTier) : null;
    const tier = tierOverride ?? tierForMode(mode);
    const requestId = id("ai");

    // Local metrics are free — give the model the same numbers the editor shows.
    const metrics = analyseLyrics(payloadSections.map((section) => ({ kind: section.kind, content: section.content })));
    const metricsNote = [
      `Local metrics: ${metrics.totalLines} lines, ${metrics.totalWords} words, ${metrics.totalSyllables} syllables, ` +
        `avg ${metrics.averageSyllablesPerLine} syllables/line.`,
      metrics.flags.length > 0 ? `Local flags: ${metrics.flags.slice(0, 5).map((f) => f.message).join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const userPrompt = `${buildUserPrompt(context, mode)}\n\n${metricsNote}`;
    const cacheKey = body.refresh ? undefined : cacheKeyFor(context, mode, instruction, selection);

    try {
      const result = await callAi(ctx.env, {
        tier,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        maxTokens: tier === "reasoning" ? 1800 : 1200,
        temperature: mode === "rhyme" || mode === "simplify" ? 0.6 : 0.9,
        cacheKey,
        cacheTtlSeconds: 86_400,
        gatewayCache: true,
      });

      const taboo = profileRow ? parseJsonArray(profileRow.taboo_json) : [];
      const suggestion = applyTaboo(parseSuggestion(result.text, mode), taboo);

      await store.recordAiRequest({
        id: requestId,
        user_id: userId,
        song_id: songId,
        section_id: sectionId,
        mode,
        tier,
        provider: result.provider,
        model: result.model,
        instruction,
        selection: selection?.slice(0, MAX_SELECTION) ?? null,
        context_json: JSON.stringify(context).slice(0, 20_000),
        response_json: JSON.stringify(suggestion).slice(0, 20_000),
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        cost_usd: result.costUsd,
        latency_ms: result.latencyMs,
        cached: result.cached ? 1 : 0,
        gateway_log_id: result.gatewayLogId,
        error: null,
        created_at: nowIso(),
      });
      await store.recordEvent("suggestion_generated", userId, {
        songId,
        mode,
        tier,
        cached: result.cached,
        costUsd: result.costUsd,
      });

      return json({
        requestId,
        suggestion,
        meta: {
          tier,
          provider: result.provider,
          model: result.model,
          cached: result.cached,
          latencyMs: result.latencyMs,
          costUsd: result.costUsd,
          gatewayLogId: result.gatewayLogId,
          route: result.route,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await store.recordAiRequest({
        id: requestId,
        user_id: userId,
        song_id: songId,
        section_id: sectionId,
        mode,
        tier,
        provider: ctx.env.AI_PROVIDER ?? null,
        model: null,
        instruction,
        selection: selection?.slice(0, MAX_SELECTION) ?? null,
        context_json: null,
        response_json: null,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0,
        latency_ms: 0,
        cached: 0,
        gateway_log_id: null,
        error: detail,
        created_at: nowIso(),
      });
      await store.recordEvent("ai_request_failed", userId, { songId, mode, error: detail });
      const status = error instanceof AiUnavailableError ? 503 : 502;
      return json({ error: "AI request failed", detail, requestId }, { status });
    }
  });

  /** Accept / reject / edit — the personal writing memory (spec §19, §40). */
  router.post("/api/ai/feedback", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const body = await readJson<{
      requestId?: string;
      optionIndex?: number;
      accepted?: boolean;
      chosenText?: string;
      editedText?: string;
    }>(ctx.req);

    const requestId = optionalString(body.requestId, 60);
    if (!requestId) throw new HttpError(400, "requestId is required");
    const request = await store.getAiRequest(requestId, userId);
    if (!request) throw new HttpError(404, "AI request not found");

    const accepted = body.accepted === true;
    await store.recordAiFeedback({
      id: id("fb"),
      request_id: requestId,
      user_id: userId,
      option_index: typeof body.optionIndex === "number" ? body.optionIndex : null,
      accepted: accepted ? 1 : 0,
      chosen_text: optionalString(body.chosenText, 4000),
      edited_text: optionalString(body.editedText, 4000),
      created_at: nowIso(),
    });
    await store.recordEvent(accepted ? "suggestion_accepted" : "suggestion_rejected", userId, {
      songId: request.song_id,
      mode: request.mode,
    });

    return json({ ok: true });
  });
}

export type { RouteContext };
