import type { IncomingMessage, ServerResponse } from "node:http";
import { COOKIE, parseCookies, sessionValid } from "./auth.ts";
import type { DB } from "./db.ts";

const POLL_MS = 1000;
const PING_MS = 25_000;
const MAX_CLIENTS = 20;

// Cheap to read: every value is the newest row id of an append-only table, so a change anywhere shows up here.
const FINGERPRINT = `SELECT
  (SELECT COALESCE(MAX(rowid), 0) FROM events) || ':' ||
  (SELECT COALESCE(MAX(rowid), 0) FROM emails) || ':' ||
  (SELECT COALESCE(MAX(rowid), 0) FROM subscriber_events) || ':' ||
  (SELECT COALESCE(MAX(rowid), 0) FROM poll_votes) || ':' ||
  (SELECT COALESCE(MAX(rowid), 0) FROM survey_responses) || ':' ||
  (SELECT COUNT(*) || '.' || COALESCE(MAX(updated_at), 0) FROM posts) AS fp`;

const NOTICE_TEXT: Record<string, string> = { confirmed: "New subscriber", unsubscribed: "Unsubscribed", bounced: "Bounced" };

/**
 * A server-sent event stream for the dashboard: "change" whenever something happened (a send finished, an email was
 * opened, someone subscribed...), and "notice" for things worth a toast. It polls only while a tab is connected.
 */
export function createLive(db: DB) {
  /** Each stream with the session token it was opened with, so a sign-out or password change ends it. */
  const clients = new Map<ServerResponse, string | undefined>();
  let timer: NodeJS.Timeout | undefined;
  let print = "";
  let lastEvent = 0;
  let ticks = 0;

  const send = (event: string, data: unknown): void => {
    for (const res of clients.keys()) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  function tick(): void {
    for (const [res, token] of clients) if (!sessionValid(db, token)) { clients.delete(res); res.end(); } // the client reconnects, gets a 401 and shows the sign-in screen
    if (clients.size === 0) { clearInterval(timer); timer = undefined; return; }
    try {
      const fp = (db.prepare(FINGERPRINT).get() as { fp: string }).fp;
      if (fp !== print) { print = fp; send("change", {}); }
      const rows = db.prepare("SELECT e.id, e.type, s.email FROM subscriber_events e JOIN subscribers s ON s.id = e.subscriber_id WHERE e.id > ? AND e.type IN ('confirmed', 'unsubscribed', 'bounced') ORDER BY e.id").all(lastEvent) as { id: number; type: string; email: string }[];
      lastEvent = (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM subscriber_events").get() as { m: number }).m;
      if (rows.length > 3) send("notice", { text: `${rows.length} subscriber changes` });
      else for (const r of rows) send("notice", { text: `${NOTICE_TEXT[r.type]}: ${r.email}` });
      if (++ticks % (PING_MS / POLL_MS) === 0) for (const res of clients.keys()) res.write(": ping\n\n"); // keeps proxies from closing an idle stream
    } catch { /* the database is closing */ }
  }

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!sessionValid(db, token)) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"code":"unauthorized"}}'); return; }
    if (clients.size >= MAX_CLIENTS) { res.writeHead(429); res.end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.socket?.setNoDelay(true);
    res.write("retry: 3000\n\n");
    if (clients.size === 0) {
      print = (db.prepare(FINGERPRINT).get() as { fp: string }).fp;
      lastEvent = (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM subscriber_events").get() as { m: number }).m;
      timer = setInterval(tick, POLL_MS);
    }
    clients.set(res, token);
    res.write("event: hello\ndata: {}\n\n");
    res.on("close", () => {
      clients.delete(res);
      if (clients.size === 0) { clearInterval(timer); timer = undefined; }
    });
  };
}
