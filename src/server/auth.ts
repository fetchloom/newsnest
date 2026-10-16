import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";
import { now, sha256 } from "./ids.ts";

export const COOKIE = "fp_session";
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

/** Failed-login throttle: 10 attempts per 15 minutes per address. */
export function loginThrottle() {
  const tries = new Map<string, { n: number; resetAt: number }>();
  return {
    blocked(ip: string): boolean {
      const t = tries.get(ip);
      if (t && t.resetAt < now()) tries.delete(ip);
      return (tries.get(ip)?.n ?? 0) >= 10;
    },
    fail(ip: string): void {
      const t = tries.get(ip) ?? { n: 0, resetAt: now() + 15 * 60_000 };
      t.n += 1;
      tries.set(ip, t);
    },
    clear(ip: string): void { tries.delete(ip); },
  };
}
