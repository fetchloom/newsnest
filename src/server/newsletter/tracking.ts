import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";
import { bus } from "./bus.ts";
import type { Publication } from "./publication.ts";
import { token } from "./util.ts";

/** Security scanners and link previewers fetch every link in a message. Their clicks aren't a person reading it. */
const BOT_UA = /(barracuda|proofpoint|mimecast|microsoft office|safelinks|bingpreview|googlebot|\bbot\b|crawler|spider|curl\/|wget|python-requests|java\/|go-http-client|headlesschrome|slackbot|facebookexternalhit|linkedinbot|twitterbot|skypeuripreview|mailscanner|trend micro|symantec|forcepoint|cisco|urlscan|zscaler|ironscales|avanan)/i;
const MOBILE_UA = /(iphone|ipad|android|mobile)/i;
// Links back into the site that are not a reader's own choice of destination (including "View in browser") are never rewritten.
const SKIP_PATH = /^\/(u|confirm|magic|poll|s|l|o|p|subscribe|login)(\/|$)/;

const linkCache = new Map<string, string>();

function linkId(db: DB, scope: string, url: string): string {
  const key = `${scope}\n${url}`;
  const hit = linkCache.get(key);
  if (hit) return hit;
  db.prepare("INSERT OR IGNORE INTO links (id, scope, url) VALUES (?, ?, ?)").run("lnk_" + token(7), scope, url);
  const row = db.prepare("SELECT id FROM links WHERE scope = ? AND url = ?").get(scope, url) as { id: string };
  if (linkCache.size > 5000) linkCache.clear();
  linkCache.set(key, row.id);
  return row.id;
}

export function withUtm(url: string, pub: Publication, campaign: string): string {
  try {
    const u = new URL(url);
    if (!pub.utm_links || u.searchParams.has("utm_source")) return url;
    u.searchParams.set("utm_source", pub.slug);
    u.searchParams.set("utm_medium", "email");
    u.searchParams.set("utm_campaign", campaign);
    return u.toString();
  } catch { return url; }
}

/** Rewrites every outbound link in a message to a tracked redirect. Self-service links (unsubscribe, polls) are left alone. */
export function trackHtml(db: DB, html: string, o: { scope: string; emailId: string; base: string; pub: Publication; campaign: string }): string {
  if (!o.pub.track_clicks && !o.pub.utm_links) return html;
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (whole, raw: string) => {
    const url = raw.replace(/&amp;/g, "&");
    let parsed: URL;
    try { parsed = new URL(url); } catch { return whole; }
    if (url.startsWith(o.base) && SKIP_PATH.test(parsed.pathname)) return whole;
    const target = withUtm(url, o.pub, o.campaign);
    if (!o.pub.track_clicks) return `href="${target.replace(/&/g, "&amp;")}"`;
    return `href="${o.base}/l/${linkId(db, o.scope, target)}/${o.emailId}"`;
  });
}

export const pixelUrl = (base: string, emailId: string): string => `${base}/o/${emailId}.gif`;

interface EmailRow { id: string; subscriber_id: string | null; post_id: string | null; kind: string; to_json: string }

const emailRow = (db: DB, id: string): EmailRow | undefined =>
  db.prepare("SELECT id, subscriber_id, post_id, kind, to_json FROM emails WHERE id = ?").get(id) as unknown as EmailRow | undefined;

const recipientOf = (e: EmailRow): string => (JSON.parse(e.to_json) as { email: string }[])[0]?.email ?? "";

/** Repeat opens of one email inside this window are one open: image proxies and impatient refreshes shouldn't write a row and fire a webhook each. */
const OPEN_COLLAPSE_MS = 5 * 60_000;

export function recordOpen(db: DB, cfg: Config, emailId: string, ua: string): void {
  const e = emailRow(db, emailId);
  if (!e) return;
  if (db.prepare("SELECT 1 FROM events WHERE email_id = ? AND type = 'email.opened' AND created_at > ? LIMIT 1").get(emailId, now() - OPEN_COLLAPSE_MS)) return;
  const first = !db.prepare("SELECT 1 FROM events WHERE email_id = ? AND type = 'email.opened' LIMIT 1").get(emailId);
  const proxy = /(googleimageproxy|yahoomailproxy|applemail|ggpht)/i.test(ua) ? "image-proxy" : null;
  emit(db, emailId, "email.opened", recipientOf(e), { ua: ua.slice(0, 200), proxy, device: MOBILE_UA.test(ua) ? "mobile" : "desktop" });
  if (e.subscriber_id) {
    const at = now();
    db.prepare("UPDATE subscribers SET opens = opens + ?, last_open_at = ? WHERE id = ?").run(first ? 1 : 0, at, e.subscriber_id);
  }
}

/** Where a tracked link goes, without recording anything (used when the click is over the rate limit). */
export function linkTarget(db: DB, linkIdValue: string): string | null {
  return (db.prepare("SELECT url FROM links WHERE id = ?").get(linkIdValue) as { url: string } | undefined)?.url ?? null;
}

/** Returns where to send the reader, or null if the link is unknown. */
export function recordClick(db: DB, cfg: Config, linkIdValue: string, emailId: string, ua: string): string | null {
  const link = db.prepare("SELECT url FROM links WHERE id = ?").get(linkIdValue) as { url: string } | undefined;
  if (!link) return null;
  const e = emailRow(db, emailId);
  if (!e) return link.url;

  const at = now();
  const sentAt = (db.prepare("SELECT min(updated_at) AS t FROM deliveries WHERE email_id = ? AND status IN ('sent', 'delivered')").get(emailId) as { t: number | null }).t;
  const burst = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE email_id = ? AND type = 'email.clicked' AND created_at > ?").get(emailId, at - 5000) as { n: number }).n;
  const verified = !BOT_UA.test(ua) && !(sentAt && at - sentAt < 3000) && burst < 2;

  emit(db, emailId, "email.clicked", recipientOf(e), { url: link.url, link_id: linkIdValue, verified, ua: ua.slice(0, 200), device: MOBILE_UA.test(ua) ? "mobile" : "desktop" });
  if (e.subscriber_id && verified) {
    const first = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE email_id = ? AND type = 'email.clicked' AND json_extract(data, '$.verified') = 1").get(emailId) as { n: number }).n === 1;
    db.prepare("UPDATE subscribers SET clicks = clicks + ?, last_click_at = ? WHERE id = ?").run(first ? 1 : 0, at, e.subscriber_id);
    bus.emit("email.clicked", { db, cfg }, { subscriberId: e.subscriber_id, url: link.url, postId: e.post_id });
  }
  return link.url;
}

export const isBot = (ua: string): boolean => BOT_UA.test(ua);

export const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
