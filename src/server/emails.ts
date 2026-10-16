import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import { tx } from "./db.ts";
import type { DB } from "./db.ts";
import type { DomainRow } from "./domains.ts";
import { ApiError, notFound, validation } from "./errors.ts";
import { emit } from "./events.ts";
import { iso, newId, now } from "./ids.ts";
import { renderStoredEmail } from "./newsletter/delivery.ts";
import type { ApiKeyInfo } from "./keys.ts";
import { esc, htmlToText, markdownDocument, toText } from "./markdown.ts";
import type { Address } from "./mime.ts";
import { normalizeEmail, parseAddress, parseAddressList, parseHeaders, parseScheduledAt, parseTags, str } from "./validate.ts";
import type { Tag } from "./validate.ts";

const MAX_RECIPIENTS = 50;
export const MAX_BATCH = 100;

export interface Prepared {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: string[];
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  tags: Tag[];
  scheduledAt: number | null;
  domain: DomainRow | null;
}

/** The sender's domain row (for DKIM), or an error if mail from this address may not be sent. */
export function checkSender(db: DB, cfg: Config, key: ApiKeyInfo, fromEmail: string): DomainRow | null {
  const fromDomain = normalizeEmail(fromEmail).split("@")[1];
  const domain = (db.prepare("SELECT * FROM domains WHERE name = ?").get(fromDomain) as unknown as DomainRow | undefined) ?? null;
  if (cfg.mode !== "outbox" && domain?.status !== "verified") {
    throw new ApiError(403, "domain_not_verified", `The domain ${fromDomain} is not verified. Add it and publish its DNS records first.`);
  }
  if (key.domain_id && domain?.id !== key.domain_id) {
    throw new ApiError(403, "restricted_domain", `This API key can only send from its own domain`);
  }
  return domain;
}

/** Validates one API payload and resolves everything the insert needs. Throws ApiError. */
export function prepareEmail(db: DB, cfg: Config, key: ApiKeyInfo, input: unknown, at: number): Prepared {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw validation("Request body must be a JSON object");
  const b = input as Record<string, unknown>;

  const from = parseAddress(b.from, "from");
  const to = parseAddressList(b.to, "to", { required: true });
  const cc = parseAddressList(b.cc, "cc");
  const bcc = parseAddressList(b.bcc, "bcc");
  const replyTo = parseAddressList(b.reply_to, "reply_to").map((a) => (a.name ? `${a.name} <${a.email}>` : a.email));
  const subject = str(b.subject, "subject", { max: 998, required: true })!;

  const recipients = new Set([...to, ...cc, ...bcc].map((a) => normalizeEmail(a.email)));
  if (recipients.size > MAX_RECIPIENTS) throw validation(`At most ${MAX_RECIPIENTS} recipients per email`);

  const html = str(b.html, "html");
  const text = str(b.text, "text");
  const markdown = str(b.markdown, "markdown");
  if (!html && !text && !markdown) throw validation(`Provide "html", "text" or "markdown"`);
  if (html && markdown) throw validation(`Use either "html" or "markdown", not both`);

  let outHtml: string;
  let outText: string;
  if (markdown) {
    outHtml = markdownDocument(subject, markdown);
    outText = text ?? toText(markdown);
  } else if (html) {
    outHtml = html;
    outText = text ?? htmlToText(html);
  } else {
    outText = text!;
    outHtml = `<div style="white-space:pre-wrap;font:16px/1.6 -apple-system,Helvetica,Arial,sans-serif;">${esc(text!)}</div>`;
  }

  const domain = checkSender(db, cfg, key, from.email);

  return {
    from, to, cc, bcc, replyTo, subject, html: outHtml, text: outText,
    headers: parseHeaders(b.headers),
    tags: parseTags(b.tags),
    scheduledAt: parseScheduledAt(b.scheduled_at, at),
    domain,
  };
}

/** Inserts the email and one delivery per recipient. Call inside a transaction. */
export interface EmailExtra {
  kind?: "api" | "broadcast" | "automation" | "system";
  post_id?: string | null;
  subscriber_id?: string | null;
  variant?: string | null;
  automation_run_id?: string | null;
}

/** Key used for mail Freepost sends itself (confirmations, newsletters, automations). */
export const SYSTEM_KEY: ApiKeyInfo = { id: "system", permission: "full", domain_id: null, session: true };

export function insertEmail(db: DB, p: Prepared, key: ApiKeyInfo, at: number, extra: EmailExtra = {}): string {
  const id = newId("em");
  const domainName = normalizeEmail(p.from.email).split("@")[1];
  const messageId = `<${at.toString(36)}.${randomBytes(9).toString("hex")}@${domainName}>`;
  const firstEvent = p.scheduledAt ? "email.scheduled" : "email.queued";

  db.prepare(`INSERT INTO emails (id, api_key_id, domain_id, from_name, from_email, subject, html, text, reply_to, headers, tags,
      to_json, cc_json, bcc_json, message_id, scheduled_at, last_event, created_at, kind, post_id, subscriber_id, variant, automation_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, key.session ? null : key.id, p.domain?.id ?? null, p.from.name ?? null, p.from.email, p.subject, p.html, p.text,
    JSON.stringify(p.replyTo), JSON.stringify(p.headers), JSON.stringify(p.tags),
    JSON.stringify(p.to), JSON.stringify(p.cc), JSON.stringify(p.bcc), messageId, p.scheduledAt, firstEvent, at,
    extra.kind ?? "api", extra.post_id ?? null, extra.subscriber_id ?? null, extra.variant ?? null, extra.automation_run_id ?? null,
  );
  emit(db, id, firstEvent, null);

  const seen = new Set<string>();
  for (const addr of [...p.to, ...p.cc, ...p.bcc]) {
    const recipient = normalizeEmail(addr.email);
    if (seen.has(recipient)) continue;
    seen.add(recipient);

    const suppressed = db.prepare("SELECT reason FROM suppressions WHERE email = ?").get(recipient) as { reason: string } | undefined;
    db.prepare("INSERT INTO deliveries (id, email_id, recipient, status, next_attempt_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId("dlv"), id, recipient, suppressed ? "suppressed" : "queued", p.scheduledAt ?? at, at);
    if (extra.kind === "broadcast" || extra.kind === "automation") db.prepare("UPDATE deliveries SET bulk = 1 WHERE email_id = ?").run(id);
    if (suppressed) emit(db, id, "email.suppressed", recipient, { reason: suppressed.reason });
  }
  return id;
}

export function sendEmail(db: DB, cfg: Config, key: ApiKeyInfo, input: unknown): { id: string } {
  const at = now();
  const prepared = prepareEmail(db, cfg, key, input, at);
  return { id: tx(db, () => insertEmail(db, prepared, key, at)) };
}

/** All-or-nothing: one invalid email rejects the whole batch. */
export function sendBatch(db: DB, cfg: Config, key: ApiKeyInfo, input: unknown): { data: { id: string }[] } {
  if (!Array.isArray(input) || input.length === 0) throw validation("Batch body must be a non-empty array of emails");
  if (input.length > MAX_BATCH) throw validation(`At most ${MAX_BATCH} emails per batch`);
  const at = now();
  const prepared = input.map((item, i) => {
    try {
      return prepareEmail(db, cfg, key, item, at);
    } catch (e) {
      if (e instanceof ApiError) e.message = `Email ${i}: ${e.message}`;
      throw e;
    }
  });
  return { data: tx(db, () => prepared.map((p) => ({ id: insertEmail(db, p, key, at) }))) };
}

// ---- reading -----------------------------------------------------------------
interface EmailRow {
  id: string; from_name: string | null; from_email: string; subject: string; html: string; text: string;
  reply_to: string; headers: string; tags: string; to_json: string; cc_json: string; bcc_json: string;
  message_id: string; scheduled_at: number | null; last_event: string; created_at: number;
  kind: string; post_id: string | null; subscriber_id: string | null; variant: string | null; automation_run_id: string | null;
}
interface DeliveryRow { recipient: string; status: string; attempts: number; last_error: string | null; response: string | null; updated_at: number }

/** Newsletter and automation mail is rendered when it is sent, so the stored copy is empty. Rebuild it for display. */
function stored(db: DB, cfg: Config | undefined, r: EmailRow): { html: string; text: string } {
  if (r.html || !cfg || !(r.post_id || r.kind === "automation")) return { html: r.html, text: r.text };
  try { return renderStoredEmail(db, cfg, r) ?? { html: "", text: "" }; } catch { return { html: "", text: "" }; }
}

const addr = (a: Address): string => (a.name ? `${a.name} <${a.email}>` : a.email);
const fromOf = (r: EmailRow): string => addr({ name: r.from_name, email: r.from_email });

function summary(r: EmailRow) {
  return {
    id: r.id,
    object: "email",
    from: fromOf(r),
    to: (JSON.parse(r.to_json) as Address[]).map(addr),
    subject: r.subject,
    last_event: r.last_event,
    kind: r.kind,
    scheduled_at: iso(r.scheduled_at),
    created_at: iso(r.created_at),
  };
}

export function getEmail(db: DB, id: string, cfg?: Config) {
  const r = db.prepare("SELECT * FROM emails WHERE id = ?").get(id) as unknown as EmailRow | undefined;
  if (!r) throw notFound("Email");
  const deliveries = db.prepare("SELECT * FROM deliveries WHERE email_id = ? ORDER BY rowid").all(id) as unknown as DeliveryRow[];
  return {
    ...summary(r),
    cc: (JSON.parse(r.cc_json) as Address[]).map(addr),
    bcc: (JSON.parse(r.bcc_json) as Address[]).map(addr),
    reply_to: JSON.parse(r.reply_to) as string[],
    ...stored(db, cfg, r),
    headers: JSON.parse(r.headers) as Record<string, string>,
    tags: JSON.parse(r.tags) as Tag[],
    message_id: r.message_id,
    deliveries: deliveries.map((d) => ({
      to: d.recipient,
      status: d.status,
      attempts: d.attempts,
      error: d.last_error,
      response: d.response,
      updated_at: iso(d.updated_at),
    })),
  };
}

export function listEmails(db: DB, query: URLSearchParams) {
  const kind = query.get("kind") ?? "api";
  if (!["api", "broadcast", "automation", "system", "all"].includes(kind)) throw validation(`"kind" must be api, broadcast, automation, system or all`);
  const limit = Math.min(Math.max(Number(query.get("limit") ?? 20) || 20, 1), 100);
  const after = query.get("after");
  const cursor = after ? (db.prepare("SELECT rowid AS r FROM emails WHERE id = ?").get(after) as { r: number } | undefined) : undefined;
  if (after && !cursor) throw validation(`Unknown "after" id`);

  const where = [kind === "all" ? "" : "kind = ?", cursor ? "rowid < ?" : ""].filter(Boolean);
  const args: unknown[] = [...(kind === "all" ? [] : [kind]), ...(cursor ? [cursor.r] : []), limit + 1];
  const rows = db.prepare(`SELECT * FROM emails ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT ?`).all(...(args as never[])) as unknown as EmailRow[];
  return { object: "list", has_more: rows.length > limit, data: rows.slice(0, limit).map(summary) };
}

export function listEmailEvents(db: DB, id: string) {
  if (!db.prepare("SELECT 1 FROM emails WHERE id = ?").get(id)) throw notFound("Email");
  const rows = db.prepare("SELECT * FROM events WHERE email_id = ? ORDER BY rowid").all(id) as unknown as
    { id: string; type: string; recipient: string | null; data: string; created_at: number }[];
  return {
    object: "list",
    data: rows.map((e) => ({ id: e.id, type: e.type, to: e.recipient, data: JSON.parse(e.data), created_at: iso(e.created_at) })),
  };
}

// ---- changing ----------------------------------------------------------------
/** Only emails that no delivery attempt has touched yet can be changed. */
function assertUntouched(db: DB, id: string): void {
  const r = db.prepare("SELECT 1 FROM emails WHERE id = ?").get(id);
  if (!r) throw notFound("Email");
  const started = db.prepare("SELECT 1 FROM deliveries WHERE email_id = ? AND (status NOT IN ('queued', 'suppressed') OR attempts > 0)").get(id);
  if (started) throw new ApiError(409, "not_cancelable", "This email has already started sending");
}

export function cancelEmail(db: DB, id: string) {
  return tx(db, () => {
    assertUntouched(db, id);
    db.prepare("UPDATE deliveries SET status = 'canceled', updated_at = ? WHERE email_id = ? AND status = 'queued'").run(now(), id);
    emit(db, id, "email.canceled", null);
    return { id, object: "email", canceled: true };
  });
}

export function rescheduleEmail(db: DB, id: string, body: Record<string, unknown>) {
  const at = now();
  const scheduledAt = parseScheduledAt(body.scheduled_at, at);
  return tx(db, () => {
    assertUntouched(db, id);
    db.prepare("UPDATE emails SET scheduled_at = ?, last_event = ? WHERE id = ?").run(scheduledAt, scheduledAt ? "email.scheduled" : "email.queued", id);
    db.prepare("UPDATE deliveries SET next_attempt_at = ?, updated_at = ? WHERE email_id = ? AND status = 'queued'").run(scheduledAt ?? at, at, id);
    return { id, object: "email", scheduled_at: iso(scheduledAt) };
  });
}

// ---- suppressions ------------------------------------------------------------
export function addSuppression(db: DB, email: string, reason: "bounce" | "complaint" | "manual", detail: string | null = null): void {
  db.prepare("INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET reason = excluded.reason, detail = excluded.detail")
    .run(normalizeEmail(email), reason, detail, now());
}

export function listSuppressions(db: DB) {
  const rows = db.prepare("SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 1000").all() as unknown as
    { email: string; reason: string; detail: string | null; created_at: number }[];
  return { object: "list", data: rows.map((r) => ({ email: r.email, reason: r.reason, detail: r.detail, created_at: iso(r.created_at) })) };
}

export function removeSuppression(db: DB, email: string) {
  const res = db.prepare("DELETE FROM suppressions WHERE email = ?").run(normalizeEmail(email));
  if (!res.changes) throw notFound("Suppression");
  return { email: normalizeEmail(email), object: "suppression", deleted: true };
}
