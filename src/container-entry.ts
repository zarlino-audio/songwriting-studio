/**
 * Entry point for the container deployment.
 *
 * The default deployment (wrangler.toml) uses src/index.ts, which never imports
 * @cloudflare/containers. This entry adds the AnalysisService container class
 * on top of exactly the same Worker.
 */
export * from "./index";
export { AnalysisService } from "./container";
