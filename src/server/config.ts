import { promises as dns } from "node:dns";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_PASSWORD } from "./auth.ts";

export type Mode = "outbox" | "direct" | "relay";

export interface Config {
  port: number;
  /** Address to listen on. Loopback by default; 0.0.0.0 inside a container or behind a proxy on another machine. */
  host: string;
  dataDir: string;
  /** outbox: write .eml files. direct: deliver to the recipient's MX. relay: hand off to your own SMTP server. */
  mode: Mode;
  /** smtp://user:pass@host:587 (STARTTLS) or smtps://user:pass@host:465 (implicit TLS) */
  relayUrl: string | null;
  ehloName: string;
  /** Used to build the suggested SPF record. */
  serverIp: string | null;
  rateLimitPerSec: number;
  /** Seeds the dashboard password on first start, for servers where nobody can open the setup page locally. */
  adminPassword: string | null;
  /** Public base URL used in links inside emails (confirm, unsubscribe, tracking). Can also be set in the publication settings. */
  publicUrl: string | null;
  /** Newsletter messages handed to SMTP per second. */
  sendRatePerSec: number;
  /** Most system emails (confirmations, sign-in links) that public pages may trigger per hour, across all visitors. */
  publicMailPerHour: number;
  /** Read the client address from X-Forwarded-For. Only turn this on behind a reverse proxy you control. */
  trustProxy: boolean;
  workerIntervalMs: number;
  resolveTxt: (name: string) => Promise<string[][]>;
}

const root = fileURLToPath(new URL("../..", import.meta.url));

/** A finite number above zero from an environment variable, or a clear startup error. */
function positive(env: NodeJS.ProcessEnv, names: string[], fallback: number, integer = false): number {
  const name = names.find((n) => env[n] !== undefined) ?? names[0];
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} must be a positive ${integer ? "whole " : ""}number`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const mode = (env.NEWSNEST_MODE ?? "outbox") as Mode;
  if (!["outbox", "direct", "relay"].includes(mode)) {
    throw new Error(`NEWSNEST_MODE must be outbox, direct or relay (got "${mode}")`);
  }
  const relayUrl = env.NEWSNEST_RELAY_URL ?? null;
  // The URL usually carries the SMTP password, so none of these errors repeat it.
  if (relayUrl) {
    let parsed: URL;
    try { parsed = new URL(relayUrl); } catch { throw new Error("NEWSNEST_RELAY_URL is not a valid URL"); }
    if (parsed.protocol !== "smtp:" && parsed.protocol !== "smtps:") throw new Error("NEWSNEST_RELAY_URL must start with smtp:// or smtps://");
  }
  if (mode === "relay" && !relayUrl) throw new Error("NEWSNEST_MODE=relay needs NEWSNEST_RELAY_URL");

  const port = positive(env, ["PORT", "NEWSNEST_PORT"], 8700, true);
  if (port > 65535) throw new Error("PORT must be between 1 and 65535");
  const adminPassword = env.NEWSNEST_ADMIN_PASSWORD || null;
  if (adminPassword && adminPassword.length < MIN_PASSWORD) throw new Error(`NEWSNEST_ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters`);

  return {
    port,
    host: env.NEWSNEST_HOST ?? "127.0.0.1",
    dataDir: env.NEWSNEST_DATA ?? join(root, "data"),
    mode,
    relayUrl,
    ehloName: env.NEWSNEST_EHLO_NAME ?? "localhost",
    serverIp: env.NEWSNEST_SERVER_IP ?? null,
    rateLimitPerSec: positive(env, ["NEWSNEST_RATE_LIMIT"], 10),
    adminPassword,
    publicUrl: env.NEWSNEST_PUBLIC_URL?.replace(/\/+$/, "") ?? null,
    sendRatePerSec: positive(env, ["NEWSNEST_SEND_RATE"], 10),
    publicMailPerHour: positive(env, ["NEWSNEST_PUBLIC_MAIL_PER_HOUR"], 500, true),
    trustProxy: env.NEWSNEST_TRUST_PROXY === "1",
    workerIntervalMs: 1000,
    resolveTxt: (name) => dns.resolveTxt(name),
    ...overrides,
  };
}
