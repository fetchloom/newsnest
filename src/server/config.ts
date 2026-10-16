import { promises as dns } from "node:dns";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  /** Read the client address from X-Forwarded-For. Only turn this on behind a reverse proxy you control. */
  trustProxy: boolean;
  workerIntervalMs: number;
  resolveTxt: (name: string) => Promise<string[][]>;
}

const root = fileURLToPath(new URL("../..", import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const mode = (env.NEWSNEST_MODE ?? "outbox") as Mode;
  if (!["outbox", "direct", "relay"].includes(mode)) {
    throw new Error(`NEWSNEST_MODE must be outbox, direct or relay (got "${mode}")`);
  }
  const relayUrl = env.NEWSNEST_RELAY_URL ?? null;
  if (mode === "relay" && !relayUrl) throw new Error("NEWSNEST_MODE=relay needs NEWSNEST_RELAY_URL");

  return {
    port: Number(env.PORT ?? env.NEWSNEST_PORT ?? 8700),
    host: env.NEWSNEST_HOST ?? "127.0.0.1",
    dataDir: env.NEWSNEST_DATA ?? join(root, "data"),
    mode,
    relayUrl,
    ehloName: env.NEWSNEST_EHLO_NAME ?? "localhost",
    serverIp: env.NEWSNEST_SERVER_IP ?? null,
    rateLimitPerSec: Number(env.NEWSNEST_RATE_LIMIT ?? 10),
    adminPassword: env.NEWSNEST_ADMIN_PASSWORD ?? null,
    publicUrl: env.NEWSNEST_PUBLIC_URL?.replace(/\/+$/, "") ?? null,
    sendRatePerSec: Number(env.NEWSNEST_SEND_RATE ?? 10),
    trustProxy: env.NEWSNEST_TRUST_PROXY === "1",
    workerIntervalMs: 1000,
    resolveTxt: (name) => dns.resolveTxt(name),
    ...overrides,
  };
}
