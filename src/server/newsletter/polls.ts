import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { ApiError, notFound, validation } from "../errors.ts";
import { iso, newId, now } from "../ids.ts";
import { bus } from "./bus.ts";
import { findByToken } from "./subscribers.ts";
import { csvCell, parseJson, text } from "./util.ts";

// ---- polls --------------------------------------------------------------------
interface PollRow { id: string; question: string; options: string; closed: number; created_at: number }

export function pollResults(db: DB, p: PollRow) {
  const options = parseJson<string[]>(p.options, []);
  const counts = new Array(options.length).fill(0);
  for (const r of db.prepare("SELECT option, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option").all(p.id) as { option: number; n: number }[]) if (counts[r.option] !== undefined) counts[r.option] = r.n;
  const total = counts.reduce((a: number, b: number) => a + b, 0);
  return { id: p.id, object: "poll", question: p.question, closed: !!p.closed, total_votes: total, created_at: iso(p.created_at),
    options: options.map((label, i) => ({ index: i, label, votes: counts[i], percent: total ? Math.round((counts[i] / total) * 1000) / 10 : 0 })) };
}

export function pollRow(db: DB, id: string): PollRow {
  const r = db.prepare("SELECT * FROM polls WHERE id = ?").get(id) as unknown as PollRow | undefined;
  if (!r) throw notFound("Poll");
  return r;
}

function cleanOptions(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) throw validation(`A poll needs 2 to 8 options`);
  return raw.map((o) => { const s = String(o).trim(); if (!s || s.length > 120) throw validation("Poll options must be 1–120 characters"); return s; });
}

export function createPoll(db: DB, body: Record<string, unknown>) {
  const question = text(body.question, "question", 300);
  if (!question) throw validation(`"question" is required`);
  const id = newId("poll");
  db.prepare("INSERT INTO polls (id, question, options, created_at) VALUES (?, ?, ?, ?)").run(id, question, JSON.stringify(cleanOptions(body.options)), now());
  return pollResults(db, pollRow(db, id));
}

export function updatePoll(db: DB, id: string, body: Record<string, unknown>) {
  const cur = pollRow(db, id);
  const votes = (db.prepare("SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?").get(id) as { n: number }).n;
  if ((body.question !== undefined || body.options !== undefined) && votes > 0) throw new ApiError(409, "poll_has_votes", "A poll with votes can only be closed or reopened.");
  db.prepare("UPDATE polls SET question = ?, options = ?, closed = ? WHERE id = ?").run(
    body.question !== undefined ? text(body.question, "question", 300) : cur.question,
    body.options !== undefined ? JSON.stringify(cleanOptions(body.options)) : cur.options,
    body.closed !== undefined ? +(body.closed === true) : cur.closed, id);
  return pollResults(db, pollRow(db, id));
}

export const listPolls = (db: DB) => ({ object: "list", data: (db.prepare("SELECT * FROM polls ORDER BY created_at DESC").all() as unknown as PollRow[]).map((p) => pollResults(db, p)) });
export const getPoll = (db: DB, id: string) => pollResults(db, pollRow(db, id));
export function deletePoll(db: DB, id: string) { pollRow(db, id); db.prepare("DELETE FROM polls WHERE id = ?").run(id); return { id, object: "poll", deleted: true }; }

/** Records a vote from a subscriber's personal link. One vote each; a second click keeps the first. */
export function vote(db: DB, cfg: Config, pollId: string, option: number, subscriberToken: string): "voted" | "already" | "closed" | "invalid" {
  const poll = db.prepare("SELECT * FROM polls WHERE id = ?").get(pollId) as unknown as PollRow | undefined;
  const sub = findByToken(db, subscriberToken);
  if (!poll || !sub || sub.status !== "active") return "invalid";
  if (poll.closed) return "closed";
  if (!Number.isInteger(option) || option < 0 || option >= parseJson<string[]>(poll.options, []).length) return "invalid";
  const res = db.prepare("INSERT OR IGNORE INTO poll_votes (poll_id, subscriber_id, option, created_at) VALUES (?, ?, ?, ?)").run(pollId, sub.id, option, now());
  if (!res.changes) return "already";
  bus.emit("poll.voted", { db, cfg }, { subscriberId: sub.id, pollId });
  return "voted";
}

// ---- surveys ------------------------------------------------------------------
interface SurveyRow { id: string; title: string; description: string; questions: string; closed: number; created_at: number }
export interface Question { id: string; type: "choice" | "multi" | "text" | "rating"; label: string; required: boolean; options?: string[] }

function cleanQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) throw validation("A survey needs 1 to 30 questions");
  return raw.map((q: Record<string, any>, i) => {
    const type = ["choice", "multi", "text", "rating"].includes(q?.type) ? q.type : null;
    const label = typeof q?.label === "string" ? q.label.trim() : "";
    if (!type || !label || label.length > 300) throw validation(`Question ${i + 1} needs a type and a label`);
    const out: Question = { id: typeof q.id === "string" && /^[a-z0-9_-]{1,30}$/i.test(q.id) ? q.id : `q${i + 1}`, type, label, required: q.required === true };
    if (type === "choice" || type === "multi") {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 12) throw validation(`Question ${i + 1} needs 2 to 12 options`);
      out.options = q.options.map((o: unknown) => String(o).trim().slice(0, 120)).filter(Boolean);
    }
    return out;
  });
}

const surveyView = (db: DB, r: SurveyRow) => ({
  id: r.id, object: "survey", title: r.title, description: r.description, questions: parseJson<Question[]>(r.questions, []), closed: !!r.closed,
  responses: (db.prepare("SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ?").get(r.id) as { n: number }).n, created_at: iso(r.created_at),
});

export function surveyRow(db: DB, id: string): SurveyRow {
  const r = db.prepare("SELECT * FROM surveys WHERE id = ?").get(id) as unknown as SurveyRow | undefined;
  if (!r) throw notFound("Survey");
  return r;
}

export function createSurvey(db: DB, body: Record<string, unknown>) {
  const title = text(body.title, "title", 200);
  if (!title) throw validation(`"title" is required`);
  const id = newId("srv");
  db.prepare("INSERT INTO surveys (id, title, description, questions, created_at) VALUES (?, ?, ?, ?, ?)").run(id, title, text(body.description, "description", 1000) ?? "", JSON.stringify(cleanQuestions(body.questions)), now());
  return surveyView(db, surveyRow(db, id));
}

export function updateSurvey(db: DB, id: string, body: Record<string, unknown>) {
  const cur = surveyRow(db, id);
  const answered = (db.prepare("SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ?").get(id) as { n: number }).n;
  if (body.questions !== undefined && answered > 0) throw new ApiError(409, "survey_has_responses", "Questions can't change once there are responses. Close it and make a new survey.");
  db.prepare("UPDATE surveys SET title = ?, description = ?, questions = ?, closed = ? WHERE id = ?").run(
    body.title !== undefined ? text(body.title, "title", 200) : cur.title,
    body.description !== undefined ? text(body.description, "description", 1000) : cur.description,
    body.questions !== undefined ? JSON.stringify(cleanQuestions(body.questions)) : cur.questions,
    body.closed !== undefined ? +(body.closed === true) : cur.closed, id);
  return surveyView(db, surveyRow(db, id));
}

export const listSurveys = (db: DB) => ({ object: "list", data: (db.prepare("SELECT * FROM surveys ORDER BY created_at DESC").all() as unknown as SurveyRow[]).map((r) => surveyView(db, r)) });
export const getSurvey = (db: DB, id: string) => surveyView(db, surveyRow(db, id));
export function deleteSurvey(db: DB, id: string) { surveyRow(db, id); db.prepare("DELETE FROM surveys WHERE id = ?").run(id); return { id, object: "survey", deleted: true }; }

/** Anonymous responses (no valid subscriber link) per survey. Anyone can post one, so the table can't be left to grow without end. */
const MAX_ANONYMOUS_RESPONSES = 1000;

/** Validates and stores one response. `subscriberToken` ties it to a person (one response each). */
export function submitSurvey(db: DB, surveyId: string, subscriberToken: string | null, answers: Record<string, unknown>): "ok" | "closed" | "already" {
  const s = surveyRow(db, surveyId);
  if (s.closed) return "closed";
  const sub = subscriberToken ? findByToken(db, subscriberToken) : undefined;
  if (sub && db.prepare("SELECT 1 FROM survey_responses WHERE survey_id = ? AND subscriber_id = ?").get(surveyId, sub.id)) return "already";
  if (!sub && (db.prepare("SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ? AND subscriber_id IS NULL").get(surveyId) as { n: number }).n >= MAX_ANONYMOUS_RESPONSES) return "closed";

  const clean: Record<string, unknown> = {};
  for (const q of parseJson<Question[]>(s.questions, [])) {
    const v = answers[q.id];
    const empty = v == null || v === "" || (Array.isArray(v) && !v.length);
    if (empty) { if (q.required) throw validation(`Please answer: ${q.label}`); continue; }
    if (q.type === "text") clean[q.id] = String(v).slice(0, 2000);
    else if (q.type === "rating") { const n = Number(v); if (!(n >= 1 && n <= 5)) throw validation(`"${q.label}" needs a rating from 1 to 5`); clean[q.id] = n; }
    else {
      const picks = (Array.isArray(v) ? v : [v]).map(String);
      if (picks.some((p) => !q.options!.includes(p)) || (q.type === "choice" && picks.length !== 1)) throw validation(`Pick a valid answer for "${q.label}"`);
      clean[q.id] = q.type === "choice" ? picks[0] : picks;
    }
  }
  db.prepare("INSERT INTO survey_responses (id, survey_id, subscriber_id, answers, created_at) VALUES (?, ?, ?, ?, ?)").run(newId("rsp"), surveyId, sub?.id ?? null, JSON.stringify(clean), now());
  return "ok";
}

export function surveyResults(db: DB, id: string) {
  const s = surveyRow(db, id);
  const questions = parseJson<Question[]>(s.questions, []);
  const rows = db.prepare("SELECT r.answers, r.created_at, sub.email FROM survey_responses r LEFT JOIN subscribers sub ON sub.id = r.subscriber_id WHERE r.survey_id = ? ORDER BY r.created_at DESC").all(id) as { answers: string; created_at: number; email: string | null }[];
  const parsed = rows.map((r) => ({ answers: parseJson<Record<string, unknown>>(r.answers, {}), email: r.email, created_at: iso(r.created_at) }));
  return {
    ...surveyView(db, s),
    summary: questions.map((q) => {
      const given = parsed.map((r) => r.answers[q.id]).filter((v) => v !== undefined);
      if (q.type === "text") return { id: q.id, label: q.label, type: q.type, answered: given.length, samples: given.slice(0, 20) };
      if (q.type === "rating") { const nums = given.map(Number); return { id: q.id, label: q.label, type: q.type, answered: nums.length, average: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : 0, counts: [1, 2, 3, 4, 5].map((n) => nums.filter((x) => x === n).length) }; }
      const tally = Object.fromEntries((q.options ?? []).map((o) => [o, 0]));
      for (const v of given) for (const o of Array.isArray(v) ? v : [v]) if (tally[String(o)] !== undefined) tally[String(o)]++;
      return { id: q.id, label: q.label, type: q.type, answered: given.length, counts: tally };
    }),
    responses: parsed.slice(0, 200),
  };
}

export function surveyCsv(db: DB, id: string): string {
  const s = surveyRow(db, id);
  const questions = parseJson<Question[]>(s.questions, []);
  const lines = [["submitted_at", "email", ...questions.map((q) => q.label)].map(csvCell).join(",")];
  for (const r of db.prepare("SELECT r.answers, r.created_at, sub.email FROM survey_responses r LEFT JOIN subscribers sub ON sub.id = r.subscriber_id WHERE r.survey_id = ? ORDER BY r.created_at").all(id) as { answers: string; created_at: number; email: string | null }[]) {
    const a = parseJson<Record<string, unknown>>(r.answers, {});
    lines.push([iso(r.created_at), r.email, ...questions.map((q) => (Array.isArray(a[q.id]) ? (a[q.id] as unknown[]).join("; ") : a[q.id]))].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
