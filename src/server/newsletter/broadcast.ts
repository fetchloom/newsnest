import type { Config } from "../config.ts";
import { tx } from "../db.ts";
import type { DB } from "../db.ts";
import { ApiError } from "../errors.ts";
import { insertEmail, SYSTEM_KEY } from "../emails.ts";
import type { Prepared } from "../emails.ts";
import { now } from "../ids.ts";
import { subjectOf } from "./delivery.ts";
import type { AbConfig, PostRow } from "./delivery.ts";
import { assertCanSend, unsubscribeHeaders } from "./mailer.ts";
import { baseUrl, getPublication } from "./publication.ts";
import { merge, subjectVars } from "./render.ts";
import { audienceFilter } from "./segments.ts";
import type { SubscriberRow } from "./subscribers.ts";
import { parseJson } from "./util.ts";

const CHUNK = 500;

interface Sender { from: { name: string | null; email: string }; domain: Prepared["domain"] }

/** Creates one queued email per recipient. Content is rendered later, when each message is actually sent. */
function queueEmails(db: DB, cfg: Config, post: PostRow, subs: SubscriberRow[], variantOf: (i: number) => string | null, ab: AbConfig | null, sender: Sender, at: number): number {
  const pub = getPublication(db);
  const base = baseUrl(db, cfg, pub);
  tx(db, () => {
    subs.forEach((s, i) => {
      const variant = variantOf(i);
      const v = ab?.variants.find((x) => x.label === variant);
      const p: Prepared = {
        from: sender.from, to: [{ email: s.email }], cc: [], bcc: [],
        replyTo: pub.reply_to ? [pub.reply_to] : [],
        subject: merge(v?.subject || subjectOf(post), subjectVars(pub, s)),
        html: "", text: "",
        headers: unsubscribeHeaders(base, s.token, post.id),
        tags: [{ name: "post", value: post.slug.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100) }],
        scheduledAt: null, domain: sender.domain,
      };
      insertEmail(db, p, SYSTEM_KEY, at, { kind: "broadcast", post_id: post.id, subscriber_id: s.id, variant });
    });
  });
  return subs.length;
}

function* audiencePages(db: DB, where: string, params: unknown[], order: string, limit: number | null): Generator<SubscriberRow[]> {
  let taken = 0;
  let last = 0;
  for (;;) {
    const size = limit == null ? CHUNK : Math.min(CHUNK, limit - taken);
    if (size <= 0) return;
    const rows = order === "random"
      ? (db.prepare(`SELECT s.* FROM subscribers s WHERE ${where} ORDER BY random() LIMIT ?`).all(...(params as never[]), limit ?? 1_000_000) as unknown as SubscriberRow[])
      : (db.prepare(`SELECT s.*, s.rowid AS rid FROM subscribers s WHERE ${where} AND s.rowid > ? ORDER BY s.rowid LIMIT ?`).all(...(params as never[]), last, size) as unknown as (SubscriberRow & { rid: number })[]);
    if (!rows.length) return;
    if (order === "random") { for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK); return; }
    last = (rows[rows.length - 1] as SubscriberRow & { rid: number }).rid;
    taken += rows.length;
    yield rows;
    if (rows.length < size) return;
  }
}

const getPost = (db: DB, id: string): PostRow => db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as unknown as PostRow;

/** Begins delivering a scheduled post: queues every email (or just the A/B test group first). */
export function startSending(db: DB, cfg: Config, postId: string): void {
  const post = getPost(db, postId);
  const pub = getPublication(db);
  const { from, domain } = assertCanSend(db, cfg, pub, post);
  const ab = parseJson<AbConfig | null>(post.ab, null);
  const test = ab?.enabled ? ab : null;
  const f = audienceFilter(db, post.audience);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM subscribers s WHERE ${f.sql}`).get(...(f.params as never[])) as { n: number }).n;
  if (total === 0) throw new ApiError(409, "empty_audience", "No active subscribers match this post's audience.");
  const at = now();
  const sender: Sender = { from, domain };

  if (test) {
    const testSize = Math.max(test.variants.length, Math.ceil((total * test.test_percent) / 100));
    let i = 0;
    const counts: Record<string, number> = {};
    for (const page of audiencePages(db, f.sql, f.params, "random", Math.min(testSize, total))) {
      queueEmails(db, cfg, post, page, (k) => { const label = test.variants[(i + k) % test.variants.length].label; counts[label] = (counts[label] ?? 0) + 1; return label; }, test, sender, at);
      i += page.length;
    }
    db.prepare("UPDATE posts SET status = 'sending', recipients = ?, ab_state = ?, updated_at = ? WHERE id = ?")
      .run(i, JSON.stringify({ phase: "testing", started_at: at, winner_at: at + test.wait_minutes * 60_000, counts, audience_total: total }), at, post.id);
  } else {
    let n = 0;
    for (const page of audiencePages(db, f.sql, f.params, "ordered", null)) n += queueEmails(db, cfg, post, page, () => null, null, sender, at);
    db.prepare("UPDATE posts SET status = 'sending', recipients = ?, ab_state = '{}', updated_at = ? WHERE id = ?").run(n, at, post.id);
  }
  if (post.web_enabled && !post.published_at) db.prepare("UPDATE posts SET published_at = ? WHERE id = ?").run(at, post.id);
}

function variantRates(db: DB, postId: string, metric: "opens" | "clicks"): Record<string, number> {
  const rows = db.prepare(`
    SELECT em.variant AS v, COUNT(*) AS sent,
      (SELECT COUNT(DISTINCT e2.id) FROM emails e2 JOIN events ev ON ev.email_id = e2.id
        WHERE e2.post_id = em.post_id AND e2.variant = em.variant AND ev.type = ?
          AND (? = 'opens' OR json_extract(ev.data, '$.verified') = 1)) AS hits
    FROM emails em WHERE em.post_id = ? AND em.variant IS NOT NULL GROUP BY em.variant`)
    .all(metric === "opens" ? "email.opened" : "email.clicked", metric, postId) as { v: string; sent: number; hits: number }[];
  return Object.fromEntries(rows.map((r) => [r.v, r.sent ? r.hits / r.sent : 0]));
}

function sendWinner(db: DB, cfg: Config, post: PostRow): void {
  const ab = parseJson<AbConfig>(post.ab, null as never);
  const state = parseJson<Record<string, any>>(post.ab_state, {});
  const rates = variantRates(db, post.id, ab.metric);
  const winner = ab.variants.map((v) => v.label).sort((a, b) => (rates[b] ?? 0) - (rates[a] ?? 0) || a.localeCompare(b))[0];

  const { from, domain } = assertCanSend(db, cfg, getPublication(db), post);
  const f = audienceFilter(db, post.audience);
  const where = `${f.sql} AND NOT EXISTS (SELECT 1 FROM emails em WHERE em.post_id = ? AND em.subscriber_id = s.id)`;
  let n = 0;
  const at = now();
  for (const page of audiencePages(db, where, [...f.params, post.id], "ordered", null)) n += queueEmails(db, cfg, post, page, () => winner, ab, { from, domain }, at);
  db.prepare("UPDATE posts SET recipients = recipients + ?, ab_state = ?, updated_at = ? WHERE id = ?")
    .run(n, JSON.stringify({ ...state, phase: "done", winner, rates, remainder: n, decided_at: at }), at, post.id);
}

/** Runs due work: starts scheduled posts, picks A/B winners, and marks finished posts as sent. */
export function broadcastTick(db: DB, cfg: Config): boolean {
  const at = now();
  let worked = false;

  for (const p of db.prepare("SELECT id FROM posts WHERE status = 'scheduled' AND send_at <= ?").all(at) as { id: string }[]) {
    worked = true;
    try { startSending(db, cfg, p.id); }
    catch (e) {
      console.error(`could not start sending post ${p.id}:`, (e as Error).message);
      db.prepare("UPDATE posts SET status = 'draft', send_at = NULL, ab_state = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ error: (e as Error).message }), at, p.id);
    }
  }

  for (const p of db.prepare("SELECT * FROM posts WHERE status = 'sending' AND json_extract(ab_state, '$.phase') = 'testing' AND json_extract(ab_state, '$.winner_at') <= ?").all(at) as unknown as PostRow[]) {
    worked = true;
    try { sendWinner(db, cfg, p); } catch (e) { console.error(`A/B winner for ${p.id}:`, (e as Error).message); }
  }

  const finished = db.prepare(`SELECT id FROM posts WHERE status = 'sending' AND coalesce(json_extract(ab_state, '$.phase'), '') != 'testing'
    AND NOT EXISTS (SELECT 1 FROM emails e JOIN deliveries d ON d.email_id = e.id WHERE e.post_id = posts.id AND d.status IN ('queued', 'sending'))`).all() as { id: string }[];
  for (const p of finished) { worked = true; db.prepare("UPDATE posts SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?").run(at, at, p.id); }
  return worked;
}
