import type { DB } from "./db.ts";
import { newId, now } from "./ids.ts";

export const EVENT_TYPES = [
  "email.scheduled",
  "email.queued",
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.failed",
  "email.suppressed",
  "email.canceled",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Records an event, updates the email's `last_event`, and queues a webhook
 * attempt for every enabled webhook that listens for it. Call inside a transaction.
 */
export function emit(db: DB, emailId: string, type: EventType, recipient: string | null, data: Record<string, unknown> = {}): string {
  const id = newId("evt");
  const at = now();
  db.prepare("INSERT INTO events (id, email_id, type, recipient, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, emailId, type, recipient, JSON.stringify(data), at);
  db.prepare("UPDATE emails SET last_event = ? WHERE id = ?").run(type, emailId);

  const hooks = db.prepare("SELECT id, events FROM webhooks WHERE enabled = 1").all() as { id: string; events: string }[];
  for (const hook of hooks) {
    const wanted = JSON.parse(hook.events) as string[];
    if (wanted.length && !wanted.includes(type)) continue;
    db.prepare("INSERT INTO webhook_attempts (id, webhook_id, event_id, status, next_attempt_at) VALUES (?, ?, ?, 'queued', ?)")
      .run(newId("wha"), hook.id, id, at);
  }
  return id;
}
