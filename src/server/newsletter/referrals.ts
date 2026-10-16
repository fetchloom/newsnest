import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { notFound, validation } from "../errors.ts";
import { iso, newId, now } from "../ids.ts";
import { bus } from "./bus.ts";
import { ctxFor, sendSystemMail } from "./mailer.ts";
import { getPublication } from "./publication.ts";
import { renderSimpleEmail } from "./render.ts";
import { findById } from "./subscribers.ts";
import { isUrl, oneOf, text } from "./util.ts";

interface RewardRow { id: string; name: string; threshold: number; kind: string; description: string; url: string; created_at: number }

const view = (db: DB, r: RewardRow) => ({
  id: r.id, object: "reward", name: r.name, threshold: r.threshold, kind: r.kind, description: r.description, url: r.url,
  earned: (db.prepare("SELECT COUNT(*) AS n FROM reward_claims WHERE reward_id = ?").get(r.id) as { n: number }).n,
  fulfilled: (db.prepare("SELECT COUNT(*) AS n FROM reward_claims WHERE reward_id = ? AND status = 'fulfilled'").get(r.id) as { n: number }).n,
  created_at: iso(r.created_at),
});

const row = (db: DB, id: string): RewardRow => {
  const r = db.prepare("SELECT * FROM rewards WHERE id = ?").get(id) as unknown as RewardRow | undefined;
  if (!r) throw notFound("Reward");
  return r;
};

export const listRewards = (db: DB) => ({ object: "list", data: (db.prepare("SELECT * FROM rewards ORDER BY threshold").all() as unknown as RewardRow[]).map((r) => view(db, r)) });

function fields(body: Record<string, unknown>, cur?: RewardRow) {
  const name = text(body.name, "name", 100) ?? cur?.name;
  const threshold = body.threshold !== undefined ? Math.round(Number(body.threshold)) : cur?.threshold;
  if (!name) throw validation(`"name" is required`);
  if (!threshold || threshold < 1 || threshold > 100000) throw validation(`"threshold" must be at least 1 referral`);
  const kind = oneOf(body.kind, "kind", ["digital", "physical"] as const) ?? (cur?.kind as "digital" | "physical" | undefined) ?? "digital";
  const url = text(body.url, "url", 500) ?? cur?.url ?? "";
  if (url && !isUrl(url)) throw validation(`"url" must be an http(s) link`);
  if (kind === "digital" && !url) throw validation("A digital reward needs a download or access link to email");
  return { name, threshold, kind, url, description: text(body.description, "description", 500) ?? cur?.description ?? "" };
}

export function createReward(db: DB, body: Record<string, unknown>) {
  const f = fields(body);
  const id = newId("rwd");
  db.prepare("INSERT INTO rewards (id, name, threshold, kind, description, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, f.name, f.threshold, f.kind, f.description, f.url, now());
  return view(db, row(db, id));
}

export function updateReward(db: DB, id: string, body: Record<string, unknown>) {
  const f = fields(body, row(db, id));
  db.prepare("UPDATE rewards SET name = ?, threshold = ?, kind = ?, description = ?, url = ? WHERE id = ?").run(f.name, f.threshold, f.kind, f.description, f.url, id);
  return view(db, row(db, id));
}

export function deleteReward(db: DB, id: string) { row(db, id); db.prepare("DELETE FROM rewards WHERE id = ?").run(id); return { id, object: "reward", deleted: true }; }

export function listClaims(db: DB, status: string | null) {
  const rows = db.prepare(`SELECT c.id, c.status, c.earned_at, c.fulfilled_at, r.name AS reward, r.kind, r.threshold, s.email FROM reward_claims c
    JOIN rewards r ON r.id = c.reward_id JOIN subscribers s ON s.id = c.subscriber_id ${status ? "WHERE c.status = ?" : ""} ORDER BY c.earned_at DESC LIMIT 500`).all(...(status ? [status] : [])) as Record<string, any>[];
  return { object: "list", data: rows.map((r) => ({ ...r, earned_at: iso(r.earned_at), fulfilled_at: iso(r.fulfilled_at) })) };
}

export function fulfillClaim(db: DB, id: string) {
  const res = db.prepare("UPDATE reward_claims SET status = 'fulfilled', fulfilled_at = ? WHERE id = ? AND status = 'earned'").run(now(), id);
  if (!res.changes) throw notFound("Open reward claim");
  return { id, status: "fulfilled" };
}

/** Awards every reward the referrer has now reached and emails them. Counts only confirmed subscribers. */
export function checkMilestones(db: DB, cfg: Config, referrerId: string): void {
  if (!getPublication(db).referral_enabled) return;
  const count = (db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE referred_by = ? AND status = 'active'").get(referrerId) as { n: number }).n;
  for (const r of db.prepare("SELECT * FROM rewards WHERE threshold <= ? ORDER BY threshold").all(count) as unknown as RewardRow[]) {
    const res = db.prepare("INSERT OR IGNORE INTO reward_claims (id, reward_id, subscriber_id, earned_at) VALUES (?, ?, ?, ?)").run(newId("clm"), r.id, referrerId, now());
    if (!res.changes) continue;
    const sub = findById(db, referrerId);
    const pub = getPublication(db);
    const c = ctxFor(db, cfg, pub, sub);
    const subject = `You unlocked ${r.name}`;
    const doc = renderSimpleEmail(c, r.kind === "digital"
      ? { subject, markdown: `Thanks for spreading the word. **${count}** people have joined through your link, which unlocks **${r.name}**.${r.description ? `\n\n${r.description}` : ""}`, buttonLabel: "Get your reward", buttonUrl: r.url }
      : { subject, markdown: `Thanks for spreading the word. **${count}** people have joined through your link, which unlocks **${r.name}**.\n\n${r.description || "We'll be in touch to arrange it."}` });
    sendSystemMail(db, cfg, { to: sub.email, subject, ...doc, subscriberId: sub.id });
    bus.emit("reward.earned", { db, cfg }, { subscriberId: referrerId, rewardId: r.id });
  }
}

export function registerReferrals(): void {
  bus.on("subscriber.confirmed", ({ db, cfg }, p: { subscriberId: string }) => {
    const s = findById(db, p.subscriberId);
    if (s.referred_by) checkMilestones(db, cfg, s.referred_by);
  });
}

export function referralOverview(db: DB) {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE referred_by IS NOT NULL AND status = 'active'").get() as { n: number }).n;
  const referrers = (db.prepare("SELECT COUNT(DISTINCT referred_by) AS n FROM subscribers WHERE referred_by IS NOT NULL AND status = 'active'").get() as { n: number }).n;
  const leaderboard = db.prepare(`SELECT r.email AS email, r.referral_code AS code, COUNT(*) AS referrals FROM subscribers s JOIN subscribers r ON r.id = s.referred_by
    WHERE s.status = 'active' GROUP BY r.id ORDER BY referrals DESC, r.created_at LIMIT 25`).all();
  return { enabled: getPublication(db).referral_enabled, referred_subscribers: total, referrers, leaderboard };
}
