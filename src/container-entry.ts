/**
 * Entry point for the container deployment.
 *
 * The default deployment (wrangler.toml) uses src/index.ts, which never imports
 * @cloudflare/containers. This entry adds the AnalysisService container class
 * on top of exactly the same Worker.
 *
 * `export * from "./index"` re-exports named exports only — NOT the default export
 * that carries `fetch`/`queue`. Without the explicit `export { default }` below,
 * wrangler deploys a script with no handlers at all and rejects it with
 * "Queue handler is missing" (code 11001).
 */
export { default } from "./index";
export * from "./index";
export { AnalysisService } from "./container";
