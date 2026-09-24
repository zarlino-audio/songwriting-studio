import { allowedOrigins, type Env } from "./env";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface RouteContext {
  req: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  userId?: string;
  waitUntil: (promise: Promise<unknown>) => void;
}

export type Handler = (ctx: RouteContext) => Promise<Response> | Response;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

/** Tiny path router: "/api/beats/:id/profile" matches "/api/beats/abc/profile". */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split("/").filter(Boolean),
      handler,
    });
  }

  get(pattern: string, handler: Handler): void {
    this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler): void {
    this.add("POST", pattern, handler);
  }
  patch(pattern: string, handler: Handler): void {
    this.add("PATCH", pattern, handler);
  }
  put(pattern: string, handler: Handler): void {
    this.add("PUT", pattern, handler);
  }
  delete(pattern: string, handler: Handler): void {
    this.add("DELETE", pattern, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter(Boolean);
    let methodMismatch = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i] ?? "";
        const value = parts[i] ?? "";
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(value);
        else if (seg !== value) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method.toUpperCase()) {
        methodMismatch = true;
        continue;
      }
      return { handler: route.handler, params };
    }
    if (methodMismatch) throw new HttpError(405, "Method not allowed");
    return null;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

export function noContent(init: ResponseInit = {}): Response {
  return new Response(null, { status: 204, ...init });
}

export async function readJson<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function corsHeaders(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = allowedOrigins(env);
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-analysis-key",
    "access-control-max-age": "86400",
    vary: "origin",
  };
  if (origin && (allowed.includes(origin) || allowed.includes("*"))) {
    headers["access-control-allow-origin"] = origin;
  } else if (allowed.length === 0) {
    headers["access-control-allow-origin"] = origin ?? "*";
  }
  return headers;
}

export function withCors(env: Env, req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(env, req))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function requireString(value: unknown, field: string, maxLength = 10_000): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `Missing required field: ${field}`);
  }
  if (value.length > maxLength) throw new HttpError(400, `Field too long: ${field}`);
  return value.trim();
}

export function optionalString(value: unknown, maxLength = 10_000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "Expected a string");
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length > maxLength) throw new HttpError(400, "Field too long");
  return trimmed;
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}
