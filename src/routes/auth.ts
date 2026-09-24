import { Store, type UserRow } from "../db/store";
import { HttpError, isEmail, json, readJson, requireString, type RouteContext, type Router } from "../http";
import { addDaysIso, id, nowIso } from "../util/ids";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "../util/crypto";

const SESSION_DAYS = 30;

function publicUser(user: UserRow): { id: string; email: string; displayName: string | null } {
  return { id: user.id, email: user.email, displayName: user.display_name };
}

/**
 * Resolve the caller from a Bearer token. Returns null when unauthenticated.
 *
 * A `?token=` query parameter is also accepted because browsers cannot attach
 * headers to <audio src> requests or WebSocket connections. Prefer the header
 * everywhere else, and prefer signed R2 URLs over the proxying routes.
 */
export async function authenticate(ctx: RouteContext, store: Store): Promise<UserRow | null> {
  const header = ctx.req.headers.get("authorization");
  const headerToken = header && header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = headerToken || (ctx.url.searchParams.get("token") ?? "").trim();
  if (!token) return null;

  const tokenHash = await hashToken(token, ctx.env.SESSION_PEPPER);
  const session = await store.getSessionByTokenHash(tokenHash);
  if (!session) return null;
  if (session.expires_at < nowIso()) {
    await store.deleteSession(session.id);
    return null;
  }
  const user = await store.getUserById(session.user_id);
  if (!user) return null;

  // Touch at most once an hour — avoids a D1 write on every keystroke.
  if (Date.now() - Date.parse(session.last_seen_at) > 3_600_000) {
    await store.touchSession(session.id);
  }
  ctx.userId = user.id;
  return user;
}

export function requireUserId(ctx: RouteContext): string {
  if (!ctx.userId) throw new HttpError(401, "Authentication required");
  return ctx.userId;
}

async function createSession(ctx: RouteContext, store: Store, user: UserRow): Promise<string> {
  const token = newSessionToken();
  const tokenHash = await hashToken(token, ctx.env.SESSION_PEPPER);
  await store.createSession({
    id: id("sess"),
    user_id: user.id,
    token_hash: tokenHash,
    created_at: nowIso(),
    expires_at: addDaysIso(SESSION_DAYS),
    last_seen_at: nowIso(),
  });
  return token;
}

export function registerAuthRoutes(router: Router): void {
  router.post("/api/auth/register", async (ctx) => {
    const store = new Store(ctx.env.DB);
    const body = await readJson<{ email?: string; password?: string; displayName?: string }>(ctx.req);
    const email = requireString(body.email, "email", 320).toLowerCase();
    const password = requireString(body.password, "password", 200);
    if (!isEmail(email)) throw new HttpError(400, "Enter a valid email address");
    if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");

    const existing = await store.getUserByEmail(email);
    if (existing) throw new HttpError(409, "That email is already registered");

    const { hash, salt } = await hashPassword(password, ctx.env.SESSION_PEPPER);
    const user: UserRow = {
      id: id("usr"),
      email,
      display_name: body.displayName?.trim() || null,
      password_hash: hash,
      password_salt: salt,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await store.createUser(user);
    await store.recordEvent("user_registered", user.id, {});
    const token = await createSession(ctx, store, user);
    return json({ token, user: publicUser(user) }, { status: 201 });
  });

  router.post("/api/auth/login", async (ctx) => {
    const store = new Store(ctx.env.DB);
    const body = await readJson<{ email?: string; password?: string }>(ctx.req);
    const email = requireString(body.email, "email", 320).toLowerCase();
    const password = requireString(body.password, "password", 200);

    const user = await store.getUserByEmail(email);
    if (!user) throw new HttpError(401, "Wrong email or password");
    const ok = await verifyPassword(
      password,
      { hash: user.password_hash, salt: user.password_salt },
      ctx.env.SESSION_PEPPER,
    );
    if (!ok) throw new HttpError(401, "Wrong email or password");

    const token = await createSession(ctx, store, user);
    await store.recordEvent("user_login", user.id, {});
    return json({ token, user: publicUser(user) });
  });

  router.post("/api/auth/logout", async (ctx) => {
    const store = new Store(ctx.env.DB);
    const header = ctx.req.headers.get("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (token) {
      const tokenHash = await hashToken(token, ctx.env.SESSION_PEPPER);
      const session = await store.getSessionByTokenHash(tokenHash);
      if (session) await store.deleteSession(session.id);
    }
    return json({ ok: true });
  });

  router.get("/api/auth/status", async (ctx) => {
    const store = new Store(ctx.env.DB);
    const user = await authenticate(ctx, store);
    return json({ authenticated: Boolean(user), user: user ? publicUser(user) : null });
  });
}
