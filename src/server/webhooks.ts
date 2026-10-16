import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";
import { notFound, validation } from "./errors.ts";
import { EVENT_TYPES } from "./events.ts";
import { iso, newId, now } from "./ids.ts";

interface WebhookRow { id: string; url: string; events: string; secret: string; enabled: number; created_at: number }

const BACKOFF_MS = [10_000, 60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];

function view(row: WebhookRow, withSecret = false) {
  return {
    id: row.id,
    object: "webhook",
    url: row.url,
    events: JSON.parse(row.events) as string[],
    enabled: row.enabled === 1,
    created_at: iso(row.created_at),
    ...(withSecret ? { secret: row.secret } : {}),
  };
}

function parseInput(body: Record<string, unknown>, partial: boolean) {
  const out: { url?: string; events?: string[]; enabled?: boolean } = {};
  if (!partial || body.url !== undefined) {
    let url: URL;
    try { url = new URL(String(body.url)); } catch { throw validation(`"url" must be a valid URL`); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw validation(`"url" must start with http:// or https://`);
    out.url = url.toString();
  }
  if (body.events !== undefined) {
    if (!Array.isArray(body.events) || body.events.some((e) => !(EVENT_TYPES as readonly unknown[]).includes(e))) {
      throw validation(`"events" must be an array of: ${EVENT_TYPES.join(", ")}`);
    }
    out.events = body.events as string[];
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw validation(`"enabled" must be a boolean`);
    out.enabled = body.enabled;
  }
  return out;
}

export function createWebhook(db: DB, body: Record<string, unknown>) {
  const input = parseInput(body, false);
  const id = newId("wh");
  const secret = "whsec_" + randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO webhooks (id, url, events, secret, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)")
    .run(id, input.url!, JSON.stringify(input.events ?? []), secret, now());
  return view(getRow(db, id), true);
}

function getRow(db: DB, id: string): WebhookRow {
  const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as WebhookRow | undefined;
  if (!row) throw notFound("Webhook");
  return row;
}

export const getWebhook = (db: DB, id: string) => view(getRow(db, id));

export const listWebhooks = (db: DB) =>
  (db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all() as unknown as WebhookRow[]).map((r) => view(r));

export function updateWebhook(db: DB, id: string, body: Record<string, unknown>) {
  const row = getRow(db, id);
  const input = parseInput(body, true);
  db.prepare("UPDATE webhooks SET url = ?, events = ?, enabled = ? WHERE id = ?").run(
    input.url ?? row.url,
    input.events ? JSON.stringify(input.events) : row.events,
    input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
    id,
  );
  return view(getRow(db, id));
}

export function deleteWebhook(db: DB, id: string) {
  getRow(db, id);
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
  return { id, object: "webhook", deleted: true };
}

// ---- signing -----------------------------------------------------------------
// newsnest-signature: v1,<base64 HMAC-SHA256 of `${newsnest-id}.${newsnest-timestamp}.${body}`> keyed with the webhook secret.
export const signPayload = (secret: string, id: string, timestamp: string, body: string): string =>
  "v1," + createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64");

/** For receivers: verify a request with the headers and raw body you received. */
export function verifySignature(secret: string, headers: { id: string; timestamp: string; signature: string }, body: string, toleranceSec = 300): boolean {
  if (Math.abs(Date.now() / 1000 - Number(headers.timestamp)) > toleranceSec) return false;
  const want = Buffer.from(signPayload(secret, headers.id, headers.timestamp, body));
  return headers.signature.split(" ").some((sig) => {
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

// ---- delivery ----------------------------------------------------------------
export type Fetch = typeof fetch;

interface Due {
  id: string;
  attempts: number;
  webhook_id: string;
  event_id: string;
}

export async function processWebhooks(db: DB, doFetch: Fetch = fetch, limit = 10): Promise<number> {
  const at = now();
  const due = db.prepare(`
    UPDATE webhook_attempts SET status = 'sending', attempts = attempts + 1
    WHERE id IN (SELECT id FROM webhook_attempts WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?)
    RETURNING id, attempts, webhook_id, event_id`).all(at, limit) as unknown as Due[];

  await Promise.allSettled(due.map((d) => deliverWebhook(db, d, doFetch)));
  return due.length;
}

async function deliverWebhook(db: DB, d: Due, doFetch: Fetch): Promise<void> {
  const hook = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(d.webhook_id) as WebhookRow | undefined;
  const ev = db.prepare(`
    SELECT events.*, emails.from_name, emails.from_email, emails.subject, emails.tags, emails.created_at AS email_created
    FROM events JOIN emails ON emails.id = events.email_id WHERE events.id = ?`).get(d.event_id) as Record<string, string | number | null> | undefined;
  if (!hook || !ev || !hook.enabled) {
    db.prepare("UPDATE webhook_attempts SET status = 'failed', last_error = 'webhook or event no longer exists or is disabled' WHERE id = ?").run(d.id);
    return;
  }

  const body = JSON.stringify({
    type: ev.type,
    created_at: iso(ev.created_at as number),
    data: {
      email_id: ev.email_id,
      from: ev.from_name ? `${ev.from_name} <${ev.from_email}>` : ev.from_email,
      to: ev.recipient ? [ev.recipient] : [],
      subject: ev.subject,
      tags: JSON.parse(ev.tags as string),
      created_at: iso(ev.email_created as number),
      ...JSON.parse(ev.data as string),
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));

  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await doFetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Newsnest-Webhooks/1",
        "newsnest-id": d.event_id,
        "newsnest-timestamp": timestamp,
        "newsnest-signature": signPayload(hook.secret, d.event_id, timestamp, body),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message;
  }

  if (!error) {
    db.prepare("UPDATE webhook_attempts SET status = 'delivered', last_status = ?, last_error = NULL WHERE id = ?").run(status, d.id);
  } else if (d.attempts > BACKOFF_MS.length) {
    db.prepare("UPDATE webhook_attempts SET status = 'failed', last_status = ?, last_error = ? WHERE id = ?").run(status, error, d.id);
  } else {
    db.prepare("UPDATE webhook_attempts SET status = 'queued', next_attempt_at = ?, last_status = ?, last_error = ? WHERE id = ?")
      .run(now() + BACKOFF_MS[d.attempts - 1], status, error, d.id);
  }
}
