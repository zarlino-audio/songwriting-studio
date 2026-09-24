import { hex, randomToken } from "./ids";

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;

function pepper(secret: string | undefined): string {
  return secret && secret.length > 0 ? secret : "songwriting-studio-dev-pepper";
}

async function pbkdf2(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_LENGTH_BITS,
  );
  return hex(new Uint8Array(bits));
}

export interface PasswordHash {
  hash: string;
  salt: string;
}

export async function hashPassword(password: string, sessionPepper: string | undefined): Promise<PasswordHash> {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = hex(saltBytes);
  const hash = await pbkdf2(`${password}${pepper(sessionPepper)}`, saltBytes);
  return { hash, salt };
}

export async function verifyPassword(
  password: string,
  stored: PasswordHash,
  sessionPepper: string | undefined,
): Promise<boolean> {
  const saltBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) saltBytes[i] = parseInt(stored.salt.slice(i * 2, i * 2 + 2), 16);
  const candidate = await pbkdf2(`${password}${pepper(sessionPepper)}`, saltBytes);
  return timingSafeEqual(candidate, stored.hash);
}

/** Session tokens are stored hashed, so a D1 leak cannot be replayed. */
export async function hashToken(token: string, sessionPepper: string | undefined): Promise<string> {
  const data = new TextEncoder().encode(`${token}${pepper(sessionPepper)}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return hex(new Uint8Array(digest));
}

export function newSessionToken(): string {
  return randomToken(32);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
