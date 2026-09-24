import { Store } from "../db/store";
import { HttpError, json, noContent, optionalString, readJson, requireString, type Router } from "../http";
import { id, nowIso } from "../util/ids";
import { requireUserId } from "./auth";

const IDEA_KINDS = new Set([
  "hook",
  "lyric",
  "title",
  "concept",
  "one-liner",
  "metaphor",
  "story",
  "melody",
  "voice-note",
]);

/** Idea Bank (spec §29): a separate workspace whose items can be pulled into a song. */
export function registerIdeaRoutes(router: Router): void {
  router.get("/api/ideas", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const kind = ctx.url.searchParams.get("kind");
    const ideas = await store.listIdeas(userId, 200);
    return json({
      ideas: ideas
        .filter((idea) => !kind || idea.kind === kind)
        .map((idea) => ({
          id: idea.id,
          songId: idea.song_id,
          kind: idea.kind,
          text: idea.text,
          tags: JSON.parse(idea.tags_json) as string[],
          source: idea.source,
          createdAt: idea.created_at,
        })),
    });
  });

  router.post("/api/ideas", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const body = await readJson<{ kind?: string; text?: string; songId?: string; tags?: string[] }>(ctx.req);
    const text = requireString(body.text, "text", 4000);
    const kind = body.kind && IDEA_KINDS.has(body.kind) ? body.kind : "one-liner";

    const ideaId = id("idea");
    await store.createIdea({
      id: ideaId,
      user_id: userId,
      song_id: optionalString(body.songId, 60),
      kind,
      text,
      tags_json: JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 12) : []),
      source: "manual",
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    await store.recordEvent("idea_saved", userId, { kind });
    return json({ id: ideaId, kind, text }, { status: 201 });
  });

  router.patch("/api/ideas/:id", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    const ideaId = ctx.params["id"] ?? "";
    const body = await readJson<{ text?: string; kind?: string; tags?: string[] }>(ctx.req);
    await store.updateIdea(ideaId, userId, {
      text: body.text !== undefined ? requireString(body.text, "text", 4000) : undefined,
      kind: body.kind && IDEA_KINDS.has(body.kind) ? body.kind : undefined,
      tags_json: Array.isArray(body.tags) ? JSON.stringify(body.tags.slice(0, 12)) : undefined,
    });
    const ideas = await store.listIdeas(userId, 200);
    const idea = ideas.find((entry) => entry.id === ideaId);
    if (!idea) throw new HttpError(404, "Idea not found");
    return json({ idea: { id: idea.id, kind: idea.kind, text: idea.text } });
  });

  router.delete("/api/ideas/:id", async (ctx) => {
    const userId = requireUserId(ctx);
    const store = new Store(ctx.env.DB);
    await store.deleteIdea(ctx.params["id"] ?? "", userId);
    return noContent();
  });
}
