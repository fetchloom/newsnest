import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { tx } from "./db.ts";
import type { DB } from "./db.ts";
import type { DomainRow } from "./domains.ts";
import { addSuppression } from "./emails.ts";
import { emit } from "./events.ts";
import { broadcastTick } from "./newsletter/broadcast.ts";
import { renderStoredEmail } from "./newsletter/delivery.ts";
import { markBounced } from "./newsletter/subscribers.ts";
import { automationTick } from "./newsletter/automations.ts";
import { purgeStale } from "./newsletter/maintenance.ts";
import { now } from "./ids.ts";
import { build } from "./mime.ts";
import type { Address } from "./mime.ts";
import { SMTPError, parseRelayUrl, send, sendDirect } from "./smtp.ts";
import { processWebhooks } from "./webhooks.ts";
import type { Fetch } from "./webhooks.ts";

export interface Transport {
  deliver(msg: { from: string; to: string; raw: string; id: string }): Promise<{ response: string; delivered: boolean }>;
}

/** How long one pass waits for its deliveries before moving on; a slow one keeps going in the background. */
const PASS_WAIT_MS = 2000;
/** Safety net around a transport that never answers. The SMTP client has its own, shorter deadline. */
const DELIVERY_TIMEOUT_MS = 4 * 60_000;
const MAX_IN_FLIGHT = 40;

const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 3600_000, 4 * 3600_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

export function makeTransport(cfg: Config): Transport {
  if (cfg.mode === "outbox") {
    const dir = join(cfg.dataDir, "outbox");
    return {
      async deliver({ id, raw }) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}.eml`), raw);
        return { response: `written to outbox/${id}.eml`, delivered: false };
      },
    };
  }
  if (cfg.mode === "relay") {
    const relay = parseRelayUrl(cfg.relayUrl!);
    return {
      async deliver({ from, to, raw }) {
        const r = await send({ ...relay, ehloName: cfg.ehloName, from, to: [to], raw });
        return { response: r.response, delivered: false }; // the relay accepted it; we can't see past that
      },
    };
  }
  return {
    async deliver({ from, to, raw }) {
      const r = await sendDirect({ from, to, raw, ehloName: cfg.ehloName });
      return { response: r.response, delivered: true };
    },
  };
}

interface Claimed { id: string; email_id: string; recipient: string; attempts: number }
interface EmailRow {
  id: string; kind: string; post_id: string | null; subscriber_id: string | null; variant: string | null; automation_run_id: string | null; domain_id: string | null; from_name: string | null; from_email: string; subject: string; html: string; text: string;
  reply_to: string; headers: string; to_json: string; cc_json: string; message_id: string; created_at: number;
}

export interface Queue { tick(): Promise<void>; kick(): void; stop(): Promise<void> }

export function startQueue(db: DB, cfg: Config, transport: Transport = makeTransport(cfg), doFetch: Fetch = fetch): Queue {
  // A crash can leave rows mid-flight; put them back.
  db.prepare("UPDATE deliveries SET status = 'queued' WHERE status = 'sending'").run();
  db.prepare("UPDATE webhook_attempts SET status = 'queued' WHERE status = 'sending'").run();

  let running = false;
  let again = false;
  let stopped = false;
  let windowStart = 0;
  let bulkUsed = 0;
  /** Newsletter and automation mail is paced (NEWSNEST_SEND_RATE per second). API mail is not. */
  const bulkBudget = (): number => {
    const t = Date.now();
    if (t - windowStart >= 1000) { windowStart = t; bulkUsed = 0; }
    return Math.max(0, cfg.sendRatePerSec - bulkUsed);
  };

  let current: Promise<void> | null = null;
  let lastPurge = 0;
  /** Deliveries still running. They outlive the pass that started them, so one stuck server can't hold up everything else. */
  const inFlight = new Set<Promise<void>>();

  /** Runs one pass. If a pass is already running, asks it to go round again and waits for it. */
  function tick(): Promise<void> {
    if (current) { again = true; return current; }
    current = pass().finally(() => { current = null; });
    return current;
  }

  async function pass(): Promise<void> {
    running = true;
    try {
      do {
        again = false;
        const at = now();
        if (at - lastPurge > 3600_000) { lastPurge = at; try { purgeStale(db, cfg, at); } catch (e) { console.error("cleanup:", e); } }
        const planned = broadcastTick(db, cfg);
        const automated = automationTick(db, cfg);
        const claim = (bulk: number, limit: number): Claimed[] => limit <= 0 ? [] : db.prepare(`
          UPDATE deliveries SET status = 'sending', attempts = attempts + 1, updated_at = ?
          WHERE id IN (SELECT id FROM deliveries WHERE status = 'queued' AND bulk = ? AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?)
          RETURNING id, email_id, recipient, attempts`).all(at, bulk, at, limit) as unknown as Claimed[];
        const room = Math.max(0, MAX_IN_FLIGHT - inFlight.size);
        const direct = claim(0, Math.min(10, room));
        const bulk = claim(1, Math.min(10, bulkBudget(), room - direct.length));
        bulkUsed += bulk.length;
        const claimed = [...direct, ...bulk];
        const started = claimed.map((d) => {
          const p: Promise<void> = deliverOne(db, cfg, transport, d)
            .catch((e) => console.error("delivery:", e))
            .finally(() => { inFlight.delete(p); });
          inFlight.add(p);
          return p;
        });
        let waitTimer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.all(started), new Promise((r) => { waitTimer = setTimeout(r, PASS_WAIT_MS); })]);
        clearTimeout(waitTimer);
        const hooks = await processWebhooks(db, doFetch);
        if (claimed.length || hooks || planned || automated) again = bulkBudget() > 0 || direct.length > 0; // more work may be waiting
      } while (again);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => !stopped && void tick().catch((e) => console.error("queue:", e)), cfg.workerIntervalMs);
  timer.unref();
  return {
    tick,
    kick: () => void setImmediate(() => !stopped && void tick().catch((e) => console.error("queue:", e))),
    stop: async () => {
      clearInterval(timer);
      stopped = true;
      await current;
      await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => setTimeout(r, 10_000).unref())]); // don't close the database under a running delivery
    },
  };
}

async function deliverOne(db: DB, cfg: Config, transport: Transport, d: Claimed): Promise<void> {
  const email = db.prepare("SELECT * FROM emails WHERE id = ?").get(d.email_id) as unknown as EmailRow | undefined;
  if (!email) return;

  let content = { html: email.html, text: email.text };
  if (email.post_id || email.kind === "automation") {
    const rendered = renderStoredEmail(db, cfg, email);
    if (!rendered) return finish(db, d, "failed", "The post, automation or subscriber no longer exists", "email.failed");
    content = rendered;
  }

  let raw: string;
  try {
    const domain = email.domain_id
      ? (db.prepare("SELECT * FROM domains WHERE id = ?").get(email.domain_id) as unknown as DomainRow | undefined)
      : undefined;
    raw = build({
      from: { name: email.from_name, email: email.from_email },
      to: JSON.parse(email.to_json) as Address[],
      cc: JSON.parse(email.cc_json) as Address[],
      replyTo: JSON.parse(email.reply_to) as string[],
      subject: email.subject,
      html: content.html,
      text: content.text,
      headers: JSON.parse(email.headers) as Record<string, string>,
      messageId: email.message_id,
      dkim: domain ? { domain: domain.name, selector: domain.selector, privateKey: domain.dkim_private } : null,
    });
  } catch (e) {
    return finish(db, d, "failed", `Could not build message: ${(e as Error).message}`, "email.failed");
  }

  try {
    let timer: NodeJS.Timeout | undefined;
    const r = await Promise.race([
      transport.deliver({ from: email.from_email, to: d.recipient, raw, id: d.id }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SMTPError("Delivery timed out")), DELIVERY_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    tx(db, () => {
      db.prepare("UPDATE deliveries SET status = ?, response = ?, last_error = NULL, updated_at = ? WHERE id = ?")
        .run(r.delivered ? "delivered" : "sent", r.response, now(), d.id);
      emit(db, d.email_id, "email.sent", d.recipient, { response: r.response });
      if (email.subscriber_id && (email.kind === "broadcast" || email.kind === "automation")) db.prepare("UPDATE subscribers SET emails_received = emails_received + 1 WHERE id = ?").run(email.subscriber_id);
      if (r.delivered) emit(db, d.email_id, "email.delivered", d.recipient, { response: r.response });
    });
  } catch (e) {
    const err = e as SMTPError;
    const message = err.message || String(e);
    if (err.permanent) {
      tx(db, () => {
        addSuppression(db, d.recipient, "bounce", message);
        markBounced(db, d.recipient);
        finish(db, d, "bounced", message, "email.bounced", { code: err.code, stage: err.stage });
      });
    } else if (d.attempts >= MAX_ATTEMPTS) {
      finish(db, d, "failed", message, "email.failed");
    } else {
      tx(db, () => {
        db.prepare("UPDATE deliveries SET status = 'queued', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
          .run(now() + BACKOFF_MS[d.attempts - 1], message, now(), d.id);
        if (d.attempts === 1) emit(db, d.email_id, "email.delivery_delayed", d.recipient, { message });
      });
    }
  }
}

function finish(db: DB, d: Claimed, status: string, error: string, type: "email.bounced" | "email.failed", extra: Record<string, unknown> = {}): void {
  tx(db, () => {
    db.prepare("UPDATE deliveries SET status = ?, last_error = ?, updated_at = ? WHERE id = ?").run(status, error, now(), d.id);
    emit(db, d.email_id, type, d.recipient, { message: error, ...extra });
  });
}
