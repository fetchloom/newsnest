import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { now } from "./ids.ts";

const DAY = 24 * 3600 * 1000;

export function stats(db: DB) {
  const count = (sql: string, ...args: number[]): number => (db.prepare(sql).get(...args) as { n: number }).n;

  const deliveries: Record<string, number> = {};
  for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status").all() as unknown as { status: string; n: number }[]) {
    deliveries[r.status] = r.n;
  }

  const days = 14;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const first = start.getTime() - (days - 1) * DAY;
  const perDay = new Map<string, number>();
  for (const r of db.prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM emails WHERE created_at >= ? GROUP BY d").all(first) as unknown as { d: string; n: number }[]) {
    perDay.set(r.d, r.n);
  }
  const series = Array.from({ length: days }, (_, i) => {
    const date = new Date(first + i * DAY).toISOString().slice(0, 10);
    return { date, count: perDay.get(date) ?? 0 };
  });

  return {
    emails: count("SELECT COUNT(*) AS n FROM emails"),
    emails_today: count("SELECT COUNT(*) AS n FROM emails WHERE created_at >= ?", start.getTime()),
    deliveries,
    series,
    domains: { total: count("SELECT COUNT(*) AS n FROM domains"), verified: count("SELECT COUNT(*) AS n FROM domains WHERE status = 'verified'") },
    api_keys: count("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL"),
    webhooks: count("SELECT COUNT(*) AS n FROM webhooks"),
    now: now(),
  };
}

/** Safe to show in the dashboard: never includes credentials. */
export function publicSettings(cfg: Config) {
  let relayHost: string | null = null;
  if (cfg.relayUrl) {
    try { const u = new URL(cfg.relayUrl); relayHost = `${u.hostname}:${u.port || (u.protocol === "smtps:" ? 465 : 587)}`; } catch { relayHost = "invalid URL"; }
  }
  return { mode: cfg.mode, relay_host: relayHost, ehlo_name: cfg.ehloName, server_ip: cfg.serverIp, data_dir: cfg.dataDir, version: "0.1.0" };
}
