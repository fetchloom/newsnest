import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { windowLimiter } from "../src/server/limiter.ts";
import { purgeStale, STALE_PENDING_MS } from "../src/server/newsletter/maintenance.ts";
import { submitSurvey } from "../src/server/newsletter/polls.ts";
import { harness, verifiedDomain } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

const subjectOf = (data: string): string => /^Subject: (.*)$/m.exec(data)?.[1] ?? "";

/** A fresh server with a sender configured, and helpers that talk to its public pages. */
async function setup(overrides: Parameters<typeof harness>[0] = {}) {
  const h = await harness(overrides);
  await verifiedDomain(h);
  await h.call("PATCH", "/publication", { name: "Abuse Letter", from_email: "news@example.com", site_url: h.base });
  const pub = (path: string, init: RequestInit = {}) => fetch(h.base + path, { redirect: "manual", ...init });
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    pub(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
  const mailsTo = async (to: string, re: RegExp) => { await h.app.queue.tick(); return h.smtp.messages.filter((m) => m.to[0] === to && re.test(subjectOf(m.data))).length; };
  return { h, pub, form, mailsTo };
}

describe("windowLimiter", () => {
  test("counts per key, resets after the window, and stays bounded", async () => {
    const allow = windowLimiter(3);
    assert.deepEqual([1, 2, 3, 4].map(() => allow("a", 3, 60_000)), [true, true, true, false]);
    assert.equal(allow("b", 1, 60_000), true);
    assert.equal(allow("c", 1, 60_000), true);
    assert.equal(allow("d", 1, 60_000), true); // pushes "a", the oldest, out
    assert.equal(allow("a", 3, 60_000), true, "an evicted key starts fresh");
    assert.equal(allow("d", 1, 60_000), false, "newer keys are kept");
    const quick = windowLimiter();
    assert.equal(quick("k", 1, 20), true);
    assert.equal(quick("k", 1, 20), false);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(quick("k", 1, 20), true);
  });
});

describe("sign-in links and sign-ups", () => {
  test("one address can be sent at most 3 sign-in links per half hour, whoever asks", async () => {
    const { h, form, mailsTo } = await setup();
    try {
      await h.call("POST", "/subscribers", { email: "target@example.org" });
      await h.call("POST", "/subscribers", { email: "other@example.org" });
      for (let i = 0; i < 6; i++) assert.equal((await form("/login", { email: i % 2 ? "TARGET@example.org " : "target@example.org" })).status, 200, "the page never changes");
      assert.equal(await mailsTo("target@example.org", /sign-in link/), 3);
      await form("/login", { email: "other@example.org" });
      assert.equal(await mailsTo("other@example.org", /sign-in link/), 1, "another address is unaffected");
    } finally { await h.close(); }
  });

  test("public pages can only trigger NEWSNEST_PUBLIC_MAIL_PER_HOUR system emails an hour", async () => {
    const { h, form, mailsTo } = await setup({ publicMailPerHour: 3 });
    try {
      for (const n of [1, 2, 3, 4]) await h.call("POST", "/subscribers", { email: `reader${n}@example.org` });
      for (const n of [1, 2, 3, 4]) await form("/login", { email: `reader${n}@example.org` });
      let sent = 0;
      for (const n of [1, 2, 3, 4]) sent += await mailsTo(`reader${n}@example.org`, /sign-in link/);
      assert.equal(sent, 3);
      const res = await form("/subscribe", { email: "newcomer@example.org" });
      assert.equal(res.status, 429, "sign-ups that would send mail are refused once the budget is spent");
      assert.equal((await h.call("GET", "/subscribers/newcomer@example.org")).status, 404);
    } finally { await h.close(); }
  });
});

describe("clean-up of public leftovers", () => {
  test("expired sign-in tokens and old unconfirmed public sign-ups go; the owner's own entries stay", async () => {
    const { h, form } = await setup();
    try {
      await form("/subscribe", { email: "never@example.org" });
      await form("/subscribe", { email: "recent@example.org" });
      await h.call("POST", "/subscribers", { email: "imported@example.org", send_confirmation: true });
      await h.call("POST", "/subscribers", { email: "active@example.org" });
      await h.app.queue.tick();
      const db = h.app.db;
      const old = Date.now() - STALE_PENDING_MS - 1000;
      db.prepare("UPDATE subscribers SET created_at = ? WHERE email IN ('never@example.org', 'imported@example.org')").run(old);
      db.prepare("INSERT INTO magic_tokens (id, subscriber_id, expires_at) VALUES ('t_old', (SELECT id FROM subscribers WHERE email = 'active@example.org'), ?)").run(Date.now() - 1000);
      db.prepare("INSERT INTO magic_tokens (id, subscriber_id, expires_at) VALUES ('t_new', (SELECT id FROM subscribers WHERE email = 'active@example.org'), ?)").run(Date.now() + 60_000);
      const delivery = (db.prepare("SELECT d.id FROM deliveries d JOIN emails e ON e.id = d.email_id JOIN subscribers s ON s.id = e.subscriber_id WHERE s.email = 'never@example.org'").get() as { id: string }).id;
      mkdirSync(join(h.cfg.dataDir, "outbox"), { recursive: true });
      const file = join(h.cfg.dataDir, "outbox", `${delivery}.eml`);
      writeFileSync(file, "x");

      const out = purgeStale(db, h.cfg);
      assert.deepEqual(out, { tokens: 1, subscribers: 1 });
      const has = (email: string) => Boolean(db.prepare("SELECT 1 FROM subscribers WHERE email = ?").get(email));
      assert.deepEqual(["never", "recent", "imported", "active"].map((n) => has(`${n}@example.org`)), [false, true, true, true]);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM magic_tokens").get()!.n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails WHERE id IN (SELECT email_id FROM deliveries WHERE id = ?)").get(delivery)!.n, 0, "its confirmation email is gone too");
      assert.equal(existsSync(file), false, "and its outbox file");
    } finally { await h.close(); }
  });

  test("outbox mode stops writing confirmation mail once a lot of sign-ups are waiting", async () => {
    const { h, form } = await setup({ mode: "outbox" });
    try {
      const insert = h.app.db.prepare("INSERT INTO subscribers (id, email, status, token, referral_code, created_at) VALUES (?, ?, 'pending', ?, ?, ?)");
      for (let i = 0; i < 2001; i++) insert.run(`sub_f${i}`, `fill${i}@example.org`, `tok${i}`, `ref${i}`, Date.now());
      await form("/subscribe", { email: "latecomer@example.org" });
      await h.app.queue.tick();
      assert.equal(h.app.db.prepare("SELECT COUNT(*) AS n FROM emails WHERE kind = 'system'").get()!.n, 0);
      assert.equal((await h.call("GET", "/subscribers/latecomer@example.org")).json.status, "pending", "the sign-up itself is still accepted");
    } finally { await h.close(); }
  });
});

describe("tracking endpoints", () => {
  test("repeated opens of one email are one event, and the pixel is always served", async () => {
    const { h, pub } = await setup();
    try {
      const id = (await h.call("POST", "/emails", { from: "a@example.com", to: "x@dest.test", subject: "t", text: "x" })).json.id;
      for (let i = 0; i < 30; i++) {
        const res = await pub(`/o/${id}.gif`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "image/gif");
      }
      assert.equal(h.app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE email_id = ? AND type = 'email.opened'").get(id)!.n, 1);
    } finally { await h.close(); }
  });

  test("a flood of clicks on one email is capped, but every link still redirects", async () => {
    const { h, pub } = await setup();
    try {
      const id = (await h.call("POST", "/emails", { from: "a@example.com", to: "x@dest.test", subject: "t", text: "x" })).json.id;
      h.app.db.prepare("INSERT INTO links (id, scope, url) VALUES ('lnk_flood', 's', 'https://example.com/landing')").run();
      for (let i = 0; i < 75; i++) {
        const res = await pub(`/l/lnk_flood/${id}`);
        assert.equal(res.status, 302);
        assert.equal(res.headers.get("location"), "https://example.com/landing");
      }
      const n = h.app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE email_id = ? AND type = 'email.clicked'").get(id)!.n as number;
      assert.ok(n > 0 && n <= 60, `recorded ${n}`);
    } finally { await h.close(); }
  });
});

describe("anonymous survey answers", () => {
  test("per-visitor rate limit on the public form", async () => {
    const { h, pub, form } = await setup();
    try {
      const survey = (await h.call("POST", "/surveys", { title: "S", questions: [{ type: "text", label: "Thoughts?" }] })).json;
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await form(`/s/${survey.id}`, { q_q1: `answer ${i}` })).status);
      assert.deepEqual(statuses.slice(0, 10), new Array(10).fill(200));
      assert.deepEqual(statuses.slice(10), [429, 429]);
      assert.equal(h.app.db.prepare("SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ?").get(survey.id)!.n, 10);
      assert.equal((await pub(`/s/${survey.id}`)).status, 200, "reading it is not limited");
    } finally { await h.close(); }
  });

  test("a survey stops taking anonymous responses after 1000, but subscribers can still answer", async () => {
    const { h } = await setup();
    try {
      const survey = (await h.call("POST", "/surveys", { title: "S", questions: [{ type: "text", label: "Thoughts?" }] })).json;
      const insert = h.app.db.prepare("INSERT INTO survey_responses (id, survey_id, subscriber_id, answers, created_at) VALUES (?, ?, NULL, '{}', 0)");
      for (let i = 0; i < 1000; i++) insert.run(`rsp_${i}`, survey.id);
      assert.equal(submitSurvey(h.app.db, survey.id, null, { q1: "late" }), "closed");
      const sub = (await h.call("POST", "/subscribers", { email: "member@example.org" })).json;
      const token = (h.app.db.prepare("SELECT token FROM subscribers WHERE id = ?").get(sub.id) as { token: string }).token;
      assert.equal(submitSurvey(h.app.db, survey.id, token, { q1: "still fine" }), "ok");
    } finally { await h.close(); }
  });
});
