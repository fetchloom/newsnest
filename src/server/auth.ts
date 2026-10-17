import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";
import { ApiError } from "./errors.ts";
import { now, sha256 } from "./ids.ts";

export const COOKIE = "nn_session";
const SESSION_MS = 30 * 24 * 3600 * 1000;
export const MIN_PASSWORD = 10;

export function hasPassword(db: DB): boolean {
  return Boolean(db.prepare("SELECT 1 FROM settings WHERE key = 'admin_password'").get());
}

const hash = (password: string, salt: Buffer): string => scryptSync(password, salt, 32).toString("base64");

export function setPassword(db: DB, password: string): void {
  const salt = randomBytes(16);
  db.prepare("INSERT INTO settings (key, value) VALUES ('admin_password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`scrypt$${salt.toString("base64")}$${hash(password, salt)}`);
  db.prepare("DELETE FROM sessions").run(); // a new password signs everyone out
}

export function checkPassword(db: DB, password: string): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get() as { value: string } | undefined;
  const [kind, salt, expected] = row?.value.split("$") ?? [];
  if (kind !== "scrypt") return false;
  const got = Buffer.from(hash(password, Buffer.from(salt, "base64")));
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function createSession(db: DB): string {
  const token = randomBytes(32).toString("base64url");
  const at = now();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(at);
  db.prepare("INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)").run(sha256(token), at, at + SESSION_MS);
  return token;
}

export function sessionValid(db: DB, token: string | undefined): boolean {
  if (!token) return false;
  return Boolean(db.prepare("SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?").get(sha256(token), now()));
}

export function destroySession(db: DB, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(sha256(token));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean, clear = false): string {
  return `${COOKIE}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${secure ? "; Secure" : ""}`;
}

/** Failed-login throttle: 10 attempts per 15 minutes per client key. Bounded, so a flood of addresses can't grow it without end. */
export function loginThrottle(maxTracked = 5000) {
  const tries = new Map<string, { n: number; resetAt: number }>();
  return {
    blocked(key: string): boolean {
      const t = tries.get(key);
      if (t && t.resetAt < now()) tries.delete(key);
      return (tries.get(key)?.n ?? 0) >= 10;
    },
    fail(key: string): void {
      const t = tries.get(key) ?? { n: 0, resetAt: now() + 15 * 60_000 };
      t.n += 1;
      if (!tries.has(key) && tries.size >= maxTracked) tries.delete(tries.keys().next().value!); // oldest first
      tries.set(key, t);
    },
    clear(key: string): void { tries.delete(key); },
  };
}

const MAX_WAITING = 20;

/**
 * Runs password (and setup code) checks one at a time. scrypt is synchronous, so guesses from many addresses at once would
 * otherwise stall the whole server. When lots of checks have failed lately each one also waits a little longer. That slows a
 * distributed guesser without a hard lockout, which would let a stranger lock the owner out.
 */
export function attemptGate() {
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  let fails = 0;
  let windowEnd = 0;
  return (check: () => boolean): Promise<boolean> => {
    if (waiting >= MAX_WAITING) return Promise.reject(new ApiError(429, "too_many_attempts", "Too many sign-in attempts at once. Try again in a moment."));
    waiting += 1;
    const run = tail.then(async () => {
      const t = Date.now();
      if (t > windowEnd) { fails = 0; windowEnd = t + 60_000; }
      if (fails > 20) await new Promise((r) => setTimeout(r, Math.min((fails - 20) * 25, 1000)));
      const ok = check();
      if (!ok) fails += 1;
      return ok;
    }).finally(() => { waiting -= 1; });
    tail = run.catch(() => {});
    return run;
  };
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

/** One-time code printed to the terminal on first start, so only someone who can read it can create the first password. */
export function newSetupCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const squash = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function setupCodeMatches(expected: string, given: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(squash(expected))), Buffer.from(sha256(squash(given))));
}
