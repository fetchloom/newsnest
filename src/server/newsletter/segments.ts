import type { DB } from "../db.ts";
import { ApiError, notFound, validation } from "../errors.ts";
import { newId, now, iso } from "../ids.ts";
import { parseJson } from "./util.ts";

export interface Condition { field: string; op: string; value?: unknown }
export interface Group { match: "all" | "any"; conditions: (Condition | Group)[] }

const DAY = 24 * 3600 * 1000;
const MAX_DEPTH = 10;
const STRING_COLS = ["status", "email", "source", "utm_source", "utm_medium", "utm_campaign", "referrer", "country"];
const NUMBER_COLS: Record<string, string> = {
  opens: "s.opens", clicks: "s.clicks", emails_received: "s.emails_received",
  referral_count: "(SELECT COUNT(*) FROM subscribers r WHERE r.referred_by = s.id AND r.status = 'active')",
};
const DATE_COLS: Record<string, string> = { created_at: "s.created_at", last_open_at: "s.last_open_at", last_click_at: "s.last_click_at" };

export const FIELD_CATALOG = [
  ...STRING_COLS.map((f) => ({ field: f, type: "text" })),
  ...Object.keys(NUMBER_COLS).map((f) => ({ field: f, type: "number" })),
  ...Object.keys(DATE_COLS).map((f) => ({ field: f, type: "date" })),
  { field: "engagement", type: "engagement" }, { field: "tag", type: "tag" },
  { field: "opened_post", type: "post" }, { field: "clicked_post", type: "post" },
  { field: "voted_poll", type: "poll" }, { field: "in_segment", type: "segment" },
];

const isGroup = (c: Condition | Group): c is Group => "conditions" in c;

/** engagement: new (joined this week), active (opened or clicked in 30 days), at_risk (90 days), inactive. */
const engagementSql = (at: number): { sql: string; params: number[] } => ({
  sql: `(CASE WHEN s.created_at > ? THEN 'new'
    WHEN max(coalesce(s.last_open_at, 0), coalesce(s.last_click_at, 0)) > ? THEN 'active'
    WHEN max(coalesce(s.last_open_at, 0), coalesce(s.last_click_at, 0)) > ? THEN 'at_risk' ELSE 'inactive' END)`,
  params: [at - 7 * DAY, at - 30 * DAY, at - 90 * DAY],
});

const str = (v: unknown, field: string): string => {
  if (typeof v !== "string" || v.length > 200) throw validation(`Value for "${field}" must be text (max 200 characters)`);
  return v;
};
const num = (v: unknown, field: string): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw validation(`Value for "${field}" must be a number`);
  return n;
};
const like = (v: string, mode: "contains" | "starts" | "ends"): string =>
  (mode === "contains" || mode === "ends" ? "%" : "") + v.replace(/[\\%_]/g, "\\$&") + (mode === "contains" || mode === "starts" ? "%" : "");

function textOp(col: string, op: string, v: unknown, field: string): { sql: string; params: unknown[] } {
  switch (op) {
    case "is": return { sql: `${col} = ?`, params: [str(v, field)] };
    case "is_not": return { sql: `(${col} IS NULL OR ${col} != ?)`, params: [str(v, field)] };
    case "contains": return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [like(str(v, field), "contains")] };
    case "not_contains": return { sql: `(${col} IS NULL OR ${col} NOT LIKE ? ESCAPE '\\')`, params: [like(str(v, field), "contains")] };
    case "starts_with": return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [like(str(v, field), "starts")] };
    case "ends_with": return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [like(str(v, field), "ends")] };
    case "is_set": return { sql: `coalesce(${col}, '') != ''`, params: [] };
    case "is_empty": return { sql: `coalesce(${col}, '') = ''`, params: [] };
  }
  throw validation(`Unknown operator "${op}" for "${field}"`);
}

function numberOp(col: string, op: string, v: unknown, field: string): { sql: string; params: unknown[] } {
  const ops: Record<string, string> = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
  if (!Object.hasOwn(ops, op)) throw validation(`Unknown operator "${op}" for "${field}"`);
  return { sql: `${col} ${ops[op]} ?`, params: [num(v, field)] };
}

function dateOp(col: string, op: string, v: unknown, field: string, at: number): { sql: string; params: unknown[] } {
  switch (op) {
    case "within_days": return { sql: `${col} >= ?`, params: [at - num(v, field) * DAY] };
    case "not_within_days": return { sql: `(${col} IS NULL OR ${col} < ?)`, params: [at - num(v, field) * DAY] };
    case "before": case "after": {
      const ms = Date.parse(str(v, field));
      if (Number.isNaN(ms)) throw validation(`"${field}" needs a date such as 2026-11-01`);
      return { sql: `${col} ${op === "before" ? "<" : ">="} ?`, params: [ms] };
    }
    case "never": return { sql: `${col} IS NULL`, params: [] };
    case "is_set": return { sql: `${col} IS NOT NULL`, params: [] };
  }
  throw validation(`Unknown operator "${op}" for "${field}"`);
}

function compileCondition(db: DB, c: Condition, depth: number, at: number): { sql: string; params: unknown[] } {
  const { field, op, value } = c;
  if (typeof field !== "string" || typeof op !== "string") throw validation("Each condition needs a field and an operator");

  if (STRING_COLS.includes(field)) return textOp(`s.${field}`, op, value, field);
  if (Object.hasOwn(NUMBER_COLS, field)) return numberOp(NUMBER_COLS[field], op, value, field);
  if (Object.hasOwn(DATE_COLS, field)) return dateOp(DATE_COLS[field], op, value, field, at);

  if (field === "engagement") {
    const e = engagementSql(at);
    if (op !== "is" && op !== "is_not") throw validation(`Unknown operator "${op}" for "engagement"`);
    return { sql: `${e.sql} ${op === "is" ? "=" : "!="} ?`, params: [...e.params, str(value, field)] };
  }
  if (field === "tag") {
    if (op !== "has" && op !== "not_has") throw validation(`Unknown operator "${op}" for "tag"`);
    return { sql: `${op === "has" ? "" : "NOT "}EXISTS (SELECT 1 FROM subscriber_tags t WHERE t.subscriber_id = s.id AND t.tag = ?)`, params: [str(value, field).toLowerCase()] };
  }
  if (field === "opened_post" || field === "clicked_post") {
    if (op !== "has" && op !== "not_has") throw validation(`Unknown operator "${op}" for "${field}"`);
    return {
      sql: `${op === "has" ? "" : "NOT "}EXISTS (SELECT 1 FROM events ev JOIN emails em ON em.id = ev.email_id WHERE em.subscriber_id = s.id AND em.post_id = ? AND ev.type = ?)`,
      params: [str(value, field), field === "opened_post" ? "email.opened" : "email.clicked"],
    };
  }
  if (field === "voted_poll") {
    if (op !== "has" && op !== "not_has") throw validation(`Unknown operator "${op}" for "voted_poll"`);
    return { sql: `${op === "has" ? "" : "NOT "}EXISTS (SELECT 1 FROM poll_votes v WHERE v.subscriber_id = s.id AND v.poll_id = ?)`, params: [str(value, field)] };
  }
  if (field === "in_segment") {
    if (op !== "is" && op !== "is_not") throw validation(`Unknown operator "${op}" for "in_segment"`);
    const seg = db.prepare("SELECT * FROM segments WHERE id = ?").get(str(value, field)) as { kind: string; rules: string; id: string } | undefined;
    if (!seg) throw validation("That segment does not exist");
    const inner = seg.kind === "static"
      ? { sql: "EXISTS (SELECT 1 FROM segment_members m WHERE m.segment_id = ? AND m.subscriber_id = s.id)", params: [seg.id] }
      : compileRules(db, parseJson(seg.rules, {}), depth + 1, at);
    return { sql: op === "is" ? `(${inner.sql})` : `NOT (${inner.sql})`, params: inner.params };
  }
  if (field.startsWith("field:")) {
    const key = field.slice(6);
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) throw validation(`Invalid custom field "${key}"`);
    const col = "json_extract(s.fields, ?)";
    const path = `$.${key}`;
    switch (op) {
      case "is": return { sql: `${col} = ?`, params: [path, typeof value === "number" || typeof value === "boolean" ? value : str(value, field)] };
      case "is_not": return { sql: `(${col} IS NULL OR ${col} != ?)`, params: [path, path, str(value, field)] };
      case "contains": return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [path, like(str(value, field), "contains")] };
      case "gt": return { sql: `${col} > ?`, params: [path, num(value, field)] };
      case "lt": return { sql: `${col} < ?`, params: [path, num(value, field)] };
      case "is_set": return { sql: `coalesce(${col}, '') != ''`, params: [path] };
      case "is_empty": return { sql: `coalesce(${col}, '') = ''`, params: [path] };
    }
    throw validation(`Unknown operator "${op}" for "${field}"`);
  }
  throw validation(`Unknown segment field "${field}"`);
}

/** Compiles rules to a WHERE fragment over `subscribers s`. Empty rules match everyone. */
export function compileRules(db: DB, rules: unknown, depth = 0, at = now()): { sql: string; params: unknown[] } {
  if (depth > MAX_DEPTH) throw validation(`Segments can be nested at most ${MAX_DEPTH} levels deep`);
  const g = rules as Group;
  if (!g || typeof g !== "object" || !Array.isArray(g.conditions) || !g.conditions.length) return { sql: "1 = 1", params: [] };
  if (g.match !== "all" && g.match !== "any") throw validation(`"match" must be "all" or "any"`);
  if (g.conditions.length > 50) throw validation("A group can hold at most 50 conditions");

  const parts = g.conditions.map((c) => (isGroup(c) ? compileRules(db, c, depth + 1, at) : compileCondition(db, c, depth, at)));
  return { sql: `(${parts.map((p) => p.sql).join(g.match === "all" ? " AND " : " OR ")})`, params: parts.flatMap((p) => p.params) };
}

/** Who a post or automation goes to: active subscribers narrowed by `all`, `tag:<name>` or `segment:<id>`. */
export function audienceFilter(db: DB, audience: string, at = now()): { sql: string; params: unknown[] } {
  if (audience === "all" || !audience) return { sql: "s.status = 'active'", params: [] };
  const [kind, ...rest] = audience.split(":");
  const value = rest.join(":");
  if (kind === "tag") return { sql: "s.status = 'active' AND EXISTS (SELECT 1 FROM subscriber_tags t WHERE t.subscriber_id = s.id AND t.tag = ?)", params: [value.toLowerCase()] };
  if (kind === "segment") {
    const inner = compileCondition(db, { field: "in_segment", op: "is", value }, 0, at);
    return { sql: `s.status = 'active' AND ${inner.sql}`, params: inner.params };
  }
  throw validation(`Unknown audience "${audience}"`);
}

// ---- CRUD ---------------------------------------------------------------------
interface SegmentRow { id: string; name: string; kind: "dynamic" | "static"; rules: string; created_at: number }

export function segmentCount(db: DB, row: SegmentRow): number {
  if (row.kind === "static") return (db.prepare("SELECT COUNT(*) AS n FROM segment_members m JOIN subscribers s ON s.id = m.subscriber_id WHERE m.segment_id = ? AND s.status = 'active'").get(row.id) as { n: number }).n;
  const w = compileRules(db, parseJson(row.rules, {}));
  return (db.prepare(`SELECT COUNT(*) AS n FROM subscribers s WHERE s.status = 'active' AND ${w.sql}`).get(...(w.params as never[])) as { n: number }).n;
}

const view = (db: DB, r: SegmentRow) => ({ id: r.id, object: "segment", name: r.name, kind: r.kind, rules: parseJson(r.rules, {}), active_subscribers: segmentCount(db, r), created_at: iso(r.created_at) });

function row(db: DB, id: string): SegmentRow {
  const r = db.prepare("SELECT * FROM segments WHERE id = ?").get(id) as unknown as SegmentRow | undefined;
  if (!r) throw notFound("Segment");
  return r;
}

export const getSegment = (db: DB, id: string) => view(db, row(db, id));
export const listSegments = (db: DB) => (db.prepare("SELECT * FROM segments ORDER BY created_at DESC").all() as unknown as SegmentRow[]).map((r) => view(db, r));

export function createSegment(db: DB, body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) throw validation(`"name" is required (max 100 characters)`);
  const kind = body.kind === "static" ? "static" : "dynamic";
  const rules = kind === "dynamic" ? (body.rules ?? { match: "all", conditions: [] }) : {};
  compileRules(db, rules); // validates
  const id = newId("seg");
  db.prepare("INSERT INTO segments (id, name, kind, rules, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, kind, JSON.stringify(rules), now());
  return view(db, row(db, id));
}

export function updateSegment(db: DB, id: string, body: Record<string, unknown>) {
  const cur = row(db, id);
  const name = body.name === undefined ? cur.name : String(body.name).trim();
  if (!name || name.length > 100) throw validation(`"name" is required (max 100 characters)`);
  let rules = cur.rules;
  if (body.rules !== undefined) {
    if (cur.kind !== "dynamic") throw new ApiError(409, "static_segment", "Static segments have no rules. Add or remove members instead.");
    compileRules(db, body.rules);
    rules = JSON.stringify(body.rules);
  }
  db.prepare("UPDATE segments SET name = ?, rules = ? WHERE id = ?").run(name, rules, id);
  return view(db, row(db, id));
}

export function deleteSegment(db: DB, id: string) {
  row(db, id);
  db.prepare("DELETE FROM segments WHERE id = ?").run(id);
  return { id, object: "segment", deleted: true };
}

export function previewRules(db: DB, rules: unknown) {
  const w = compileRules(db, rules);
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM subscribers s WHERE s.status = 'active' AND ${w.sql}`).get(...(w.params as never[])) as { n: number }).n;
  const sample = db.prepare(`SELECT s.email FROM subscribers s WHERE s.status = 'active' AND ${w.sql} ORDER BY s.rowid DESC LIMIT 5`).all(...(w.params as never[])) as { email: string }[];
  return { active_subscribers: count, sample: sample.map((r) => r.email) };
}

/** Freeze a dynamic segment's current members into a new static segment. */
export function snapshotSegment(db: DB, id: string) {
  const cur = row(db, id);
  const w = cur.kind === "dynamic" ? compileRules(db, parseJson(cur.rules, {})) : { sql: "EXISTS (SELECT 1 FROM segment_members m WHERE m.segment_id = ? AND m.subscriber_id = s.id)", params: [cur.id] };
  const newSeg = newId("seg");
  db.prepare("INSERT INTO segments (id, name, kind, rules, created_at) VALUES (?, ?, 'static', '{}', ?)").run(newSeg, `${cur.name} (snapshot ${new Date().toISOString().slice(0, 10)})`, now());
  db.prepare(`INSERT INTO segment_members (segment_id, subscriber_id) SELECT ?, s.id FROM subscribers s WHERE ${w.sql}`).run(newSeg, ...(w.params as never[]));
  return view(db, row(db, newSeg));
}

export function changeMembers(db: DB, id: string, body: Record<string, unknown>) {
  const seg = row(db, id);
  if (seg.kind !== "static") throw new ApiError(409, "dynamic_segment", "Dynamic segments are computed from rules; you can't edit their members.");
  const emails = (body.emails as unknown[] | undefined) ?? [];
  if (!Array.isArray(emails) || emails.length > 10000) throw validation(`"emails" must be a list of up to 10,000 addresses`);
  const find = db.prepare("SELECT id FROM subscribers WHERE email = ?");
  const add = db.prepare("INSERT OR IGNORE INTO segment_members (segment_id, subscriber_id) VALUES (?, ?)");
  const del = db.prepare("DELETE FROM segment_members WHERE segment_id = ? AND subscriber_id = ?");
  const remove = body.remove === true;
  let changed = 0;
  for (const e of emails) {
    const s = find.get(String(e).trim().toLowerCase()) as { id: string } | undefined;
    if (!s) continue;
    changed += Number((remove ? del.run(id, s.id) : add.run(id, s.id)).changes);
  }
  return { id, changed, active_subscribers: segmentCount(db, seg) };
}
