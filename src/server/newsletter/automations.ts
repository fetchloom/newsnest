import { randomBytes } from "node:crypto";
import type { Config } from "../config.ts";
import { tx } from "../db.ts";
import type { DB } from "../db.ts";
import { ApiError, notFound, validation } from "../errors.ts";
import { insertEmail, SYSTEM_KEY } from "../emails.ts";
import type { Prepared } from "../emails.ts";
import { iso, newId, now } from "../ids.ts";
import { cleanBlocks, dynamicBlocks } from "./blocks.ts";
import { bus, runtime } from "./bus.ts";
import { assertCanSend, unsubscribeHeaders } from "./mailer.ts";
import { baseUrl, getPublication } from "./publication.ts";
import { merge, subjectVars } from "./render.ts";
import { compileRules } from "./segments.ts";
import { addTags, findById } from "./subscribers.ts";
import type { SubscriberRow } from "./subscribers.ts";
import { isUrl, parseJson, text } from "./util.ts";

export interface Step { id: string; type: string; [k: string]: any }
export interface Trigger { type: string; [k: string]: any }

const TRIGGERS = ["signup", "tag_added", "link_clicked", "custom_event", "poll_voted", "referral_milestone"] as const;
const MAX_STEPS = 60;
const MAX_DEPTH = 5;
const STEP_TYPES = ["email", "delay", "condition", "add_tag", "remove_tag", "webhook"];

interface AutomationRow { id: string; name: string; status: string; trigger: string; steps: string; allow_reentry: number; created_at: number; updated_at: number }
interface RunRow { id: string; automation_id: string; subscriber_id: string; status: string; cursor: string; next_run_at: number; last_error: string | null; created_at: number; updated_at: number }

// ---- validation ---------------------------------------------------------------
function cleanTrigger(raw: unknown): Trigger {
  const r = (raw ?? {}) as Record<string, any>;
  if (!(TRIGGERS as readonly string[]).includes(r.type)) throw validation(`The trigger type must be one of: ${TRIGGERS.join(", ")}`);
  const t: Trigger = { type: r.type };
  if (r.type === "tag_added") { t.tag = String(r.tag ?? "").trim().toLowerCase(); if (!t.tag) throw validation("Choose which tag starts this automation"); }
  if (r.type === "link_clicked") { t.url_contains = String(r.url_contains ?? "").slice(0, 300); t.post_id = String(r.post_id ?? "").slice(0, 60); }
  if (r.type === "custom_event") { t.name = String(r.name ?? "").trim().toLowerCase(); if (!/^[a-z][a-z0-9_.-]{0,60}$/.test(t.name)) throw validation("Event names are lowercase letters, numbers and _ . -"); }
  if (r.type === "poll_voted") t.poll_id = String(r.poll_id ?? "").slice(0, 60);
  if (r.type === "referral_milestone") t.reward_id = String(r.reward_id ?? "").slice(0, 60);
  if (r.type === "signup") t.source = String(r.source ?? "").slice(0, 40);
  return t;
}

function cleanSteps(db: DB, raw: unknown, depth = 0, counter = { n: 0 }): Step[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw validation(`"steps" must be a list`);
  if (depth > MAX_DEPTH) throw validation(`Branches can be nested at most ${MAX_DEPTH} levels deep`);
  return raw.map((s: Record<string, any>) => {
    if (++counter.n > MAX_STEPS) throw validation(`An automation can have at most ${MAX_STEPS} steps`);
    if (!s || !STEP_TYPES.includes(s.type)) throw validation(`Step type must be one of: ${STEP_TYPES.join(", ")}`);
    const id = typeof s.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(s.id) ? s.id : "st" + randomBytes(5).toString("hex");
    switch (s.type) {
      case "email": {
        const blocks = cleanBlocks(s.blocks ?? []);
        for (const b of dynamicBlocks(blocks)) compileRules(db, b.props.rules);
        const subject = text(s.subject, "subject", 200);
        if (!subject) throw validation("Every email step needs a subject");
        return { id, type: "email", subject, preview: text(s.preview, "preview", 300) ?? "", blocks };
      }
      case "delay": {
        const minutes = Math.round(Number(s.minutes));
        if (!(minutes >= 1 && minutes <= 60 * 24 * 365)) throw validation("A delay must be between 1 minute and 1 year");
        return { id, type: "delay", minutes };
      }
      case "condition": {
        compileRules(db, s.rules);
        return { id, type: "condition", rules: s.rules, yes: cleanSteps(db, s.yes, depth + 1, counter), no: cleanSteps(db, s.no, depth + 1, counter) };
      }
      case "add_tag": case "remove_tag": {
        const tag = String(s.tag ?? "").trim().toLowerCase();
        if (!tag || tag.length > 40) throw validation("Choose a tag");
        return { id, type: s.type, tag };
      }
      case "webhook": {
        const url = String(s.url ?? "");
        if (!isUrl(url)) throw validation("A webhook step needs an http(s) URL");
        return { id, type: "webhook", url };
      }
    }
    throw validation("Unknown step");
  });
}

const view = (db: DB, r: AutomationRow) => {
  const counts = Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM automation_runs WHERE automation_id = ? GROUP BY status").all(r.id) as { status: string; n: number }[]).map((x) => [x.status, x.n]));
  return {
    id: r.id, object: "automation", name: r.name, status: r.status, trigger: parseJson(r.trigger, {}), steps: parseJson(r.steps, []), allow_reentry: !!r.allow_reentry,
    runs: { active: counts.active ?? 0, completed: counts.completed ?? 0, canceled: counts.canceled ?? 0, failed: counts.failed ?? 0 },
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  };
};

function row(db: DB, id: string): AutomationRow {
  const r = db.prepare("SELECT * FROM automations WHERE id = ?").get(id) as unknown as AutomationRow | undefined;
  if (!r) throw notFound("Automation");
  return r;
}

export const getAutomation = (db: DB, id: string) => view(db, row(db, id));
export const listAutomations = (db: DB) => ({ object: "list", data: (db.prepare("SELECT * FROM automations ORDER BY created_at DESC").all() as unknown as AutomationRow[]).map((r) => view(db, r)) });

export function createAutomation(db: DB, body: Record<string, unknown>) {
  const name = text(body.name, "name", 100);
  if (!name) throw validation(`"name" is required`);
  const id = newId("auto");
  const at = now();
  db.prepare("INSERT INTO automations (id, name, status, trigger, steps, allow_reentry, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)")
    .run(id, name, JSON.stringify(cleanTrigger(body.trigger ?? { type: "signup" })), JSON.stringify(cleanSteps(db, body.steps)), body.allow_reentry === true ? 1 : 0, at, at);
  return view(db, row(db, id));
}

export function updateAutomation(db: DB, id: string, body: Record<string, unknown>) {
  const cur = row(db, id);
  const name = body.name !== undefined ? text(body.name, "name", 100) : cur.name;
  if (!name) throw validation(`"name" can't be empty`);
  db.prepare("UPDATE automations SET name = ?, trigger = ?, steps = ?, allow_reentry = ?, updated_at = ? WHERE id = ?").run(
    name,
    body.trigger !== undefined ? JSON.stringify(cleanTrigger(body.trigger)) : cur.trigger,
    body.steps !== undefined ? JSON.stringify(cleanSteps(db, body.steps)) : cur.steps,
    body.allow_reentry !== undefined ? +(body.allow_reentry === true) : cur.allow_reentry,
    now(), id);
  return view(db, row(db, id));
}

export function setAutomationStatus(db: DB, cfg: Config, id: string, status: "live" | "paused") {
  const cur = row(db, id);
  if (status === "live") {
    const steps = parseJson<Step[]>(cur.steps, []);
    if (!steps.length) throw new ApiError(409, "no_steps", "Add at least one step before turning this automation on.");
    if (JSON.stringify(steps).includes('"type":"email"')) assertCanSend(db, cfg, getPublication(db));
  }
  db.prepare("UPDATE automations SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
  return view(db, row(db, id));
}

export function deleteAutomation(db: DB, id: string) {
  row(db, id);
  db.prepare("DELETE FROM automations WHERE id = ?").run(id);
  return { id, object: "automation", deleted: true };
}

export function listRuns(db: DB, id: string, status: string | null) {
  row(db, id);
  const rows = db.prepare(`SELECT r.*, s.email FROM automation_runs r JOIN subscribers s ON s.id = r.subscriber_id WHERE r.automation_id = ? ${status ? "AND r.status = ?" : ""} ORDER BY r.created_at DESC LIMIT 200`)
    .all(...(status ? [id, status] : [id])) as unknown as (RunRow & { email: string })[];
  return { object: "list", data: rows.map((r) => ({ id: r.id, email: r.email, status: r.status, cursor: r.cursor, next_run_at: iso(r.next_run_at), last_error: r.last_error, started_at: iso(r.created_at) })) };
}

// ---- triggering ---------------------------------------------------------------
function matches(t: Trigger, name: string, data: Record<string, any>): boolean {
  if (t.type !== name) return false;
  switch (name) {
    case "tag_added": return data.tag === t.tag;
    case "link_clicked": return (!t.url_contains || String(data.url ?? "").includes(t.url_contains)) && (!t.post_id || data.postId === t.post_id);
    case "custom_event": return data.name === t.name;
    case "poll_voted": return !t.poll_id || data.pollId === t.poll_id;
    case "referral_milestone": return !t.reward_id || data.rewardId === t.reward_id;
    case "signup": return !t.source || data.source === t.source;
  }
  return false;
}

export function fire(db: DB, name: string, subscriberId: string, data: Record<string, any> = {}): void {
  const sub = db.prepare("SELECT id, status, source FROM subscribers WHERE id = ?").get(subscriberId) as { id: string; status: string; source: string } | undefined;
  if (!sub || sub.status !== "active") return;
  const payload = name === "signup" ? { ...data, source: sub.source } : data;
  for (const a of db.prepare("SELECT * FROM automations WHERE status = 'live'").all() as unknown as AutomationRow[]) {
    if (!matches(parseJson<Trigger>(a.trigger, { type: "" }), name, payload)) continue;
    const prior = db.prepare("SELECT status FROM automation_runs WHERE automation_id = ? AND subscriber_id = ?").all(a.id, subscriberId) as { status: string }[];
    if (prior.some((p) => p.status === "active") || (prior.length && !a.allow_reentry)) continue;
    const at = now();
    db.prepare("INSERT INTO automation_runs (id, automation_id, subscriber_id, cursor, next_run_at, created_at, updated_at) VALUES (?, ?, ?, '0', ?, ?, ?)").run(newId("run"), a.id, subscriberId, at, at, at);
  }
}

// ---- running ------------------------------------------------------------------
type Path = (number | "yes" | "no")[];
const parsePath = (c: string): Path => c.split(".").map((p) => (p === "yes" || p === "no" ? p : Number(p)));

function stepAt(steps: Step[], path: Path): Step | null {
  let list: Step[] = steps;
  let step: Step | null = null;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (typeof p === "number") { step = list[p] ?? null; if (!step) return null; }
    else list = (step as Step)[p] as Step[];
  }
  return step;
}

/** The step after `path`: the next sibling, or the next sibling of the enclosing condition when a branch ends. */
function nextPath(steps: Step[], path: Path): Path | null {
  const p = [...path];
  for (;;) {
    const idx = p.pop() as number;
    const parentList: Step[] = p.length ? ((stepAt(steps, p.slice(0, -1)) as Step)[p[p.length - 1] as "yes" | "no"] as Step[]) : steps;
    if (idx + 1 < parentList.length) return [...p, idx + 1];
    if (!p.length) return null;
    p.pop(); // leave the branch; continue after the condition itself
    if (!p.length) return null;
  }
}

function conditionHolds(db: DB, subscriberId: string, rules: unknown): boolean {
  const w = compileRules(db, rules);
  return !!db.prepare(`SELECT 1 FROM subscribers s WHERE s.id = ? AND ${w.sql}`).get(subscriberId, ...(w.params as never[]));
}

function runStep(db: DB, cfg: Config, run: RunRow, sub: SubscriberRow, step: Step): { delayMs?: number; branch?: "yes" | "no" } {
  switch (step.type) {
    case "email": {
      const pub = getPublication(db);
      const { from, domain } = assertCanSend(db, cfg, pub);
      const base = baseUrl(db, cfg, pub);
      const p: Prepared = {
        from, to: [{ email: sub.email }], cc: [], bcc: [], replyTo: pub.reply_to ? [pub.reply_to] : [],
        subject: merge(step.subject, subjectVars(pub, sub)), html: "", text: "",
        headers: unsubscribeHeaders(base, sub.token, null), tags: [{ name: "automation", value: run.automation_id.replace(/[^A-Za-z0-9_-]/g, "-") }],
        scheduledAt: null, domain,
      };
      insertEmail(db, p, SYSTEM_KEY, now(), { kind: "automation", subscriber_id: sub.id, variant: step.id, automation_run_id: run.id });
      runtime.kick();
      return {};
    }
    case "delay": return { delayMs: step.minutes * 60_000 };
    case "condition": return { branch: conditionHolds(db, sub.id, step.rules) ? "yes" : "no" };
    case "add_tag": addTags(db, cfg, sub.id, [step.tag]); return {};
    case "remove_tag": db.prepare("DELETE FROM subscriber_tags WHERE subscriber_id = ? AND tag = ?").run(sub.id, step.tag); return {};
    case "webhook": {
      void fetch(step.url, {
        method: "POST", headers: { "content-type": "application/json", "user-agent": "Freepost-Automations/1" }, redirect: "manual", signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ type: "automation.step", automation_id: run.automation_id, subscriber: { id: sub.id, email: sub.email, fields: parseJson(sub.fields, {}) } }),
      }).catch((e) => console.error("automation webhook:", (e as Error).message));
      return {};
    }
  }
  return {};
}

function advance(db: DB, cfg: Config, run: RunRow): void {
  const auto = db.prepare("SELECT * FROM automations WHERE id = ?").get(run.automation_id) as unknown as AutomationRow | undefined;
  const sub = db.prepare("SELECT * FROM subscribers WHERE id = ?").get(run.subscriber_id) as unknown as SubscriberRow | undefined;
  const stop = (status: string, error: string | null = null) => db.prepare("UPDATE automation_runs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?").run(status, error, now(), run.id);
  if (!auto || !sub || sub.status !== "active") return void stop("canceled");
  if (auto.status === "paused") { db.prepare("UPDATE automation_runs SET next_run_at = ? WHERE id = ?").run(now() + 60_000, run.id); return; }

  const steps = parseJson<Step[]>(auto.steps, []);
  let path: Path | null = parsePath(run.cursor);
  for (let guard = 0; guard < 50 && path; guard++) {
    const step = stepAt(steps, path);
    if (!step) return void stop("completed");
    let result: ReturnType<typeof runStep>;
    try { result = runStep(db, cfg, run, sub, step); }
    catch (e) { return void stop("failed", (e as Error).message); }

    if (result.branch) {
      const branch = (step[result.branch] as Step[]) ?? [];
      path = branch.length ? [...path, result.branch, 0] : nextPath(steps, path);
    } else path = nextPath(steps, path);

    if (!path) return void stop("completed");
    if (result.delayMs) {
      db.prepare("UPDATE automation_runs SET cursor = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(path.join("."), now() + result.delayMs, now(), run.id);
      return;
    }
    db.prepare("UPDATE automation_runs SET cursor = ?, updated_at = ? WHERE id = ?").run(path.join("."), now(), run.id);
  }
}

/** Advances every run that is due. Called by the queue loop. */
export function automationTick(db: DB, cfg: Config): boolean {
  const due = db.prepare("SELECT * FROM automation_runs WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at LIMIT 100").all(now()) as unknown as RunRow[];
  for (const run of due) {
    try { tx(db, () => advance(db, cfg, run)); }
    catch (e) { console.error(`automation run ${run.id}:`, (e as Error).message); db.prepare("UPDATE automation_runs SET status = 'failed', last_error = ? WHERE id = ?").run((e as Error).message, run.id); }
  }
  return due.length > 0;
}

export function automationStats(db: DB, id: string) {
  row(db, id);
  const n = (type: string): number => (db.prepare(`SELECT COUNT(DISTINCT ev.email_id) AS n FROM events ev JOIN emails e ON e.id = ev.email_id JOIN automation_runs r ON r.id = e.automation_run_id WHERE r.automation_id = ? AND ev.type = ?`).get(id, type) as { n: number }).n;
  const sent = (db.prepare("SELECT COUNT(*) AS n FROM emails e JOIN automation_runs r ON r.id = e.automation_run_id WHERE r.automation_id = ?").get(id) as { n: number }).n;
  return { emails: sent, opens: n("email.opened"), clicks: n("email.clicked") };
}

// ---- custom events ------------------------------------------------------------
export function recordCustomEvent(db: DB, cfg: Config, body: Record<string, unknown>) {
  const name = String(body.name ?? "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{0,60}$/.test(name)) throw validation(`"name" must be lowercase letters, numbers and _ . -`);
  const email = String(body.email ?? "").trim().toLowerCase();
  const sub = db.prepare("SELECT * FROM subscribers WHERE email = ?").get(email) as unknown as SubscriberRow | undefined;
  if (!sub) throw notFound("Subscriber");
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : {};
  if (JSON.stringify(data).length > 10_000) throw validation(`"data" is too large`);
  const id = newId("cev");
  db.prepare("INSERT INTO custom_events (id, subscriber_id, name, data, created_at) VALUES (?, ?, ?, ?, ?)").run(id, sub.id, name, JSON.stringify(data), now());
  bus.emit("event.custom", { db, cfg }, { subscriberId: sub.id, name });
  return { id, object: "event", name, email };
}

/** Connects subscriber activity to the automations that listen for it. Called once at start. */
export function registerAutomations(): void {
  bus.on("subscriber.confirmed", ({ db }, p) => fire(db, "signup", p.subscriberId));
  bus.on("subscriber.tag_added", ({ db }, p) => fire(db, "tag_added", p.subscriberId, { tag: p.tag }));
  bus.on("email.clicked", ({ db }, p) => fire(db, "link_clicked", p.subscriberId, { url: p.url, postId: p.postId }));
  bus.on("event.custom", ({ db }, p) => fire(db, "custom_event", p.subscriberId, { name: p.name }));
  bus.on("poll.voted", ({ db }, p) => fire(db, "poll_voted", p.subscriberId, { pollId: p.pollId }));
  bus.on("reward.earned", ({ db }, p) => fire(db, "referral_milestone", p.subscriberId, { rewardId: p.rewardId }));
}
