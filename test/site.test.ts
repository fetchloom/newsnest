import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { request } from "node:http";
import { harness, verifiedDomain } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;

before(async () => {
  h = await harness();
  await verifiedDomain(h);
  await h.call("PATCH", "/publication", { name: "Site Letter", description: "Notes on things", from_email: "news@example.com", site_url: h.base, brand_color: "#1663fe", footer: "Made with care" });
});
after(() => h.close());

const sub = (email: string, extra: Record<string, unknown> = {}) => h.call("POST", "/subscribers", { email, ...extra });
const pub = (path: string, init: RequestInit = {}) => fetch(h.base + path, { redirect: "manual", ...init });
const subjectOf = (data: string): string => /^Subject: (.*)$/m.exec(data)?.[1] ?? "";
const bodyOf = (data: string): string => [...data.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8")).join("\n");

/** fetch() forbids setting Host, so use node:http to impersonate the publication's own domain. */
function onHost(host: string, path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(h.base);
    const req = request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject).end();
  });
}

async function post(title: string, blocks: unknown[], extra: Record<string, unknown> = {}) {
  const p = (await h.call("POST", "/posts", { title, blocks, ...extra })).json;
  await h.call("POST", `/posts/${p.id}/publish`);
  return p as { id: string; slug: string };
}

describe("website", () => {
  test("archive, post page, SEO tags, feed and sitemap", async () => {
    const p = await post("Hello <World>", [{ type: "heading", props: { text: "Big idea", level: 2 } }, { type: "text", props: { markdown: "Some **bold** words & more." } }], { author: "Ada", seo_description: "A custom description" });
    const archive = await (await pub("/p")).text();
    assert.match(archive, /Hello &lt;World&gt;/, "titles are escaped");
    assert.match(archive, /Site Letter/);
    assert.match(archive, /name="email"/, "archive has a subscribe form");

    const page = await (await pub(`/p/${p.slug}`)).text();
    assert.match(page, /<title>Hello &lt;World&gt; — Site Letter<\/title>/);
    assert.match(page, /<meta name="description" content="A custom description">/);
    assert.match(page, /og:title/);
    assert.match(page, /application\/ld\+json/);
    assert.match(page, /<strong>bold<\/strong>/);
    assert.match(page, /rel="canonical"/);
    assert.ok(!page.includes("Hello <World>"), "no raw HTML from titles");
    assert.match(page, /Ada/);

    const feed = await pub("/p/feed.xml");
    assert.match(feed.headers.get("content-type") ?? "", /rss/);
    assert.match(await feed.text(), /<item><title>Hello &lt;World&gt;<\/title>/);
    assert.match(await (await pub("/p/sitemap.xml")).text(), new RegExp(`/p/${p.slug}`));
    assert.equal((await pub("/p/does-not-exist")).status, 404);
  });

  test("unpublished posts and drafts stay private", async () => {
    const draft = (await h.call("POST", "/posts", { title: "Secret draft", blocks: [{ type: "text", props: { markdown: "x" } }] })).json;
    assert.equal((await pub(`/p/${draft.slug}`)).status, 404);
    assert.ok(!(await (await pub("/p")).text()).includes("Secret draft"));
    const live = await post("Went live", [{ type: "text", props: { markdown: "y" } }]);
    await h.call("POST", `/posts/${live.id}/unpublish`);
    assert.equal((await pub(`/p/${live.slug}`)).status, 404);
  });

  test("custom pages and the nav menu", async () => {
    const pg = await h.call("POST", "/pages", { title: "About us", in_nav: true, blocks: [{ type: "text", props: { markdown: "We write things." } }] });
    assert.equal(pg.status, 201);
    assert.equal(pg.json.slug, "about-us");
    const html = await (await pub("/p/about-us")).text();
    assert.match(html, /We write things/);
    assert.match(await (await pub("/p")).text(), /href="\/p\/about-us"/, "pages marked for the menu appear in the nav");
    const clash = await h.call("POST", "/pages", { title: "About us" });
    assert.equal(clash.json.slug, "about-us-2", "slugs are unique across pages and posts");
    await h.call("PATCH", `/pages/${pg.json.id}`, { published: false });
    assert.equal((await pub("/p/about-us")).status, 404);
  });

  test("the site is served at / on the publication's own domain", async () => {
    const p = await post("Domain post", [{ type: "text", props: { markdown: "on my own domain" } }]);
    await h.call("PATCH", "/publication", { site_domain: "news.example.test" });
    const res = await onHost("news.example.test", `/${p.slug}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /on my own domain/);
    assert.match((await onHost("news.example.test", "/")).text, /Domain post/);
    assert.match((await onHost("news.example.test", "/robots.txt")).text, /Sitemap:/);
    assert.equal((await onHost("news.example.test", "/subscribe")).status, 200, "subscribe still works there");
    assert.equal((await onHost("other.example.test", `/${p.slug}`)).status, 404, "other hostnames don't get the site at /");
    await h.call("PATCH", "/publication", { site_domain: "" });
  });

  test("gated posts show a teaser until the reader signs in with a magic link", async () => {
    await sub("reader@example.org");
    const gated = await post("For subscribers", [
      { type: "text", props: { markdown: "Free teaser paragraph." } },
      { type: "text", props: { markdown: "Second teaser." } },
      { type: "text", props: { markdown: "SECRET MEMBERS CONTENT" } },
    ], { access: "subscribers" });

    const anon = await (await pub(`/p/${gated.slug}`)).text();
    assert.match(anon, /Free teaser paragraph/);
    assert.ok(!anon.includes("SECRET MEMBERS CONTENT"));
    assert.match(anon, /This post is for subscribers/);
    assert.ok(!(await (await pub("/p/feed.xml")).text()).includes("SECRET MEMBERS CONTENT"), "the feed never leaks gated content");

    // Unknown addresses get the same answer and no email.
    const before = h.smtp.messages.length;
    const unknown = await pub("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=stranger%40example.org" });
    assert.match(await unknown.text(), /Check your inbox/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(h.smtp.messages.length, before);

    await pub("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `email=reader%40example.org&redirect=${encodeURIComponent(`/p/${gated.slug}`)}` });
    const mail = await h.waitFor(() => h.smtp.messages.find((m) => m.to[0] === "reader@example.org" && /sign-in link/.test(subjectOf(m.data))), 4000);
    const link = /href="(http[^"]+\/magic\/[A-Za-z0-9_-]+)"/.exec(bodyOf(mail.data))![1];

    const ask = await pub(new URL(link).pathname);
    assert.equal(ask.status, 200);
    assert.match(await ask.text(), /<button[^>]*>Sign in<\/button>/);
    assert.equal(ask.headers.get("set-cookie"), null, "a GET (mail scanner) neither signs in nor uses up the link");
    assert.equal(ask.headers.get("cache-control"), "private, no-store");
    assert.match(ask.headers.get("vary") ?? "", /Cookie/i);
    const magic = await pub(new URL(link).pathname, { method: "POST" });
    assert.equal(magic.status, 302);
    assert.equal(magic.headers.get("location"), `/p/${gated.slug}`);
    const cookie = (magic.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(magic.headers.get("set-cookie") ?? "", /HttpOnly/);
    assert.match(await (await pub(`/p/${gated.slug}`, { headers: { cookie } })).text(), /SECRET MEMBERS CONTENT/);
    assert.equal((await pub(new URL(link).pathname, { method: "POST" })).status, 404, "a magic link works once");
    assert.equal((await pub(new URL(link).pathname)).status, 404);
    assert.ok(!(await (await pub(`/p/${gated.slug}`)).text()).includes("SECRET MEMBERS CONTENT"), "other visitors still see the gate");
  });

  test("open redirects are refused", async () => {
    const seen = h.smtp.messages.length;
    await pub("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=reader%40example.org&redirect=https%3A%2F%2Fevil.example" });
    const mail = await h.waitFor(() => h.smtp.messages.slice(seen).find((m) => m.to[0] === "reader@example.org" && /sign-in link/.test(subjectOf(m.data))), 4000);
    const link = /href="(http[^"]+\/magic\/[A-Za-z0-9_-]+)"/.exec(bodyOf(mail.data))![1];
    assert.equal((await pub(new URL(link).pathname, { method: "POST" })).headers.get("location"), "/");
  });
});

describe("editor extras", () => {
  test("dashboard web preview renders unsaved blocks", async () => {
    const p = await post("Preview me", [{ type: "text", props: { markdown: "saved text" } }]);
    const r = await h.call("POST", `/posts/${p.id}/preview`, { mode: "web", blocks: [{ type: "text", props: { markdown: "unsaved edit" } }] });
    assert.match(r.json.html, /unsaved edit/);
    assert.match(r.json.html, /Preview\. This is how the post looks/);
    assert.match(r.json.html, /noindex/);
  });

  test("test emails go out with a [Test] prefix and no tracking", async () => {
    const p = (await h.call("POST", "/posts", { title: "Testing", blocks: [{ type: "button", props: { label: "Go", url: "https://example.com/x" } }] })).json;
    assert.equal((await h.call("POST", `/posts/${p.id}/test`, { to: ["tester@example.org"] })).json.sent, 1);
    assert.equal((await h.call("POST", `/posts/${p.id}/test`, { to: ["bad"] })).status, 422);
    const mail = await h.waitFor(() => h.smtp.messages.find((m) => m.to[0] === "tester@example.org"), 4000);
    assert.match(subjectOf(mail.data), /\[Test\] Testing/);
    const html = bodyOf(mail.data);
    assert.match(html, /href="https:\/\/example\.com\/x"/);
    assert.ok(!/\/l\/lnk_/.test(html));
  });

  test("templates: built-ins are read-only, custom ones can be saved from a post", async () => {
    const list = (await h.call("GET", "/templates")).json.data;
    assert.ok(list.some((t: { id: string; builtin: boolean }) => t.id === "tpl_newsletter" && t.builtin));
    assert.equal((await h.call("DELETE", "/templates/tpl_newsletter")).status, 409);
    const p = await post("Template source", [{ type: "text", props: { markdown: "reuse me" } }]);
    const t = (await h.call("POST", "/templates", { name: "Mine", from_post: p.id })).json;
    const fromTpl = (await h.call("POST", "/posts", { title: "From template", template_id: t.id })).json;
    assert.equal(fromTpl.blocks[0].props.markdown, "reuse me");
    assert.equal((await h.call("DELETE", `/templates/${t.id}`)).status, 200);
  });

  test("uploads accept real images only and are served with the right type", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const ok = await h.call("POST", "/uploads", { filename: "dot.png", data: png.toString("base64") });
    assert.equal(ok.status, 201);
    assert.match(ok.json.url, /^\/uploads\/img_[A-Za-z0-9_-]+\.png$/);
    const res = await pub(ok.json.url);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(Buffer.from(await res.arrayBuffer()).length, png.length);
    const svg = await h.call("POST", "/uploads", { filename: "x.png", data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64") });
    assert.equal(svg.status, 422);
    assert.equal((await h.call("POST", "/uploads", { data: Buffer.from("<html>").toString("base64") })).status, 422);
    assert.equal((await pub("/uploads/..%2F..%2Fetc%2Fpasswd")).status, 404);
    assert.equal((await pub("/uploads/nothere.png")).status, 404);
  });
});

describe("A/B tests", () => {
  test("the test group is split between variants and the winner gets the rest", async () => {
    for (let i = 1; i <= 10; i++) await sub(`ab${i}@example.org`, { tags: ["abtest"] });
    const p = (await h.call("POST", "/posts", {
      title: "AB base", subject: "Variant A subject", audience: "tag:abtest",
      blocks: [{ type: "text", props: { markdown: "body" } }],
      ab: { enabled: true, test_percent: 40, metric: "opens", wait_minutes: 15, variants: [{ subject: "Variant A subject" }, { subject: "Variant B subject" }] },
    })).json;
    assert.equal((await h.call("PATCH", `/posts/${p.id}`, { ab: { enabled: true, variants: [{ subject: "only one" }] } })).status, 422);

    h.smtp.messages.length = 0;
    await h.call("POST", `/posts/${p.id}/schedule`, {});
    await h.waitFor(() => (h.app.db.prepare("SELECT ab_state FROM posts WHERE id = ?").get(p.id) as { ab_state: string }).ab_state.includes("testing"), 5000);
    const state = JSON.parse((h.app.db.prepare("SELECT ab_state, recipients FROM posts WHERE id = ?").get(p.id) as { ab_state: string }).ab_state);
    assert.equal(state.phase, "testing");
    assert.equal(state.counts.A + state.counts.B, 4, "40% of 10 subscribers");
    assert.ok(Math.abs(state.counts.A - state.counts.B) <= 1);

    await h.waitFor(() => h.smtp.messages.length >= 4, 6000);
    const subjects = h.smtp.messages.map((m) => subjectOf(m.data));
    assert.ok(subjects.includes("Variant A subject") && subjects.includes("Variant B subject"));
    assert.equal((h.app.db.prepare("SELECT status FROM posts WHERE id = ?").get(p.id) as { status: string }).status, "sending", "waits for the winner before finishing");

    // Make variant B open its mail, then fast-forward the wait.
    const bEmails = h.app.db.prepare("SELECT id FROM emails WHERE post_id = ? AND variant = 'B'").all(p.id) as { id: string }[];
    await h.waitFor(() => (h.app.db.prepare("SELECT COUNT(*) AS n FROM deliveries d JOIN emails e ON e.id = d.email_id WHERE e.post_id = ? AND d.status = 'sent'").get(p.id) as { n: number }).n === 4, 6000);
    for (const e of bEmails) await fetch(`${h.base}/o/${e.id}.gif`);
    h.app.db.prepare("UPDATE posts SET ab_state = json_set(ab_state, '$.winner_at', 0) WHERE id = ?").run(p.id);
    await h.app.queue.tick();

    await h.waitFor(() => h.smtp.messages.length >= 10, 8000);
    const final = JSON.parse((h.app.db.prepare("SELECT ab_state FROM posts WHERE id = ?").get(p.id) as { ab_state: string }).ab_state);
    assert.equal(final.phase, "done");
    assert.equal(final.winner, "B");
    assert.equal(final.remainder, 6);
    const variants = h.app.db.prepare("SELECT variant, COUNT(*) AS n FROM emails WHERE post_id = ? GROUP BY variant").all(p.id) as { variant: string; n: number }[];
    assert.equal(variants.find((v) => v.variant === "B")!.n, state.counts.B + 6);
    await h.waitFor(() => (h.app.db.prepare("SELECT status FROM posts WHERE id = ?").get(p.id) as { status: string }).status === "sent", 6000);

    const stats = (await h.call("GET", `/posts/${p.id}/stats`)).json;
    assert.equal(stats.variants.length, 2);
    assert.equal(stats.variants.find((v: { variant: string }) => v.variant === "B").open_rate > 0, true);
  });
});

describe("analytics, bounces, webhooks", () => {
  test("audience analytics add up", async () => {
    const a = (await h.call("GET", "/analytics/audience?days=14")).json;
    assert.equal(a.growth.length, 14);
    assert.ok(a.totals.active >= 10);
    assert.ok(a.recent_posts.length >= 1);
    assert.ok(Array.isArray(a.engagement));
    const csv = await (await fetch(h.base + "/analytics/posts.csv", { headers: { authorization: `Bearer ${h.key}` } })).text();
    assert.match(csv, /^title,status,sent_at/);
  });

  test("a hard bounce takes the subscriber off the list", async () => {
    await sub("bouncer@example.org");
    h.smtp.rejectRcpt = { match: /bouncer@example\.org/, code: 550, text: "5.1.1 no such user" };
    const p = (await h.call("POST", "/posts", { title: "To bouncer", audience: "tag:bounce-me", blocks: [{ type: "text", props: { markdown: "hi" } }] })).json;
    await h.call("PATCH", "/subscribers/bouncer@example.org", { tags_add: ["bounce-me"] });
    await h.call("POST", `/posts/${p.id}/schedule`, {});
    await h.waitFor(() => (h.app.db.prepare("SELECT status FROM subscribers WHERE email = 'bouncer@example.org'").get() as { status: string }).status === "bounced", 6000);
    h.smtp.rejectRcpt = null;
    assert.equal((await h.call("GET", "/subscribers?status=bounced")).json.total, 1);
  });

  test("opens and clicks reach webhooks", async () => {
    const hook = await h.call("POST", "/webhooks", { url: "https://hooks.test/in", events: ["email.opened", "email.clicked"] });
    assert.equal(hook.status, 201);
    await sub("hooked@example.org", { tags: ["hooked"] });
    const p = (await h.call("POST", "/posts", { title: "Hook me", audience: "tag:hooked", blocks: [{ type: "button", props: { label: "Go", url: "https://example.com/hooked" } }] })).json;
    await h.call("POST", `/posts/${p.id}/schedule`, {});
    const mail = await h.waitFor(() => h.smtp.messages.find((m) => m.to[0] === "hooked@example.org" && /Hook me/.test(subjectOf(m.data))), 6000);
    const html = bodyOf(mail.data);
    await fetch(/src="([^"]*\/o\/em_[^"]+\.gif)"/.exec(html)![1]);
    await h.waitFor(() => h.webhookCalls.some((c) => JSON.parse(c.body).type === "email.opened"), 5000);
    const call = h.webhookCalls.find((c) => JSON.parse(c.body).type === "email.opened")!;
    assert.deepEqual(JSON.parse(call.body).data.to, ["hooked@example.org"]);
  });

  test("newsletter mail is paced but API mail isn't", async () => {
    const slow = await harness({ sendRatePerSec: 2 });
    try {
      await verifiedDomain(slow);
      await slow.call("PATCH", "/publication", { from_email: "news@example.com", site_url: slow.base });
      for (let i = 0; i < 6; i++) await slow.call("POST", "/subscribers", { email: `p${i}@example.org` });
      const p = (await slow.call("POST", "/posts", { title: "Paced", blocks: [{ type: "text", props: { markdown: "x" } }] })).json;
      const t0 = Date.now();
      await slow.call("POST", `/posts/${p.id}/schedule`, {});
      await slow.waitFor(() => slow.smtp.messages.length >= 1, 4000);
      const api = await slow.call("POST", "/emails", { from: "a@example.com", to: "api@dest.test", subject: "Transactional", text: "now" });
      assert.equal(api.status, 201);
      await slow.waitFor(() => slow.smtp.messages.some((m) => m.to[0] === "api@dest.test"), 2000);
      assert.ok(slow.smtp.messages.length < 6, "API mail overtakes the queued newsletter");
      await slow.waitFor(() => slow.smtp.messages.length >= 7, 9000);
      assert.ok(Date.now() - t0 >= 1500, "6 emails at 2/second take at least ~2 seconds");
    } finally { await slow.close(); }
  });
});
