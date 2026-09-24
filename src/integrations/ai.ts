import { aiGatewayEnabled, type Env } from "../env";
import type { AiTier } from "../types";

/**
 * Provider-agnostic model layer (spec §16–17, §36).
 *
 * Requests go through AI Gateway when configured (centralised logging, caching,
 * BYOK) and fall back to calling the provider directly, so the app keeps working
 * with nothing but a provider key.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCallOptions {
  tier: AiTier;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  cacheKey?: string;
  cacheTtlSeconds?: number;
  /** Ask the gateway to reuse a cached completion. */
  gatewayCache?: boolean;
}

export interface AiCallResult {
  text: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  cached: boolean;
  gatewayLogId: string | null;
  /** Which route actually produced the answer. */
  route: "gateway" | "direct";
}

interface ProviderConfig {
  gatewayPath: string;
  directUrl: string;
  apiKey: (env: Env) => string | undefined;
}

const PRICES: Record<string, { input: number; output: number }> = {
  // USD per 1M tokens. Conservative public list prices; adjust as needed.
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  default: { input: 0.5, output: 1.5 },
};

const PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    gatewayPath: "deepseek",
    directUrl: "https://api.deepseek.com/chat/completions",
    apiKey: (env) => env.DEEPSEEK_API_KEY,
  },
  openai: {
    gatewayPath: "openai",
    directUrl: "https://api.openai.com/v1/chat/completions",
    apiKey: () => undefined,
  },
  anthropic: {
    gatewayPath: "anthropic",
    directUrl: "https://api.anthropic.com/v1/messages",
    apiKey: () => undefined,
  },
};

export function modelForTier(env: Env, tier: AiTier): { provider: string; model: string } {
  const provider = (env.AI_PROVIDER || "deepseek").toLowerCase();
  const model =
    tier === "reasoning"
      ? env.AI_MODEL_REASONING
      : tier === "creative"
        ? env.AI_MODEL_CREATIVE
        : env.AI_MODEL_FAST;
  return { provider, model: model || "deepseek-chat" };
}

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const price = PRICES[model] ?? PRICES["default"] ?? { input: 0.5, output: 1.5 };
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
}

async function hashKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readCache(env: Env, key: string): Promise<AiCallResult | null> {
  try {
    const cached = await env.KV.get<AiCallResult>(`ai:cache:${key}`, "json");
    return cached;
  } catch {
    return null;
  }
}

async function writeCache(env: Env, key: string, result: AiCallResult, ttlSeconds: number): Promise<void> {
  try {
    await env.KV.put(`ai:cache:${key}`, JSON.stringify(result), { expirationTtl: Math.max(ttlSeconds, 60) });
  } catch {
    // Cache is best-effort; never fail a request because KV is unavailable.
  }
}

export class AiUnavailableError extends Error {}

export async function callAi(env: Env, options: AiCallOptions): Promise<AiCallResult> {
  const { provider, model } = modelForTier(env, options.tier);
  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) throw new AiUnavailableError(`Unknown AI provider: ${provider}`);

  const apiKey = providerConfig.apiKey(env);
  if (!apiKey) {
    throw new AiUnavailableError(
      `No API key configured for provider "${provider}". Set it with: wrangler secret put ${provider === "deepseek" ? "DEEPSEEK_API_KEY" : `${provider.toUpperCase()}_API_KEY`}`,
    );
  }

  const cacheKey = options.cacheKey ? await hashKey(`${provider}:${model}:${options.cacheKey}`) : null;
  if (cacheKey) {
    const cached = await readCache(env, cacheKey);
    if (cached) return { ...cached, cached: true, latencyMs: 0 };
  }

  const useGateway = aiGatewayEnabled(env);
  const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/${providerConfig.gatewayPath}/chat/completions`;

  const body = JSON.stringify({
    model,
    messages: options.messages,
    temperature: options.temperature ?? 0.85,
    max_tokens: options.maxTokens ?? 1400,
  });

  /**
   * Try AI Gateway first (central logging/caching), then fall back to the
   * provider directly. A gateway that is not yet authenticated must not stop the
   * artist from getting an answer — and the route used is recorded per request.
   */
  const routes: { url: string; headers: Record<string, string>; route: "gateway" | "direct" }[] = [];
  if (useGateway) {
    routes.push({
      url: gatewayUrl,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(env.AI_GATEWAY_TOKEN ? { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` } : {}),
        ...(options.gatewayCache ? { "cf-aig-cache-ttl": String(options.cacheTtlSeconds ?? 86_400) } : {}),
      },
      route: "gateway",
    });
  }
  routes.push({
    url: providerConfig.directUrl,
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    route: "direct",
  });

  let lastError: Error | null = null;
  for (const candidate of routes) {
    const started = Date.now();
    const response = await fetch(candidate.url, { method: "POST", headers: candidate.headers, body });
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      const detail = await response.text();
      lastError = new Error(`AI provider error ${response.status}: ${detail.slice(0, 400)}`);
      if (routes.length > 1 && candidate.route === "gateway") {
        console.warn(`AI Gateway rejected the request (${response.status}); falling back to the provider directly`);
        continue;
      }
      throw lastError;
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content ?? "";
    const promptTokens = payload.usage?.prompt_tokens ?? 0;
    const completionTokens = payload.usage?.completion_tokens ?? 0;

    const result: AiCallResult = {
      text,
      provider,
      model,
      promptTokens,
      completionTokens,
      costUsd: estimateCostUsd(model, promptTokens, completionTokens),
      latencyMs,
      cached: false,
      gatewayLogId: response.headers.get("cf-aig-log-id"),
      route: candidate.route,
    };

    if (cacheKey) await writeCache(env, cacheKey, result, options.cacheTtlSeconds ?? 86_400);
    return result;
  }

  throw lastError ?? new AiUnavailableError("No AI route available");
}

export interface AiStatus {
  provider: string;
  gatewayEnabled: boolean;
  gatewayId: string;
  gatewayTokenPresent: boolean;
  models: { fast: string; creative: string; reasoning: string };
  keyPresent: boolean;
}

export function aiStatus(env: Env): AiStatus {
  const provider = (env.AI_PROVIDER || "deepseek").toLowerCase();
  const config = PROVIDERS[provider];
  return {
    provider,
    gatewayEnabled: aiGatewayEnabled(env),
    gatewayId: env.AI_GATEWAY_ID ?? "",
    gatewayTokenPresent: Boolean(env.AI_GATEWAY_TOKEN),
    models: {
      fast: env.AI_MODEL_FAST ?? "",
      creative: env.AI_MODEL_CREATIVE ?? "",
      reasoning: env.AI_MODEL_REASONING ?? "",
    },
    keyPresent: Boolean(config?.apiKey(env)),
  };
}
