import { corsHeaders, HttpError, json, Router, withCors, type RouteContext } from "./http";
import type { AnalysisJobMessage, Env } from "./env";
import { Store } from "./db/store";
import { authenticate, registerAuthRoutes } from "./routes/auth";
import { registerBeatRoutes } from "./routes/beats";
import { registerAnalysisRoutes } from "./routes/analysis";
import { registerSongRoutes } from "./routes/songs";
import { registerAiRoutes } from "./routes/ai";
import { registerIdeaRoutes } from "./routes/ideas";
import { registerProfileRoutes } from "./routes/profile";
import { handleAnalysisBatch } from "./analysis/consumer";
import { SongSessionDO } from "./do/session";

// Durable Object classes must be exported from the Worker entry point.
export { SongSessionDO };

function buildRouter(): Router {
  const router = new Router();
  registerAuthRoutes(router);
  registerBeatRoutes(router);
  registerAnalysisRoutes(router);
  registerSongRoutes(router);
  registerAiRoutes(router);
  registerIdeaRoutes(router);
  registerProfileRoutes(router);
  return router;
}

const router = buildRouter();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Everything that is not an API route is the static React app.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    try {
      const match = router.match(request.method, url.pathname);
      if (!match) return withCors(env, request, json({ error: "Not found" }, { status: 404 }));

      const routeCtx: RouteContext = {
        req: request,
        env,
        url,
        params: match.params,
        waitUntil: (promise) => ctx.waitUntil(promise),
      };

      // Resolve the caller when credentials are present. Individual routes decide
      // whether authentication is required, so /api/health stays public.
      if (request.headers.get("authorization") || url.searchParams.get("token")) {
        await authenticate(routeCtx, new Store(env.DB));
      }

      const response = await match.handler(routeCtx);
      return withCors(env, request, response);
    } catch (error) {
      if (error instanceof HttpError) {
        return withCors(
          env,
          request,
          json({ error: error.message, detail: error.detail }, { status: error.status }),
        );
      }
      const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      console.error("unhandled error", detail);
      return withCors(env, request, json({ error: "Internal error", detail: detail.slice(0, 500) }, { status: 500 }));
    }
  },

  async queue(batch: MessageBatch<AnalysisJobMessage>, env: Env): Promise<void> {
    await handleAnalysisBatch(batch, env);
  },
} satisfies ExportedHandler<Env, AnalysisJobMessage>;
