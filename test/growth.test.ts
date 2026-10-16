import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { harness, verifiedDomain } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;

before(async () => {
  h = await harness();
  await verifiedDomain(h);
  await h.call("PATCH", "/publication", { name: "Growth Letter", from_email: "news@example.com", site_url: h.base, referral_enabled: true, welcome_body: "Welcome aboard, {{first_name | friend}}!" });
});
after(() => h.close());

const sub = (email: string, extra: Record<string, unknown> = {}) => h.call("POST", "/subscribers", { email, ...extra });
const pub = (path: string, init: RequestInit = {}) => fetch(h.base + path, { redirect: "manual", ...init });
const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  pub(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
const subjectOf = (data: string): string => /^Subject: (.*)$/m.exec(data)?.[1] ?? "";
const bodyOf = (data: string): string => [...data.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8")).join("\n");
const mailTo = (to: string, re: RegExp) => h.waitFor(() => h.smtp.messages.find((m) => m.to[0] === to && re.test(subjectOf(m.data))), 5000);

describe("subscribe, confirm, welcome", () => {
  test("double opt-in: form -> confirmation email -> confirm -> welcome email", async () => {
    const res = await form("/subscribe", { email: "Fran@Example.org", first_name: "Fran", utm_source: "twitter", referrer: "news.ycombinator.com" });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Check your inbox/);

    const s = (await h.call("GET", "/subscribers/fran@example.org")).json;
    assert.equal(s.status, "pending");
    assert.equal(s.source, "form");
    assert.equal(s.utm_source, "twitter");

    const confirm = await mailTo("fran@example.org", /Confirm your subscription/);
    const link = /href="(http[^"]+\/confirm\/[A-Za-z0-9_-]+)"/.exec(bodyOf(confirm.data))![1];
    assert.ok(!/Unsubscribe/.test(bodyOf(confirm.data)), "a confirmation email has no unsubscribe link");

    const page = await pub(new URL(link).pathname);
    assert.equal(page.status, 200);
    assert.equal((await h.call("GET", "/subscribers/fran@example.org")).json.status, "active");
    const welcome = await mailTo("fran@example.org", /Welcome to Growth Letter/);
    assert.match(bodyOf(welcome.data), /Welcome aboard, Fran!/);
    assert.match(welcome.data, /List-Unsubscribe:/);
  });

  test("the honeypot, rate limit and bad input are handled quietly", async () => {
    const before = (await h.call("GET", "/subscribers")).json.total;
    const bot = await form("/subscribe", { email: "bot@example.org", website: "http://spam" });
    assert.equal(bot.status, 200, "bots get a normal-looking answer");
    assert.equal((await h.call("GET", "/subscribers")).json.total, before, "but nothing is stored");
    const bad = await pub("/subscribe", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ email: "nope" }) });
    assert.equal(bad.status, 422);
    assert.equal(bad.headers.get("access-control-allow-origin"), "*", "the embed form can post from other sites");
    const pre = await pub("/subscribe", { method: "OPTIONS" });
    assert.equal(pre.status, 204);
  });

  test("an existing subscriber isn't revealed or re-mailed", async () => {
    await sub("grace@example.org");
    const count = h.smtp.messages.length;
    const res = await pub("/subscribe", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ email: "grace@example.org" }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(h.smtp.messages.length, count);
  });

  test("single opt-in subscribes at once when double opt-in is off", async () => {
    await h.call("PATCH", "/publication", { double_opt_in: false });
    await form("/subscribe", { email: "hank@example.org" });
    assert.equal((await h.call("GET", "/subscribers/hank@example.org")).json.status, "active");
    await h.call("PATCH", "/publication", { double_opt_in: true });
  });

  test("hosted subscribe page, embed script and forms snippets", async () => {
    const page = await pub("/subscribe?embed=1&utm_source=blog&ref=zzzz");
    const html = await page.text();
    assert.match(html, /name="email"/);
    assert.match(html, /name="website"/);
    assert.match(html, /name="utm_source" value="blog"/);
    const forms = (await h.call("GET", "/forms")).json;
    assert.match(forms.iframe, /subscribe\?embed=1/);
    assert.match(forms.popup, /data-mode="popup"/);
    const js = await pub("/embed.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
  });
});

describe("polls and surveys", () => {
  test("one vote per subscriber, scanners don't vote, results add up", async () => {
    const a = (await sub("pollera@example.org")).json;
    const b = (await sub("pollerb@example.org")).json;
    const tokenOf = (email: string) => (h.app.db.prepare("SELECT token FROM subscribers WHERE email = ?").get(email) as { token: string }).token;
    const poll = (await h.call("POST", "/polls", { question: "Favourite colour?", options: ["Red", "Blue", "Green"] })).json;
    assert.equal((await h.call("POST", "/polls", { question: "x", options: ["only one"] })).status, 422);

    const vote = (idx: number, email: string, ua = "Mozilla/5.0") => pub(`/poll/${poll.id}/${idx}?s=${tokenOf(email)}`, { headers: { "user-agent": ua } });
    assert.match(await (await vote(1, a.email)).text(), /your vote is in/);
    assert.match(await (await vote(2, a.email)).text(), /already voted/);
    await vote(0, b.email, "Mozilla/5.0 (compatible; Barracuda Sentinel)");
    assert.equal((await h.call("GET", `/polls/${poll.id}`)).json.total_votes, 1, "link scanners can't vote");
    await vote(1, b.email);
    const r = (await h.call("GET", `/polls/${poll.id}`)).json;
    assert.equal(r.total_votes, 2);
    assert.equal(r.options[1].votes, 2);
    assert.match(await (await pub(`/poll/${poll.id}/0?s=bogus`)).text(), /isn't valid/);

    assert.equal((await h.call("PATCH", `/polls/${poll.id}`, { question: "Changed?" })).status, 409, "polls with votes can't be rewritten");
    await h.call("PATCH", `/polls/${poll.id}`, { closed: true });
    assert.match(await (await vote(0, a.email)).text(), /closed|already/);
  });

  test("survey validates answers and tallies them", async () => {
    const s = (await h.call("POST", "/surveys", { title: "Feedback", questions: [
      { id: "likes", type: "multi", label: "What do you like?", options: ["Writing", "Design", "Links"], required: true },
      { id: "score", type: "rating", label: "Rate us" },
      { id: "note", type: "text", label: "Anything else?" },
    ] })).json;
    const tok = (h.app.db.prepare("SELECT token FROM subscribers WHERE email = ?").get("grace@example.org") as { token: string }).token;
    assert.match(await (await pub(`/s/${s.id}?s=${tok}`)).text(), /What do you like/);

    const missing = await form(`/s/${s.id}`, { s: tok, q_score: "4" });
    assert.equal(missing.status, 422);
    const ok = await pub(`/s/${s.id}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `s=${tok}&q_likes=Writing&q_likes=Links&q_score=5&q_note=Great` });
    assert.match(await ok.text(), /Thanks for your answers/);
    assert.match(await (await form(`/s/${s.id}`, { s: tok, q_likes: "Design" })).text(), /already responded/);
    assert.equal((await form(`/s/${s.id}`, { q_likes: "Hacking" })).status, 422);

    const r = (await h.call("GET", `/surveys/${s.id}`)).json;
    assert.equal(r.responses.length, 1);
    assert.deepEqual(r.summary[0].counts, { Writing: 1, Design: 0, Links: 1 });
    assert.equal(r.summary[1].average, 5);
    const csv = await (await fetch(h.base + `/surveys/${s.id}/export.csv`, { headers: { authorization: `Bearer ${h.key}` } })).text();
    assert.match(csv, /Writing; Links/);
    assert.equal((await h.call("PATCH", `/surveys/${s.id}`, { questions: [{ type: "text", label: "x" }] })).status, 409);
  });
});

describe("referrals", () => {
  test("referred subscribers count once confirmed and unlock rewards", async () => {
    await h.call("POST", "/rewards", { name: "Free ebook", threshold: 2, kind: "digital", url: "https://example.com/ebook.pdf" });
    assert.equal((await h.call("POST", "/rewards", { name: "Bad", threshold: 1, kind: "digital" })).status, 422);
    await h.call("POST", "/rewards", { name: "T-shirt", threshold: 3, kind: "physical", description: "We'll email you for your size." });

    const ref = (await sub("referrer@example.org")).json;
    const code = ref.referral.code;
    assert.match(ref.referral.link, new RegExp(`/subscribe\\?ref=${code}`));
    assert.equal((await pub(`/r/${code}`)).headers.get("location"), `${h.base}/subscribe?ref=${code}`);

    for (const n of [1, 2]) await form("/subscribe", { email: `friend${n}@example.org`, ref: code });
    assert.equal((await h.call("GET", "/subscribers/referrer@example.org")).json.referral.confirmed_referrals, 0, "pending friends don't count");

    for (const n of [1, 2]) {
      const confirm = await mailTo(`friend${n}@example.org`, /Confirm your subscription/);
      await pub(new URL(/href="(http[^"]+\/confirm\/[^"]+)"/.exec(bodyOf(confirm.data))![1]).pathname);
    }
    assert.equal((await h.call("GET", "/subscribers/referrer@example.org")).json.referral.confirmed_referrals, 2);
    const reward = await mailTo("referrer@example.org", /You unlocked Free ebook/);
    assert.match(bodyOf(reward.data), /ebook\.pdf/);
    assert.ok(!h.smtp.messages.some((m) => m.to[0] === "referrer@example.org" && /T-shirt/.test(subjectOf(m.data))));

    const claims = (await h.call("GET", "/rewards/claims")).json.data;
    assert.equal(claims.length, 1);
    assert.equal((await h.call("POST", `/rewards/claims/${claims[0].id}/fulfill`)).status, 200);
    const ov = (await h.call("GET", "/referrals")).json;
    assert.equal(ov.leaderboard[0].email, "referrer@example.org");
    assert.equal(ov.leaderboard[0].referrals, 2);
  });
});

describe("automations", () => {
  test("signup -> email -> tag -> branch, with a delay in between", async () => {
    const created = await h.call("POST", "/automations", {
      name: "Welcome series",
      trigger: { type: "signup" },
      steps: [
        { type: "email", subject: "Welcome {{first_name | there}}", blocks: [{ type: "text", props: { markdown: "Glad you're here." } }] },
        { type: "add_tag", tag: "welcomed" },
        { type: "delay", minutes: 60 },
        { type: "condition", rules: { match: "all", conditions: [{ field: "tag", op: "has", value: "vip" }] },
          yes: [{ type: "add_tag", tag: "branch-yes" }], no: [{ type: "add_tag", tag: "branch-no" }] },
        { type: "add_tag", tag: "finished" },
      ],
    });
    assert.equal(created.status, 201);
    assert.equal((await h.call("POST", "/automations", { name: "bad", trigger: { type: "nope" } })).status, 422);
    assert.equal((await h.call("POST", "/automations", { name: "bad", trigger: { type: "signup" }, steps: [{ type: "webhook", url: "ftp://x" }] })).status, 422);
    const id = created.json.id;
    assert.equal((await h.call("POST", `/automations/${id}/activate`)).json.status, "live");

    await sub("autoa@example.org", { fields: { first_name: "Auto" }, send_confirmation: true });
    const conf = await mailTo("autoa@example.org", /Confirm your subscription/);
    await pub(new URL(/href="(http[^"]+\/confirm\/[^"]+)"/.exec(bodyOf(conf.data))![1]).pathname);
    await h.app.queue.tick();

    const welcome = await mailTo("autoa@example.org", /^Welcome Auto$/);
    assert.match(bodyOf(welcome.data), /Glad you're here/);
    assert.match(welcome.data, /List-Unsubscribe:/);
    let tags = (await h.call("GET", "/subscribers/autoa@example.org")).json.tags;
    assert.ok(tags.includes("welcomed"));
    assert.ok(!tags.includes("finished"), "still waiting out the delay");

    // Skip the wait.
    h.app.db.prepare("UPDATE automation_runs SET next_run_at = 0").run();
    await h.app.queue.tick();
    tags = (await h.call("GET", "/subscribers/autoa@example.org")).json.tags;
    assert.ok(tags.includes("branch-no") && !tags.includes("branch-yes"));
    assert.ok(tags.includes("finished"), "continues after the branch");
    const detail = (await h.call("GET", `/automations/${id}`)).json;
    assert.equal(detail.runs.completed, 1);
    assert.equal(detail.stats.emails, 1);

    // The same person doesn't enter twice, and unsubscribing cancels what's running.
    await h.call("PATCH", "/subscribers/autoa@example.org", { tags_add: ["x"] });
    assert.equal((await h.call("GET", `/automations/${id}/runs`)).json.data.length, 1);
  });

  test("tag triggers and custom events start automations; unsubscribing cancels a run", async () => {
    const tagAuto = (await h.call("POST", "/automations", { name: "On vip", trigger: { type: "tag_added", tag: "vip" }, steps: [{ type: "delay", minutes: 1440 }, { type: "add_tag", tag: "vip-followup" }] })).json;
    const evAuto = (await h.call("POST", "/automations", { name: "On purchase", trigger: { type: "custom_event", name: "purchase" }, steps: [{ type: "add_tag", tag: "customer" }] })).json;
    for (const a of [tagAuto, evAuto]) await h.call("POST", `/automations/${a.id}/activate`);

    await sub("autob@example.org");
    await h.call("PATCH", "/subscribers/autob@example.org", { tags_add: ["VIP"] });
    assert.equal((await h.call("GET", `/automations/${tagAuto.id}/runs`)).json.data[0].status, "active");
    await h.call("PATCH", "/subscribers/autob@example.org", { status: "unsubscribed" });
    assert.equal((await h.call("GET", `/automations/${tagAuto.id}/runs`)).json.data[0].status, "canceled");

    await sub("autoc@example.org");
    assert.equal((await h.call("POST", "/events", { email: "nobody@example.org", name: "purchase" })).status, 404);
    assert.equal((await h.call("POST", "/events", { email: "autoc@example.org", name: "purchase", data: { total: 12 } })).status, 201);
    await h.app.queue.tick();
    assert.ok((await h.call("GET", "/subscribers/autoc@example.org")).json.tags.includes("customer"));
  });
});
