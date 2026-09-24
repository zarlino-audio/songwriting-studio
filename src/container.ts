import { Container } from "@cloudflare/containers";
import type { Env } from "./env";

/**
 * Cloudflare Container hosting the Python audio-analysis service.
 *
 * Only used by the container deployment (wrangler.containers.toml, entry
 * src/container-entry.ts) — the default deployment talks to the same service
 * over HTTP instead. The image is built from ./analysis.
 */
export class AnalysisService extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    // Secrets are injected into the container process at start.
    this.envVars = {
      ANALYSIS_SHARED_SECRET: env.ANALYSIS_SHARED_SECRET ?? "",
      MAX_AUDIO_SECONDS: "1800",
      PYTHONUNBUFFERED: "1",
    };
  }

  override onStart(): void {
    console.log("[analysis-container] started");
  }

  override onStop(): void {
    console.log("[analysis-container] stopped");
  }

  override onError(error: unknown): void {
    console.error("[analysis-container] error", error);
  }
}
