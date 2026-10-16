import type { DB } from "../db.ts";
import { notFound } from "../errors.ts";
import { iso, now } from "../ids.ts";
import type { PostRow } from "./delivery.ts";
import { csvCell, parseJson } from "./util.ts";

const DAY = 24 * 3600 * 1000;
const pct = (n: number, d: number): number => (d ? Math.round((n / d) * 1000) / 10 : 0);

const one = (db: DB, sql: string, ...a: unknown[]): number => (db.prepare(sql).get(...(a as never[])) as { n: number }).n;

export function postStats(db: DB, postId: string) {
  const post = db.prepare("SELECT * FROM posts WHERE id = ? OR slug = ?").get(postId, postId) as unknown as PostRow | undefined;
  if (!post) notFound("Post");
  const id = post!.id;

  const sent = one(db, "SELECT COUNT(DISTINCT e.id) AS n FROM emails e JOIN deliveries d ON d.email_id = e.id WHERE e.post_id = ? AND d.status IN ('sent', 'delivered')", id);
  const bounced = one(db, "SELECT COUNT(DISTINCT e.id) AS n FROM emails e JOIN deliveries d ON d.email_id = e.id WHERE e.post_id = ? AND d.status = 'bounced'", id);
  const pending = one(db, "SELECT COUNT(DISTINCT e.id) AS n FROM emails e JOIN deliveries d ON d.email_id = e.id WHERE e.post_id = ? AND d.status IN ('queued', 'sending')", id);
  const opensTotal = one(db, "SELECT COUNT(*) AS n FROM events ev JOIN emails e ON e.id = ev.email_id WHERE e.post_id = ? AND ev.type = 'email.opened'", id);
  const opensUnique = one(db, "SELECT COUNT(DISTINCT ev.email_id) AS n FROM events ev JOIN emails e ON e.id = ev.email_id WHERE e.post_id = ? AND ev.type = 'email.opened'", id);
  const clicksTotal = one(db, "SELECT COUNT(*) AS n FROM events ev JOIN emails e ON e.id = ev.email_id WHERE e.post_id = ? AND ev.type = 'email.clicked'", id);
  const clicksUnique = one(db, "SELECT COUNT(DISTINCT ev.email_id) AS n FROM events ev JOIN emails e ON e.id = ev.email_id WHERE e.post_id = ? AND ev.type = 'email.clicked'", id);
  const clicksVerified = one(db, "SELECT COUNT(DISTINCT ev.email_id) AS n FROM events ev JOIN emails e ON e.id = ev.email_id WHERE e.post_id = ? AND ev.type = 'email.clicked' AND json_extract(ev.data, '$.verified') = 1", id);
  const unsubscribes = one(db, "SELECT COUNT(*) AS n FROM subscriber_events WHERE type = 'unsubscribed' AND post_id = ?", id);

  const topLinks = db.prepare(`SELECT json_extract(ev.data, '$.url') AS url, COUNT(*) AS total, COUNT(DISTINCT ev.email_id) AS uniq,
      COUNT(DISTINCT CASE WHEN json_extract(ev.data, '$.verified') = 1 THEN ev.email_id END) AS verified
    FROM events ev JOIN emails e ON e.id = ev.email_id WHERE e.post_id = ? AND ev.type = 'email.clicked' GROUP BY url ORDER BY uniq DESC, total DESC LIMIT 20`).all(id);

  const started = (db.prepare("SELECT min(created_at) AS t FROM emails WHERE post_id = ?").get(id) as { t: number | null }).t;
  const hourly = started ? db.prepare(`SELECT CAST((ev.created_at - ?) / 3600000 AS INTEGER) AS h, ev.type AS type, COUNT(DISTINCT ev.email_id) AS n
    FROM events ev JOIN emails e ON e.id = ev.email_id WHERE e.post_id = ? AND ev.type IN ('email.opened', 'email.clicked') AND ev.created_at < ? GROUP BY h, type ORDER BY h`)
    .all(started, id, started + 72 * 3600 * 1000) : [];

  const devices = db.prepare(`SELECT json_extract(ev.data, '$.device') AS device, COUNT(DISTINCT ev.email_id) AS n FROM events ev JOIN emails e ON e.id = ev.email_id
    WHERE e.post_id = ? AND ev.type = 'email.opened' GROUP BY device`).all(id);

  const variants = db.prepare(`SELECT em.variant AS variant, COUNT(*) AS sent,
      (SELECT COUNT(DISTINCT e2.id) FROM emails e2 JOIN events ev ON ev.email_id = e2.id WHERE e2.post_id = em.post_id AND e2.variant = em.variant AND ev.type = 'email.opened') AS opens,
      (SELECT COUNT(DISTINCT e2.id) FROM emails e2 JOIN events ev ON ev.email_id = e2.id WHERE e2.post_id = em.post_id AND e2.variant = em.variant AND ev.type = 'email.clicked' AND json_extract(ev.data, '$.verified') = 1) AS clicks
    FROM emails em WHERE em.post_id = ? AND em.variant IS NOT NULL GROUP BY em.variant ORDER BY em.variant`).all(id) as { variant: string; sent: number; opens: number; clicks: number }[];

  return {
    post_id: id, title: post!.title, status: post!.status,
    recipients: post!.recipients, sent, pending, bounced,
    opens: { total: opensTotal, unique: opensUnique, rate: pct(opensUnique, sent) },
    clicks: { total: clicksTotal, unique: clicksUnique, verified_unique: clicksVerified, rate: pct(clicksVerified, sent), click_to_open: pct(clicksVerified, opensUnique) },
    unsubscribes: { total: unsubscribes, rate: pct(unsubscribes, sent) },
    top_links: topLinks, hourly, devices,
    variants: variants.map((v) => ({ ...v, open_rate: pct(v.opens, v.sent), click_rate: pct(v.clicks, v.sent) })),
    ab_state: parseJson(post!.ab_state, {}),
    note: "Opens are counted when a tracking pixel loads. Apple Mail Privacy Protection and some image proxies load it automatically, so open counts run high. Verified clicks exclude security scanners and link previewers.",
  };
}

/** Audience-wide numbers: totals, growth, where people come from, how engaged they are. */
export function audienceStats(db: DB, days = 30) {
  const at = now();
  const byStatus = Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status").all() as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const first = start.getTime() - (days - 1) * DAY;
  const series = new Map<string, { date: string; subscribed: number; unsubscribed: number }>();
  for (let i = 0; i < days; i++) { const d = new Date(first + i * DAY).toISOString().slice(0, 10); series.set(d, { date: d, subscribed: 0, unsubscribed: 0 }); }
  for (const r of db.prepare(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS d, type, COUNT(*) AS n FROM subscriber_events
    WHERE type IN ('confirmed', 'unsubscribed') AND created_at >= ? GROUP BY d, type`).all(first) as { d: string; type: string; n: number }[]) {
    const row = series.get(r.d); if (row) row[r.type === "confirmed" ? "subscribed" : "unsubscribed"] = r.n;
  }
  const growth = [...series.values()].map((r) => ({ ...r, net: r.subscribed - r.unsubscribed }));

  const sources = db.prepare(`SELECT source, coalesce(utm_source, '') AS utm_source, COUNT(*) AS n FROM subscribers WHERE status != 'pending' GROUP BY source, utm_source ORDER BY n DESC LIMIT 20`).all();
  const referrers = db.prepare(`SELECT coalesce(referrer, '') AS referrer, COUNT(*) AS n FROM subscribers WHERE referrer IS NOT NULL AND referrer != '' AND status != 'pending' GROUP BY referrer ORDER BY n DESC LIMIT 10`).all();

  const engagement = db.prepare(`SELECT (CASE WHEN created_at > ? THEN 'new' WHEN max(coalesce(last_open_at, 0), coalesce(last_click_at, 0)) > ? THEN 'active'
    WHEN max(coalesce(last_open_at, 0), coalesce(last_click_at, 0)) > ? THEN 'at_risk' ELSE 'inactive' END) AS level, COUNT(*) AS n
    FROM subscribers WHERE status = 'active' GROUP BY level`).all(at - 7 * DAY, at - 30 * DAY, at - 90 * DAY);

  const topReferrers = db.prepare(`SELECT r.email AS email, r.referral_code AS code, COUNT(*) AS referrals FROM subscribers s JOIN subscribers r ON r.id = s.referred_by
    WHERE s.status = 'active' GROUP BY r.id ORDER BY referrals DESC LIMIT 10`).all();

  const recent = db.prepare("SELECT id, title, sent_at FROM posts WHERE status IN ('sent', 'sending') ORDER BY coalesce(sent_at, updated_at) DESC LIMIT 10").all() as { id: string; title: string; sent_at: number | null }[];
  const recentPosts = recent.reverse().map((p) => {
    const s = postStats(db, p.id);
    return { id: p.id, title: p.title, sent: s.sent, open_rate: s.opens.rate, click_rate: s.clicks.rate, unsubscribes: s.unsubscribes.total, sent_at: iso(p.sent_at) };
  });

  return {
    totals: { active: byStatus.active ?? 0, pending: byStatus.pending ?? 0, unsubscribed: byStatus.unsubscribed ?? 0, bounced: byStatus.bounced ?? 0 },
    growth, sources, referrers, engagement, top_referrers: topReferrers, recent_posts: recentPosts,
    posts: { drafts: one(db, "SELECT COUNT(*) AS n FROM posts WHERE status = 'draft'"), sent: one(db, "SELECT COUNT(*) AS n FROM posts WHERE status = 'sent'") },
  };
}

export function postsCsv(db: DB): string {
  const lines = [["title", "status", "sent_at", "recipients", "sent", "bounced", "unique_opens", "open_rate_pct", "verified_unique_clicks", "click_rate_pct", "unsubscribes"].join(",")];
  for (const p of db.prepare("SELECT id FROM posts WHERE status IN ('sent', 'sending') ORDER BY coalesce(sent_at, updated_at) DESC").all() as { id: string }[]) {
    const s = postStats(db, p.id);
    const row = db.prepare("SELECT sent_at FROM posts WHERE id = ?").get(p.id) as { sent_at: number | null };
    lines.push([s.title, s.status, iso(row.sent_at), s.recipients, s.sent, s.bounced, s.opens.unique, s.opens.rate, s.clicks.verified_unique, s.clicks.rate, s.unsubscribes.total].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
