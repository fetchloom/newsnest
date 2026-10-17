import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { tx } from "../db.ts";
import type { DB } from "../db.ts";
import { now } from "../ids.ts";

const DAY = 24 * 3600 * 1000;
/** A sign-up that never clicked its confirmation link is dropped after this long. */
export const STALE_PENDING_MS = 7 * DAY;

/**
 * Clears out what unauthenticated visitors can leave behind: used or expired sign-in tokens, and public sign-ups that were
 * never confirmed, together with the confirmation emails (and outbox files) sent to them. Subscribers added by the owner
 * through the API or an import are never touched, however long they stay pending.
 */
export function purgeStale(db: DB, cfg: Config, at = now()): { tokens: number; subscribers: number } {
  // Sample data (tagged "sample") is the owner's to remove, never swept up here.
  const stale = "SELECT id FROM subscribers WHERE status = 'pending' AND source IN ('form', 'referral') AND created_at < ? AND NOT EXISTS (SELECT 1 FROM subscriber_tags t WHERE t.subscriber_id = subscribers.id AND t.tag = 'sample')";
  const cutoff = at - STALE_PENDING_MS;
  const files = db.prepare(`SELECT d.id FROM deliveries d JOIN emails e ON e.id = d.email_id WHERE e.kind = 'system' AND e.subscriber_id IN (${stale})`).all(cutoff) as { id: string }[];
  const out = tx(db, () => {
    const tokens = Number(db.prepare("DELETE FROM magic_tokens WHERE expires_at < ?").run(at).changes);
    db.prepare(`DELETE FROM emails WHERE kind = 'system' AND subscriber_id IN (${stale})`).run(cutoff);
    db.prepare(`DELETE FROM subscriber_events WHERE subscriber_id IN (${stale})`).run(cutoff); // no history rows left pointing at nobody
    const subscribers = Number(db.prepare(`DELETE FROM subscribers WHERE id IN (${stale})`).run(cutoff).changes);
    return { tokens, subscribers };
  });
  for (const f of files) rmSync(join(cfg.dataDir, "outbox", `${f.id}.eml`), { force: true });
  return out;
}
