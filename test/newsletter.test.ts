import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dkimVerify } from "../src/server/mime.ts";
import { harness, verifiedDomain } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
let publicKey: string;

before(async () => {
  h = await harness();
  ({ publicKey } = await verifiedDomain(h));
  const r = await h.call("PATCH", "/publication", { name: "The Test Letter", from_name: "Ada", from_email: "news@example.com", site_url: h.base, address: "1 Test Street, Testville", referral_enabled: true });
  assert.equal(r.status, 200);
});
after(() => h.close());

const sub = (email: string, extra: Record<string, unknown> = {}) => h.call("POST", "/subscribers", { email, ...extra });
const pub = (path: string, init: RequestInit = {}) => fetch(h.base + path, { redirect: "manual", ...init });
const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  pub(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
const tick = async () => { await h.app.queue.tick(); };
const waitMail = (pred: (m: { to: string[]; data: string }) => boolean, ms = 4000) => h.waitFor(() => h.smtp.messages.find(pred), ms);
const subjectOf = (data: string): string => /^Subject: (.*)$/m.exec(data)?.[1] ?? "";
const decodeBody = (data: string): string => {
  const out: string[] = [];
  for (const m of data.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)) out.push(Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8"));
  return out.join("\n");
};
const linksIn = (html: string): string[] => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

describe("subscribers", () => {
  test("create, de-duplicate, validate", async () => {
    const a = await sub("Ada@Example.org", { fields: { first_name: "Ada" }, tags: ["VIP"] });
    assert.equal(a.status, 201);
    assert.equal(a.json.email, "ada@example.org");
    assert.deepEqual(a.json.tags, ["vip"]);
    assert.equal(a.json.status, "active");
    assert.equal((await sub("ada@example.org")).status, 200, "same address is not created twice");
    assert.equal((await sub("not-an-email")).status, 422);
    assert.equal((await sub("x@y.org", { fields: { "Bad Key": "x" } })).status, 422);
  });

  test("list, search, filter, update, delete", async () => {
    await sub("bob@example.org", { fields: { first_name: "Bob", plan: "pro" }, tags: ["beta"] });
    const all = await h.call("GET", "/subscribers?limit=1");
    assert.equal(all.json.data.length, 1);
    assert.equal(all.json.has_more, true);
    assert.ok(all.json.total >= 2);
    assert.equal((await h.call("GET", "/subscribers?tag=beta")).json.data[0].email, "bob@example.org");
    assert.equal((await h.call("GET", "/subscribers?q=Bob")).json.total, 1);
    const upd = await h.call("PATCH", "/subscribers/bob@example.org", { fields: { city: "Paris" }, tags_add: ["early"], tags_remove: ["beta"] });
    assert.equal(upd.json.fields.city, "Paris");
    assert.deepEqual(upd.json.tags, ["early"]);
    assert.equal((await h.call("DELETE", "/subscribers/bob@example.org")).status, 200);
    assert.equal((await h.call("GET", "/subscribers/bob@example.org")).status, 404);
  });

  test("CSV import handles quotes, tags, custom fields and bad rows", async () => {
    const csv = 'Email,First Name,Tags,Company\r\ncarol@example.org,"Carol, Jr.",news;vip,"Acme ""Co"""\r\nnot-valid,Nobody,,\r\ndave@example.org,Dave,,\r\n';
    const r = await h.call("POST", "/subscribers/import", { csv, tags: ["imported"] });
    assert.equal(r.json.created, 2);
    assert.equal(r.json.skipped, 1);
    assert.equal(r.json.invalid[0].row, 3);
    const carol = (await h.call("GET", "/subscribers/carol@example.org")).json;
    assert.equal(carol.fields.first_name, "Carol, Jr.");
    assert.equal(carol.fields.company, 'Acme "Co"');
    assert.deepEqual(carol.tags, ["imported", "news", "vip"]);
    const again = await h.call("POST", "/subscribers/import", { csv, update_existing: true });
    assert.equal(again.json.created, 0);
    assert.equal(again.json.updated, 2);
  });

  test("CSV export neutralises spreadsheet formulas", async () => {
    await sub("eve@example.org", { fields: { first_name: "=HYPERLINK(\"http://evil\")" } });
    const res = await fetch(h.base + "/subscribers/export.csv", { headers: { authorization: `Bearer ${h.key}` } });
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
    const body = await res.text();
    assert.ok(body.split("\r\n")[0].startsWith("email,status"));
    assert.ok(body.includes("'=HYPERLINK"), "cells starting with = must be prefixed");
    assert.ok(!/(^|,)=HYPERLINK/.test(body));
  });
});

describe("segments", () => {
  test("rules combine with all/any and nest", async () => {
    await sub("seg1@example.org", { tags: ["a"], fields: { plan: "pro" } });
    await sub("seg2@example.org", { tags: ["b"], fields: { plan: "free" } });
    await sub("seg3@example.org", { tags: ["a", "b"], fields: { plan: "free" } });
    const count = async (rules: unknown) => (await h.call("POST", "/segments/preview", { rules })).json.active_subscribers;
    assert.equal(await count({ match: "all", conditions: [{ field: "tag", op: "has", value: "a" }, { field: "tag", op: "has", value: "b" }] }), 1);
    assert.equal(await count({ match: "any", conditions: [{ field: "tag", op: "has", value: "a" }, { field: "tag", op: "has", value: "b" }] }), 3);
    assert.equal(await count({ match: "all", conditions: [{ field: "field:plan", op: "is", value: "free" }, { match: "any", conditions: [{ field: "tag", op: "has", value: "a" }, { field: "email", op: "starts_with", value: "seg2" }] }] }), 2);
    assert.equal(await count({ match: "all", conditions: [{ field: "tag", op: "not_has", value: "a" }, { field: "email", op: "contains", value: "seg" }] }), 1);
    assert.equal(await count({ match: "all", conditions: [{ field: "engagement", op: "is", value: "new" }, { field: "email", op: "contains", value: "seg" }] }), 3);
  });

  test("bad rules and injection attempts are refused", async () => {
    const bad = (rules: unknown) => h.call("POST", "/segments/preview", { rules });
    assert.equal((await bad({ match: "all", conditions: [{ field: "nope", op: "is", value: "x" }] })).status, 422);
    assert.equal((await bad({ match: "all", conditions: [{ field: "tag", op: "drop", value: "x" }] })).status, 422);
    assert.equal((await bad({ match: "all", conditions: [{ field: "field:x'); DROP TABLE subscribers;--", op: "is", value: "x" }] })).status, 422);
    const evil = await bad({ match: "all", conditions: [{ field: "email", op: "is", value: "' OR 1=1 --" }] });
    assert.equal(evil.json.active_subscribers, 0);
    assert.ok((await h.call("GET", "/subscribers")).json.total > 0, "table still intact");
  });

  test("dynamic segments follow the data; static ones are snapshots", async () => {
    const dyn = await h.call("POST", "/segments", { name: "Tagged a", rules: { match: "all", conditions: [{ field: "tag", op: "has", value: "a" }] } });
    assert.equal(dyn.status, 201);
    const before = dyn.json.active_subscribers;
    const snap = await h.call("POST", `/segments/${dyn.json.id}/snapshot`);
    await sub("seg4@example.org", { tags: ["a"] });
    assert.equal((await h.call("GET", `/segments/${dyn.json.id}`)).json.active_subscribers, before + 1);
    assert.equal((await h.call("GET", `/segments/${snap.json.id}`)).json.active_subscribers, before);
    assert.equal((await h.call("GET", `/subscribers?segment=${dyn.json.id}`)).json.total, before + 1);
  });
});

describe("posts and broadcasts", () => {
  let postId = "";
  let slug = "";

  test("blocks are validated and previews merge variables safely", async () => {
    const created = await h.call("POST", "/posts", { title: "Issue #1", template_id: "tpl_newsletter", preview_text: "Hello preview" });
    assert.equal(created.status, 201);
    postId = created.json.id; slug = created.json.slug;
    assert.ok(created.json.blocks.length > 3);

    assert.equal((await h.call("PATCH", `/posts/${postId}`, { blocks: [{ type: "evil", props: {} }] })).status, 422);
    assert.equal((await h.call("PATCH", `/posts/${postId}`, { blocks: [{ type: "button", props: { label: "x", url: "javascript:alert(1)" } }] })).status, 422);
    assert.equal((await h.call("PATCH", `/posts/${postId}`, { audience: "segment:seg_missing" })).status, 422);

    const upd = await h.call("PATCH", `/posts/${postId}`, {
      subject: "Hey {{first_name | friend}}, issue one",
      blocks: [
        { id: "t1", type: "text", props: { markdown: "Hi {{first_name | there}}, read [the story](https://example.com/story?a=1&b=2).\n\n<script>alert(1)</script>" } },
        { id: "b1", type: "button", props: { label: "Go", url: "https://example.com/go", align: "left" } },
        { id: "d1", type: "dynamic", props: { rules: { match: "all", conditions: [{ field: "tag", op: "has", value: "vip" }] }, blocks: [{ id: "d1t", type: "text", props: { markdown: "VIP-only note" } }] } },
      ],
    });
    assert.equal(upd.status, 200);

    const pre = await h.call("POST", `/posts/${postId}/preview`, { subscriber: "ada@example.org" });
    assert.match(pre.json.html, /Hi Ada,/);
    assert.match(pre.json.html, /VIP-only note/, "ada is tagged vip");
    assert.ok(!pre.json.html.includes("<script>alert(1)</script>"), "script text must be escaped");
    assert.match(pre.json.html, /Unsubscribe/);
    assert.match(pre.json.text, /Hi Ada,/);
    const anon = await h.call("POST", `/posts/${postId}/preview`, {});
    assert.match(anon.json.html, /Hi there,/);
    assert.equal(pre.json.subject, "Hey Ada, issue one");
  });

  test("sending reaches active subscribers only, personalised, signed and trackable", async () => {
    await sub("ghost@example.org", { send_confirmation: true });            // pending: must not receive
    await h.call("PATCH", "/subscribers/seg2@example.org", { status: "unsubscribed" });
    h.smtp.messages.length = 0;

    const sched = await h.call("POST", `/posts/${postId}/schedule`, {});
    assert.equal(sched.status, 200);
    assert.equal(sched.json.status, "scheduled");
    await h.waitFor(() => h.app.db.prepare("SELECT status FROM posts WHERE id = ? AND status IN ('sending','sent')").get(postId));
    const active = (h.app.db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'active'").get() as { n: number }).n;
    await h.waitFor(() => h.smtp.messages.filter((m) => /issue one/.test(subjectOf(m.data))).length >= active, 8000);

    const mails = h.smtp.messages.filter((m) => /issue one/.test(subjectOf(m.data)));
    const recipients = mails.map((m) => m.to[0]);
    assert.ok(!recipients.includes("ghost@example.org"), "pending subscribers are skipped");
    assert.ok(!recipients.includes("seg2@example.org"), "unsubscribed subscribers are skipped");

    const ada = mails.find((m) => m.to[0] === "ada@example.org")!;
    assert.match(ada.data, /^DKIM-Signature: /);
    assert.ok(dkimVerify(ada.data, publicKey));
    assert.match(subjectOf(ada.data), /Hey Ada, issue one/);
    assert.match(ada.data, /List-Unsubscribe: <http[^>]+\/u\/[A-Za-z0-9_-]+\?p=post_/);
    assert.match(ada.data, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
    const html = decodeBody(ada.data);
    assert.match(html, /VIP-only note/);
    assert.match(html, /\/o\/em_[A-Za-z0-9_-]+\.gif/, "open pixel");
    assert.ok(linksIn(html).some((l) => /\/l\/lnk_[A-Za-z0-9_-]+\/em_/.test(l)), "tracked links");
    const noVip = mails.find((m) => m.to[0] === "dave@example.org")!;
    assert.ok(!decodeBody(noVip.data).includes("VIP-only note"), "dynamic block hidden from non-matching subscribers");
    assert.match(decodeBody(noVip.data), /Hi Dave,|Hi there,/);

    await h.waitFor(() => (h.app.db.prepare("SELECT status FROM posts WHERE id = ?").get(postId) as { status: string }).status === "sent", 6000);
    const post = await h.call("GET", `/posts/${postId}`);
    assert.equal(post.json.recipients, active);
    assert.ok(post.json.published_at, "a sent post goes live on the website");
    assert.equal((await h.call("PATCH", `/posts/${postId}`, { title: "Changed" })).status, 200, "web fields stay editable after sending");
  });

  test("opens and clicks are recorded; scanners are not counted as verified clicks", async () => {
    const mails = h.smtp.messages.filter((m) => /issue one/.test(subjectOf(m.data)));
    const ada = decodeBody(mails.find((m) => m.to[0] === "ada@example.org")!.data);
    const pixel = /src="([^"]*\/o\/em_[^"]+\.gif)"/.exec(ada)![1];
    const res = await fetch(pixel, { headers: { "user-agent": "Mozilla/5.0 (iPhone)" } });
    assert.equal(res.headers.get("content-type"), "image/gif");
    const link = linksIn(ada).find((l) => /\/l\/lnk_/.test(l))!;
    await new Promise((r) => setTimeout(r, 3200)); // real people don't click within 3 seconds of delivery
    const click = await fetch(link, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (iPhone)" } });
    assert.equal(click.status, 302);
    assert.match(click.headers.get("location")!, /^https:\/\/example\.com\/(story|go)/);
    assert.match(click.headers.get("location")!, /utm_source=newsletter/);

    const dave = decodeBody(mails.find((m) => m.to[0] === "dave@example.org")!.data);
    const daveLink = linksIn(dave).find((l) => /\/l\/lnk_/.test(l))!;
    await fetch(daveLink, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (compatible; Barracuda Sentinel)" } });

    const stats = (await h.call("GET", `/posts/${postId}/stats`)).json;
    assert.ok(stats.opens.unique >= 1);
    assert.equal(stats.clicks.unique, 2);
    assert.equal(stats.clicks.verified_unique, 1, "the scanner click is not verified");
    assert.ok(stats.top_links.length >= 1);
    const adaRow = (await h.call("GET", "/subscribers/ada@example.org")).json;
    assert.equal(adaRow.stats.opens, 1);
    assert.equal(adaRow.stats.clicks, 1);
    assert.equal(adaRow.engagement, "new");

    assert.equal((await fetch(h.base + "/l/lnk_unknown/em_x", { redirect: "manual" })).status, 302, "unknown links never redirect to arbitrary URLs");
  });

  test("unsubscribe: GET only asks, one-click POST does it", async () => {
    const mails = h.smtp.messages.filter((m) => /issue one/.test(subjectOf(m.data)));
    const unsub = /(https?:\/\/[^>\s]+\/u\/[A-Za-z0-9_-]+)\?p=(post_[A-Za-z0-9_-]+)/.exec(mails.find((m) => m.to[0] === "dave@example.org")!.data)!;
    const get = await pub(new URL(unsub[0]).pathname + "?p=" + unsub[2]);
    assert.equal(get.status, 200);
    assert.equal((await h.call("GET", "/subscribers/dave@example.org")).json.status, "active", "a link scanner's GET must not unsubscribe");
    const post = await form(new URL(unsub[0]).pathname + "?p=" + unsub[2], { "List-Unsubscribe": "One-Click" });
    assert.equal(post.status, 200);
    assert.equal((await h.call("GET", "/subscribers/dave@example.org")).json.status, "unsubscribed");
    assert.equal((await h.call("GET", `/posts/${postId}/stats`)).json.unsubscribes.total, 1);
    const back = await form(new URL(unsub[0]).pathname, { action: "resubscribe" });
    assert.equal(back.status, 200);
    assert.equal((await h.call("GET", "/subscribers/dave@example.org")).json.status, "active");
  });

  test("sending isn't possible without a sender address or with nothing to send", async () => {
    const empty = await h.call("POST", "/posts", { title: "Empty" });
    assert.equal((await h.call("POST", `/posts/${empty.json.id}/schedule`, {})).json.name, "empty_post");
    const p2 = await h.call("POST", "/posts", { title: "Nobody", template_id: "tpl_announcement", audience: "tag:nobody-has-this" });
    const s = await h.call("POST", `/posts/${p2.json.id}/schedule`, {});
    assert.equal(s.status, 200);
    await h.waitFor(() => h.app.db.prepare("SELECT 1 FROM posts WHERE id = ? AND status = 'draft'").get(p2.json.id), 4000);
    const back = await h.call("GET", `/posts/${p2.json.id}`);
    assert.match(back.json.ab_state.error, /No active subscribers/);
  });

  test("a scheduled post waits for its time", async () => {
    await h.call("POST", "/segments", { name: "x", rules: { match: "all", conditions: [] } });
    const p = await h.call("POST", "/posts", { title: "Later one", template_id: "tpl_announcement", audience: "tag:vip" });
    const when = new Date(Date.now() + 3600_000).toISOString();
    const s = await h.call("POST", `/posts/${p.json.id}/schedule`, { send_at: when });
    assert.equal(s.json.status, "scheduled");
    await tick();
    assert.equal((await h.call("GET", `/posts/${p.json.id}`)).json.status, "scheduled");
    assert.equal((await h.call("POST", `/posts/${p.json.id}/unschedule`)).json.status, "draft");
  });
});

describe("hardening", () => {
  test("merge-tag URLs can't smuggle a scheme, and markdown links are filtered", async () => {
    const p = (await h.call("POST", "/posts", { title: "Links" })).json;
    const bad = await h.call("PATCH", `/posts/${p.id}`, { blocks: [{ type: "button", props: { label: "x", url: "{{first_name}}javascript:alert(1)" } }] });
    assert.equal(bad.status, 422);
    const good = await h.call("PATCH", `/posts/${p.id}`, { blocks: [{ type: "button", props: { label: "Share", url: "{{referral_link}}" } }, { type: "text", props: { markdown: "[x]({{a}}javascript:alert(1)) and [y](javascript:alert(2))" } }] });
    assert.equal(good.status, 200);
    const html = (await h.call("POST", `/posts/${p.id}/preview`, {})).json.html as string;
    assert.ok(!/href="\s*javascript:/i.test(html), "no javascript: link survives rendering");
    assert.ok(!/href="[^"]*\{\{/.test(html), "unresolved merge tags never end up in a link");
  });

  test("the Email API list hides newsletter mail by default", async () => {
    await h.call("POST", "/emails", { from: "a@example.com", to: "api-list@dest.test", subject: "From the API", text: "x" });
    const apiOnly = (await h.call("GET", "/emails?limit=100")).json.data;
    assert.ok(apiOnly.every((e: { kind: string }) => e.kind === "api"));
    assert.ok(apiOnly.some((e: { subject: string }) => e.subject === "From the API"));
    const all = (await h.call("GET", "/emails?kind=all&limit=100")).json.data;
    assert.ok(all.some((e: { kind: string }) => e.kind === "broadcast"));
    assert.equal((await h.call("GET", "/emails?kind=bogus")).status, 422);
    const issue = all.find((e: { kind: string }) => e.kind === "broadcast");
    const detail = (await h.call("GET", `/emails/${issue.id}`)).json;
    assert.match(detail.html, /Unsubscribe/, "a newsletter email's content is rebuilt for the detail view");
  });
});
