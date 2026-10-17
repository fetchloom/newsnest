import type { Config } from "../config.ts";
import { tx } from "../db.ts";
import type { DB } from "../db.ts";
import { notFound, validation } from "../errors.ts";
import { iso, newId, now } from "../ids.ts";
import { isEmail } from "../validate.ts";
import { bus } from "./bus.ts";
import { baseUrl } from "./publication.ts";
import { compileRules } from "./segments.ts";
import { csvCell, parseCsv, parseJson, token } from "./util.ts";

const DAY = 24 * 3600 * 1000;

export interface SubscriberRow {
  id: string; email: string; status: "pending" | "active" | "unsubscribed" | "bounced"; token: string; referral_code: string; referred_by: string | null;
  fields: string; source: string; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; referrer: string | null; country: string | null;
  created_at: number; confirmed_at: number | null; unsubscribed_at: number | null;
  emails_received: number; opens: number; clicks: number; last_open_at: number | null; last_click_at: number | null;
}

export const normalizeSubscriberEmail = (s: string): string => s.trim().toLowerCase();

export function engagementOf(r: SubscriberRow, at = now()): "new" | "active" | "at_risk" | "inactive" {
  if (r.created_at > at - 7 * DAY) return "new";
  const last = Math.max(r.last_open_at ?? 0, r.last_click_at ?? 0);
  return last > at - 30 * DAY ? "active" : last > at - 90 * DAY ? "at_risk" : "inactive";
}

const tagsOf = (db: DB, id: string): string[] =>
  (db.prepare("SELECT tag FROM subscriber_tags WHERE subscriber_id = ? ORDER BY tag").all(id) as { tag: string }[]).map((r) => r.tag);

export function subscriberView(db: DB, r: SubscriberRow, base: string) {
  const referrals = (db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE referred_by = ? AND status = 'active'").get(r.id) as { n: number }).n;
  return {
    id: r.id, object: "subscriber", email: r.email, status: r.status,
    fields: parseJson<Record<string, unknown>>(r.fields, {}), tags: tagsOf(db, r.id),
    source: r.source, utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign: r.utm_campaign, referrer: r.referrer, country: r.country,
    engagement: engagementOf(r),
    created_at: iso(r.created_at), confirmed_at: iso(r.confirmed_at), unsubscribed_at: iso(r.unsubscribed_at),
    stats: { emails_received: r.emails_received, opens: r.opens, clicks: r.clicks, last_open_at: iso(r.last_open_at), last_click_at: iso(r.last_click_at) },
    referral: { code: r.referral_code, link: `${base}/subscribe?ref=${r.referral_code}`, confirmed_referrals: referrals, referred_by: r.referred_by },
  };
}

export function findByEmail(db: DB, email: string): SubscriberRow | undefined {
  return db.prepare("SELECT * FROM subscribers WHERE email = ?").get(normalizeSubscriberEmail(email)) as unknown as SubscriberRow | undefined;
}
export function findById(db: DB, id: string): SubscriberRow {
  const r = db.prepare("SELECT * FROM subscribers WHERE id = ? OR email = ?").get(id, id.toLowerCase()) as unknown as SubscriberRow | undefined;
  if (!r) throw notFound("Subscriber");
  return r;
}
export const findByToken = (db: DB, tok: string): SubscriberRow | undefined =>
  db.prepare("SELECT * FROM subscribers WHERE token = ?").get(tok) as unknown as SubscriberRow | undefined;

// ---- fields and tags ----------------------------------------------------------
const FIELD_KEY = /^[a-z][a-z0-9_]{0,40}$/;
export const fieldKey = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1").slice(0, 40);

function cleanFields(db: DB, raw: unknown, autoCreate: boolean): Record<string, string | number | boolean> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw validation(`"fields" must be an object`);
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!FIELD_KEY.test(k)) throw validation(`Field name "${k}" must be lowercase letters, numbers and underscores`);
    if (v === null || v === "") continue;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw validation(`Field "${k}" must be text, a number or true/false`);
    if (typeof v === "string" && v.length > 500) throw validation(`Field "${k}" is too long`);
    out[k] = v;
    if (autoCreate) db.prepare("INSERT OR IGNORE INTO field_defs (key, label, type) VALUES (?, ?, ?)").run(k, k.replace(/_/g, " "), typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "text");
  }
  return out;
}

const cleanTag = (t: unknown): string => {
  const tag = String(t).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9 _\-.:]{0,39}$/.test(tag)) throw validation(`Tags are 1–40 characters: letters, numbers, spaces and _ - . :`);
  return tag;
};

export function addTags(db: DB, cfg: Config, id: string, tags: unknown[]): void {
  for (const t of tags) {
    const tag = cleanTag(t);
    if (db.prepare("INSERT OR IGNORE INTO subscriber_tags (subscriber_id, tag) VALUES (?, ?)").run(id, tag).changes) bus.emit("subscriber.tag_added", { db, cfg }, { subscriberId: id, tag });
  }
}

export const listFieldDefs = (db: DB) => db.prepare("SELECT key, label, type FROM field_defs ORDER BY key").all();
export const listTags = (db: DB) => db.prepare("SELECT tag, COUNT(*) AS subscribers FROM subscriber_tags GROUP BY tag ORDER BY tag").all();

export function saveFieldDef(db: DB, body: Record<string, unknown>) {
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const key = typeof body.key === "string" ? body.key : fieldKey(label);
  if (!label || !FIELD_KEY.test(key)) throw validation(`A field needs a "label" and a lowercase "key"`);
  const type = ["text", "number", "date", "boolean"].includes(String(body.type)) ? String(body.type) : "text";
  db.prepare("INSERT INTO field_defs (key, label, type) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET label = excluded.label, type = excluded.type").run(key, label, type);
  return { key, label, type };
}

// ---- create / confirm / unsubscribe -------------------------------------------
export interface NewSubscriber {
  email: unknown;
  fields?: unknown; tags?: unknown[]; country?: string | null;
  source?: string; utm_source?: string; utm_medium?: string; utm_campaign?: string; referrer?: string;
  ref?: string | null;
  /** active: add as confirmed. pending: needs the confirmation email. */
  status?: "active" | "pending";
  resubscribe?: boolean;
  /** Send the welcome email when the subscriber becomes active. Confirmed signups always get it; API and import adds don't unless asked. */
  welcome?: boolean;
}

const clip = (v: unknown, n = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

function referralCode(db: DB): string {
  for (;;) {
    const code = token(6).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
    if (code.length >= 6 && !db.prepare("SELECT 1 FROM subscribers WHERE referral_code = ?").get(code)) return code;
  }
}

export function createSubscriber(db: DB, cfg: Config, input: NewSubscriber): { subscriber: SubscriberRow; created: boolean } {
  if (typeof input.email !== "string" || !isEmail(normalizeSubscriberEmail(input.email))) throw validation(`"email" must be a valid email address`);
  const email = normalizeSubscriberEmail(input.email);
  const wanted = input.status ?? "active";

  const existing = findByEmail(db, email);
  if (existing) {
    if (existing.status === "unsubscribed" && input.resubscribe) {
      db.prepare("UPDATE subscribers SET status = 'pending', unsubscribed_at = NULL WHERE id = ?").run(existing.id);
      if (wanted === "active") activate(db, cfg, existing.id, true, true); else bus.emit("subscriber.pending", { db, cfg }, { subscriberId: existing.id });
    } else if (existing.status === "pending" && wanted === "pending") {
      bus.emit("subscriber.pending", { db, cfg }, { subscriberId: existing.id }); // resend the confirmation
    }
    return { subscriber: findById(db, existing.id), created: false };
  }

  const bounced = db.prepare("SELECT 1 FROM suppressions WHERE email = ? AND reason = 'bounce'").get(email);
  const referrer = input.ref ? (db.prepare("SELECT id FROM subscribers WHERE referral_code = ? AND status = 'active'").get(String(input.ref)) as { id: string } | undefined) : undefined;
  const id = newId("sub");
  const at = now();

  tx(db, () => {
    db.prepare(`INSERT INTO subscribers (id, email, status, token, referral_code, referred_by, fields, source, utm_source, utm_medium, utm_campaign, referrer, country, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, email, bounced ? "bounced" : "pending", token(), referralCode(db), referrer?.id ?? null,
      JSON.stringify(cleanFields(db, input.fields, true)), referrer ? "referral" : input.source ?? "api",
      clip(input.utm_source, 100), clip(input.utm_medium, 100), clip(input.utm_campaign, 100), clip(input.referrer, 300), clip(input.country, 2)?.toUpperCase() ?? null, at);
    db.prepare("INSERT INTO subscriber_events (subscriber_id, type, created_at) VALUES (?, 'subscribed', ?)").run(id, at);
  });
  if (input.tags?.length) addTags(db, cfg, id, input.tags);

  if (!bounced) {
    if (wanted === "active") activate(db, cfg, id, true, input.welcome === true || input.source === "form");
    else bus.emit("subscriber.pending", { db, cfg }, { subscriberId: id });
  }
  return { subscriber: findById(db, id), created: true };
}

/** Marks a subscriber confirmed and announces it (welcome email, automations, referral rewards). */
export function activate(db: DB, cfg: Config, id: string, announce = true, welcome = true): boolean {
  const at = now();
  const res = db.prepare("UPDATE subscribers SET status = 'active', confirmed_at = coalesce(confirmed_at, ?), unsubscribed_at = NULL WHERE id = ? AND status IN ('pending', 'unsubscribed')").run(at, id);
  if (!res.changes) return false;
  db.prepare("INSERT INTO subscriber_events (subscriber_id, type, created_at) VALUES (?, 'confirmed', ?)").run(id, at);
  if (announce) bus.emit("subscriber.confirmed", { db, cfg }, { subscriberId: id, welcome });
  return true;
}

/** Only a pending subscriber is confirmed. A confirmation link must never undo an unsubscribe or a bounce. */
export function confirmByToken(db: DB, cfg: Config, tok: string): SubscriberRow | null {
  const s = findByToken(db, tok);
  if (!s || (s.status !== "pending" && s.status !== "active")) return null;
  if (s.status === "pending") activate(db, cfg, s.id);
  return findById(db, s.id);
}

export function unsubscribeByToken(db: DB, cfg: Config, tok: string, postId: string | null = null): SubscriberRow | null {
  const s = findByToken(db, tok);
  if (!s) return null;
  if (s.status !== "unsubscribed") {
    const at = now();
    db.prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ?").run(at, s.id);
    db.prepare("INSERT INTO subscriber_events (subscriber_id, type, post_id, created_at) VALUES (?, 'unsubscribed', ?, ?)").run(s.id, postId, at);
    db.prepare("UPDATE automation_runs SET status = 'canceled', updated_at = ? WHERE subscriber_id = ? AND status = 'active'").run(at, s.id);
    bus.emit("subscriber.unsubscribed", { db, cfg }, { subscriberId: s.id, postId });
  }
  return findById(db, s.id);
}

/** A hard bounce takes the address off every list. */
export function markBounced(db: DB, email: string): void {
  const s = findByEmail(db, email);
  if (!s || s.status === "bounced") return;
  const at = now();
  db.prepare("UPDATE subscribers SET status = 'bounced' WHERE id = ?").run(s.id);
  db.prepare("INSERT INTO subscriber_events (subscriber_id, type, created_at) VALUES (?, 'bounced', ?)").run(s.id, at);
}

// ---- list / read / update / delete --------------------------------------------
export interface ListQuery { q?: string; status?: string; tag?: string; segment?: string; engagement?: string; limit?: number; after?: string; rules?: unknown }

function filterSql(db: DB, q: ListQuery): { where: string; params: unknown[] } {
  const parts: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (q.status) { parts.push("s.status = ?"); params.push(q.status); }
  if (q.q) {
    parts.push("(s.email LIKE ? ESCAPE '\\' OR s.fields LIKE ? ESCAPE '\\')");
    const like = `%${q.q.replace(/[\\%_]/g, "\\$&").toLowerCase()}%`;
    params.push(like, like);
  }
  if (q.tag) { parts.push("EXISTS (SELECT 1 FROM subscriber_tags t WHERE t.subscriber_id = s.id AND t.tag = ?)"); params.push(q.tag.toLowerCase()); }
  if (q.segment) {
    const w = compileRules(db, { match: "all", conditions: [{ field: "in_segment", op: "is", value: q.segment }] });
    parts.push(w.sql); params.push(...w.params);
  }
  if (q.engagement) {
    const w = compileRules(db, { match: "all", conditions: [{ field: "engagement", op: "is", value: q.engagement }] });
    parts.push(w.sql); params.push(...w.params);
  }
  if (q.rules) { const w = compileRules(db, q.rules); parts.push(w.sql); params.push(...w.params); }
  return { where: parts.join(" AND "), params };
}

export function listSubscribers(db: DB, cfg: Config, q: ListQuery) {
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 200);
  const f = filterSql(db, q);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM subscribers s WHERE ${f.where}`).get(...(f.params as never[])) as { n: number }).n;

  let cursor = "";
  const params = [...f.params];
  if (q.after) {
    const c = db.prepare("SELECT rowid AS r FROM subscribers WHERE id = ?").get(q.after) as { r: number } | undefined;
    if (!c) throw validation(`Unknown "after" id`);
    cursor = " AND s.rowid < ?"; params.push(c.r);
  }
  const rows = db.prepare(`SELECT s.* FROM subscribers s WHERE ${f.where}${cursor} ORDER BY s.rowid DESC LIMIT ?`).all(...(params as never[]), limit + 1) as unknown as SubscriberRow[];
  const base = baseUrl(db, cfg);
  return { object: "list", total, has_more: rows.length > limit, data: rows.slice(0, limit).map((r) => subscriberView(db, r, base)) };
}

export function updateSubscriber(db: DB, cfg: Config, id: string, body: Record<string, unknown>) {
  const cur = findById(db, id);
  tx(db, () => {
    if (body.fields !== undefined) {
      const merged = { ...parseJson<Record<string, unknown>>(cur.fields, {}), ...cleanFields(db, body.fields, true) };
      for (const [k, v] of Object.entries(body.fields as Record<string, unknown>)) if (v === null || v === "") delete merged[k];
      db.prepare("UPDATE subscribers SET fields = ? WHERE id = ?").run(JSON.stringify(merged), cur.id);
    }
    if (body.country !== undefined) db.prepare("UPDATE subscribers SET country = ? WHERE id = ?").run(clip(body.country, 2)?.toUpperCase() ?? null, cur.id);
    if (Array.isArray(body.tags_remove)) for (const t of body.tags_remove) db.prepare("DELETE FROM subscriber_tags WHERE subscriber_id = ? AND tag = ?").run(cur.id, cleanTag(t));
  });
  if (Array.isArray(body.tags_add)) addTags(db, cfg, cur.id, body.tags_add);
  if (body.status === "unsubscribed") unsubscribeByToken(db, cfg, cur.token);
  else if (body.status === "active" && cur.status !== "active") activate(db, cfg, cur.id, false);
  else if (body.status !== undefined && body.status !== cur.status) throw validation(`"status" can be set to "active" or "unsubscribed"`);
  return subscriberView(db, findById(db, cur.id), baseUrl(db, cfg));
}

export function deleteSubscriber(db: DB, id: string) {
  const s = findById(db, id);
  db.prepare("DELETE FROM subscribers WHERE id = ?").run(s.id);
  return { id: s.id, object: "subscriber", deleted: true };
}

export function subscriberActivity(db: DB, id: string) {
  const s = findById(db, id);
  const rows = db.prepare(`SELECT ev.type, ev.data, ev.created_at, em.subject, em.post_id FROM events ev JOIN emails em ON em.id = ev.email_id
    WHERE em.subscriber_id = ? ORDER BY ev.rowid DESC LIMIT 60`).all(s.id) as { type: string; data: string; created_at: number; subject: string; post_id: string | null }[];
  const history = db.prepare("SELECT type, created_at FROM subscriber_events WHERE subscriber_id = ? ORDER BY id DESC LIMIT 20").all(s.id) as { type: string; created_at: number }[];
  return {
    emails: rows.map((r) => ({ type: r.type, subject: r.subject, post_id: r.post_id, data: parseJson(r.data, {}), created_at: iso(r.created_at) })),
    subscription: history.map((r) => ({ type: r.type, created_at: iso(r.created_at) })),
  };
}

// ---- CSV import / export ------------------------------------------------------
const MAX_IMPORT_ROWS = 100_000;

export interface ImportOptions { status?: "active" | "pending"; tags?: string[]; update_existing?: boolean }

export function importCsv(db: DB, cfg: Config, csv: unknown, opts: ImportOptions = {}) {
  if (typeof csv !== "string" || !csv.trim()) throw validation(`"csv" must contain the file's text`);
  const rows = parseCsv(csv);
  if (rows.length < 2) throw validation("The CSV needs a header row and at least one subscriber");
  if (rows.length - 1 > MAX_IMPORT_ROWS) throw validation(`Import at most ${MAX_IMPORT_ROWS} rows at a time`);

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const emailCol = header.findIndex((h) => ["email", "e-mail", "email address", "email_address"].includes(h));
  if (emailCol < 0) throw validation(`The CSV needs an "email" column`);
  const baseTags = (opts.tags ?? []).map(cleanTag);
  const status = opts.status === "pending" ? "pending" : "active";

  const result = { created: 0, updated: 0, skipped: 0, invalid: [] as { row: number; email: string; reason: string }[] };
  const at = now();

  tx(db, () => {
    const insert = db.prepare(`INSERT INTO subscribers (id, email, status, token, referral_code, fields, source, country, created_at, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?, ?)`);
    const hist = db.prepare("INSERT INTO subscriber_events (subscriber_id, type, created_at) VALUES (?, ?, ?)");
    const tagStmt = db.prepare("INSERT OR IGNORE INTO subscriber_tags (subscriber_id, tag) VALUES (?, ?)");
    const bounced = db.prepare("SELECT 1 FROM suppressions WHERE email = ? AND reason = 'bounce'");

    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i];
      const email = normalizeSubscriberEmail(cells[emailCol] ?? "");
      if (!isEmail(email)) { if (result.invalid.length < 50) result.invalid.push({ row: i + 1, email, reason: "not a valid email address" }); result.skipped++; continue; }

      const fields: Record<string, string> = {};
      const tags = [...baseTags];
      let country: string | null = null;
      header.forEach((h, c) => {
        const v = (cells[c] ?? "").trim();
        if (c === emailCol || !v) return;
        if (h === "tags" || h === "tag") tags.push(...v.split(/[;|]/).map((t) => t.trim()).filter(Boolean).map(cleanTag));
        else if (h === "country") country = v.slice(0, 2).toUpperCase();
        else if (["status", "created_at", "source", "utm_source", "utm_medium", "utm_campaign"].includes(h)) return;
        else { const k = fieldKey(h); if (k) fields[k] = v.slice(0, 500); }
      });

      const existing = findByEmail(db, email);
      if (existing) {
        if (opts.update_existing) {
          const merged = { ...parseJson<Record<string, unknown>>(existing.fields, {}), ...cleanFields(db, fields, true) };
          db.prepare("UPDATE subscribers SET fields = ?, country = coalesce(?, country) WHERE id = ?").run(JSON.stringify(merged), country, existing.id);
          for (const t of tags) tagStmt.run(existing.id, t);
          result.updated++;
        } else result.skipped++;
        continue;
      }
      const id = newId("sub");
      const isBounced = Boolean(bounced.get(email));
      const st = isBounced ? "bounced" : status;
      insert.run(id, email, st, token(), referralCode(db), JSON.stringify(cleanFields(db, fields, true)), country, at, st === "active" ? at : null);
      hist.run(id, "subscribed", at);
      if (st === "active") hist.run(id, "confirmed", at);
      for (const t of tags) tagStmt.run(id, t);
      result.created++;
    }
  });
  if (status === "pending") {
    for (const r of db.prepare("SELECT id FROM subscribers WHERE status = 'pending' AND source = 'import' AND created_at = ?").all(at) as { id: string }[]) bus.emit("subscriber.pending", { db, cfg }, { subscriberId: r.id });
  }
  return result;
}

export function exportCsv(db: DB, q: ListQuery): string {
  const defs = db.prepare("SELECT key FROM field_defs ORDER BY key").all() as { key: string }[];
  const f = filterSql(db, q);
  const head = ["email", "status", "created_at", "confirmed_at", "source", "utm_source", "utm_medium", "utm_campaign", "country", "tags", "emails_received", "opens", "clicks", ...defs.map((d) => d.key)];
  const lines = [head.join(",")];
  const tagStmt = db.prepare("SELECT tag FROM subscriber_tags WHERE subscriber_id = ? ORDER BY tag");
  for (const r of db.prepare(`SELECT s.* FROM subscribers s WHERE ${f.where} ORDER BY s.rowid`).all(...(f.params as never[])) as unknown as SubscriberRow[]) {
    const fields = parseJson<Record<string, unknown>>(r.fields, {});
    const tags = (tagStmt.all(r.id) as { tag: string }[]).map((t) => t.tag).join(";");
    lines.push([r.email, r.status, iso(r.created_at), iso(r.confirmed_at), r.source, r.utm_source, r.utm_medium, r.utm_campaign, r.country, tags, r.emails_received, r.opens, r.clicks, ...defs.map((d) => fields[d.key])].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
