import { createHash } from "node:crypto";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { ApiError } from "../errors.ts";
import { checkSender, insertEmail, SYSTEM_KEY } from "../emails.ts";
import type { Prepared } from "../emails.ts";
import { now } from "../ids.ts";
import { bus, runtime } from "./bus.ts";
import { baseUrl, getPublication } from "./publication.ts";
import type { Publication } from "./publication.ts";
import { buildVars, merge, renderSimpleEmail } from "./render.ts";
import type { RenderCtx } from "./render.ts";
import { findById } from "./subscribers.ts";
import type { SubscriberRow } from "./subscribers.ts";
import { token } from "./util.ts";

export const senderOf = (pub: Publication, override?: { from_name?: string | null; from_email?: string | null }) => ({
  name: (override?.from_name || pub.from_name || pub.name) || null,
  email: override?.from_email || pub.from_email,
});

/** Throws a clear error if the publication can't send yet. */
export function assertCanSend(db: DB, cfg: Config, pub: Publication, override?: { from_name?: string | null; from_email?: string | null }) {
  const from = senderOf(pub, override);
  if (!from.email) throw new ApiError(409, "sender_missing", "Set the publication's From address in Settings before sending.");
  return { from, domain: checkSender(db, cfg, SYSTEM_KEY, from.email) };
}

export function ctxFor(db: DB, cfg: Config, pub: Publication, subscriber: SubscriberRow | null, extraVars: Record<string, string> = {}): RenderCtx {
  const base = baseUrl(db, cfg, pub);
  return { db, pub, base, mode: "email", subscriber, vars: buildVars(db, pub, base, subscriber, extraVars), dynamic: new Map() };
}

interface SystemMail { to: string; subject: string; html: string; text: string; subscriberId?: string | null; headers?: Record<string, string> }

/** Queues a one-off message Newsnest sends on its own behalf. Returns the email id, or null if sending isn't set up. */
export function sendSystemMail(db: DB, cfg: Config, mail: SystemMail): string | null {
  const pub = getPublication(db);
  try {
    const { from, domain } = assertCanSend(db, cfg, pub);
    const prepared: Prepared = {
      from, to: [{ email: mail.to }], cc: [], bcc: [], replyTo: pub.reply_to ? [pub.reply_to] : [],
      subject: mail.subject, html: mail.html, text: mail.text, headers: mail.headers ?? {}, tags: [], scheduledAt: null, domain,
    };
    const id = insertEmail(db, prepared, SYSTEM_KEY, now(), { kind: "system", subscriber_id: mail.subscriberId ?? null });
    runtime.kick();
    return id;
  } catch (e) {
    console.error(`could not send "${mail.subject}" to ${mail.to}:`, (e as Error).message);
    return null;
  }
}

/** In outbox mode every message is a file on disk, so public sign-ups can't be allowed to write them without limit. */
const MAX_PENDING_IN_OUTBOX = 2000;

export function sendConfirmation(db: DB, cfg: Config, s: SubscriberRow): void {
  if (cfg.mode === "outbox" && (db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'pending'").get() as { n: number }).n > MAX_PENDING_IN_OUTBOX) return;
  const pub = getPublication(db);
  const c = ctxFor(db, cfg, pub, s);
  const url = `${c.base}/confirm/${s.token}`;
  const subject = `Confirm your subscription to ${pub.name}`;
  const doc = renderSimpleEmail(c, {
    subject, unsubscribe: false, footerNote: "If you didn't ask for this, ignore this email and you won't be subscribed.",
    markdown: `Please confirm that you want to receive **${pub.name}**.`, buttonLabel: "Confirm subscription", buttonUrl: url,
  });
  sendSystemMail(db, cfg, { to: s.email, subject, ...doc, subscriberId: s.id });
}

export function sendWelcome(db: DB, cfg: Config, s: SubscriberRow): void {
  const pub = getPublication(db);
  if (!pub.welcome_enabled || !pub.welcome_body.trim()) return;
  const c = ctxFor(db, cfg, pub, s);
  const subject = merge(pub.welcome_subject, c.vars);
  const doc = renderSimpleEmail(c, { subject, markdown: merge(pub.welcome_body, c.vars) });
  sendSystemMail(db, cfg, { to: s.email, subject, ...doc, subscriberId: s.id, headers: unsubscribeHeaders(c.base, s.token, null) });
}

export function sendMagicLink(db: DB, cfg: Config, s: SubscriberRow, redirect = "/"): void {
  const pub = getPublication(db);
  const c = ctxFor(db, cfg, pub, s);
  const raw = token(24);
  db.prepare("INSERT INTO magic_tokens (id, subscriber_id, redirect, expires_at) VALUES (?, ?, ?, ?)").run(hash(raw), s.id, redirect.startsWith("/") ? redirect : "/", now() + 20 * 60_000);
  const subject = `Your sign-in link for ${pub.name}`;
  const doc = renderSimpleEmail(c, {
    subject, unsubscribe: false, footerNote: "This link works once and expires in 20 minutes. If you didn't ask for it, ignore this email.",
    markdown: "Use this link to sign in and read the full post.", buttonLabel: "Sign in", buttonUrl: `${c.base}/magic/${raw}`,
  });
  sendSystemMail(db, cfg, { to: s.email, subject, ...doc, subscriberId: s.id });
}

export function unsubscribeHeaders(base: string, tok: string, postId: string | null): Record<string, string> {
  return {
    "List-Unsubscribe": `<${base}/u/${tok}${postId ? `?p=${postId}` : ""}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export const hash = (v: string): string => createHash("sha256").update(v).digest("hex");

/** Wire the system emails to the events that cause them. Called once at start. */
export function registerMailers(): void {
  bus.on("subscriber.pending", ({ db, cfg }, p: { subscriberId: string }) => sendConfirmation(db, cfg, findById(db, p.subscriberId)));
  bus.on("subscriber.confirmed", ({ db, cfg }, p: { subscriberId: string; welcome?: boolean }) => { if (p.welcome !== false) sendWelcome(db, cfg, findById(db, p.subscriberId)); });
}
