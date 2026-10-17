import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { attemptGate, loginThrottle } from "../src/server/auth.ts";
import { createApp } from "../src/server/app.ts";
import { merge } from "../src/server/newsletter/render.ts";
import { loadConfig } from "../src/server/config.ts";
import { harness } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
before(async () => { h = await harness(); });
after(() => h.close());

/** Sends raw bytes and returns whatever the server answers before it closes the connection. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(request));
    let out = "";
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => { out += d; });
    sock.on("end", () => resolve(out));
    sock.on("error", reject);
  });
}
const port = (): number => Number(new URL(h.base).port);

describe("request targets", () => {
  for (const target of ["//a:b/x", "/\\a:b/x", "http://evil.test/x", "//evil.test/x"]) {
    test(`${JSON.stringify(target)} is a 400 and the server keeps running`, async () => {
      const res = await raw(port(), `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      assert.match(res, /^HTTP\/1\.1 400 /);
      assert.equal((await fetch(h.base + "/health")).status, 200);
    });
  }
});

describe("startup configuration", () => {
  const load = (env: Record<string, string>) => loadConfig(env);

  test("a short NEWSNEST_ADMIN_PASSWORD is a startup error", () => {
    assert.throws(() => load({ NEWSNEST_ADMIN_PASSWORD: "short" }), /at least 10 characters/);
    assert.equal(load({ NEWSNEST_ADMIN_PASSWORD: "" }).adminPassword, null, "empty means unset");
    assert.equal(load({ NEWSNEST_ADMIN_PASSWORD: "long enough password" }).adminPassword, "long enough password");
  });

  test("numeric settings must be finite and positive", () => {
    for (const [name, bad] of [["NEWSNEST_RATE_LIMIT", "abc"], ["NEWSNEST_SEND_RATE", "0"], ["NEWSNEST_RATE_LIMIT", "-1"], ["NEWSNEST_SEND_RATE", "Infinity"], ["PORT", "80.5"], ["PORT", "NaN"], ["NEWSNEST_PUBLIC_MAIL_PER_HOUR", "-5"]]) {
      assert.throws(() => load({ [name]: bad }), new RegExp(`${name} must be a positive`), `${name}=${bad}`);
    }
    assert.throws(() => load({ PORT: "70000" }), /PORT must be between/);
    assert.equal(load({ PORT: "9000", NEWSNEST_RATE_LIMIT: "2.5" }).rateLimitPerSec, 2.5);
  });

  test("a bad relay URL fails without echoing it", () => {
    for (const url of ["not a url hunter2", "http://user:hunter2@example.com"]) {
      assert.throws(() => load({ NEWSNEST_MODE: "relay", NEWSNEST_RELAY_URL: url }), (e: Error) => !e.message.includes("hunter2"));
    }
    assert.throws(() => load({ NEWSNEST_MODE: "relay", NEWSNEST_RELAY_URL: "not a url hunter2" }), new Error("NEWSNEST_RELAY_URL is not a valid URL"));
  });
});

describe("login throttle internals", () => {
  test("the failure table is bounded, dropping the oldest client first", () => {
    const t = loginThrottle(3);
    for (const k of ["a", "b", "c"]) for (let i = 0; i < 10; i++) t.fail(k);
    assert.equal(t.blocked("a"), true);
    for (let i = 0; i < 10; i++) t.fail("d"); // a is evicted
    assert.equal(t.blocked("a"), false);
    assert.equal(t.blocked("b"), true);
    assert.equal(t.blocked("d"), true);
  });

  test("password checks run one at a time and too many waiting are refused", async () => {
    const gate = attemptGate();
    let running = 0;
    let peak = 0;
    const slow = () => { running++; peak = Math.max(peak, running); running--; return true; };
    const all = await Promise.all(Array.from({ length: 10 }, () => gate(slow)));
    assert.equal(peak, 1);
    assert.ok(all.every(Boolean));
    const flood = Array.from({ length: 40 }, () => gate(() => true).then(() => "ok", (e) => e.status));
    const results = await Promise.all(flood);
    assert.ok(results.includes(429), "the queue has a limit");
    assert.ok(results.includes("ok"));
  });
});

describe("response headers", () => {
  test("every response is nosniff with a referrer policy and no framing, and plain HTTP gets no HSTS", async () => {
    for (const path of ["/health", "/login", "/nowhere"]) {
      const res = await fetch(h.base + path);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
      assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
      assert.equal(res.headers.get("x-frame-options"), "DENY", path);
      assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, path);
      assert.equal(res.headers.get("strict-transport-security"), null, path);
    }
  });

  test("public pages get the locked-down CSP", async () => {
    for (const path of ["/login", "/subscribe", "/confirm/abc", "/poll/x", "/s/x", "/u/x", "/magic/x"]) {
      const csp = (await fetch(h.base + path)).headers.get("content-security-policy") ?? "";
      assert.match(csp, /default-src 'none'; img-src \* data:; style-src 'unsafe-inline'; form-action \*; base-uri 'none'/, path);
    }
  });

  test("only the embedded subscribe form (and its answer) may be framed; the website only by the dashboard", async () => {
    const embedded = await fetch(h.base + "/subscribe?embed=1");
    assert.equal(embedded.headers.get("x-frame-options"), null);
    assert.ok(!/frame-ancestors/.test(embedded.headers.get("content-security-policy") ?? ""));
    const posted = await fetch(h.base + "/subscribe", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "website=x" });
    assert.equal(posted.headers.get("x-frame-options"), null, "the page a framed form submits to must also be frameable");
    assert.equal((await fetch(h.base + "/subscribe")).headers.get("x-frame-options"), "DENY", "the standalone page isn't");
    const site = await fetch(h.base + "/p");
    assert.equal(site.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(site.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
  });

  test("HSTS appears when the public URL is https", async () => {
    const hs = await harness({ publicUrl: "https://news.example.com" });
    try {
      assert.equal((await fetch(hs.base + "/health")).headers.get("strict-transport-security"), "max-age=31536000");
    } finally { await hs.close(); }
  });
});

describe("the real static site and dashboard", () => {
  let site: ReturnType<typeof createApp>;
  let base = "";
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "newsnest-static-"));
    site = createApp(loadConfig({}, { dataDir: dir, mode: "outbox" }));
    await new Promise<void>((r) => site.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(site.server.address() as net.AddressInfo).port}`;
  });
  after(() => site.close());

  test("the dashboard gets a CSP that matches how it is built, and the landing page none", async () => {
    const app = await fetch(base + "/app/");
    assert.equal(app.status, 200);
    assert.equal(app.headers.get("content-security-policy"), "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const html = await app.text();
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "the dashboard page has no inline script");
    assert.ok(!/ on\w+=/i.test(html), "and no inline event handlers");
    const landing = await fetch(base + "/");
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get("content-security-policy"), "frame-ancestors 'none'");
    assert.equal((await fetch(base + "/styles.css")).status, 200);
    assert.equal((await fetch(base + "/js/app/main.js")).status, 200);
  });

  test("compiled client files are cached by modification time", async () => {
    const a = await (await fetch(base + "/js/app/auth.js")).text();
    const b = await (await fetch(base + "/js/app/auth.js")).text();
    assert.equal(a, b);
    assert.match(a, /Setup code/);
  });
});

describe("cookies", () => {
  const login = (hh: Harness, headers: Record<string, string> = {}) =>
    fetch(hh.base + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-newsnest": "1", ...headers }, body: JSON.stringify({ password: "a long password" }) });
  const secure = async (overrides: Parameters<typeof harness>[0], headers: Record<string, string> = {}) => {
    const hh = await harness({ adminPassword: "a long password", ...overrides });
    try { return /;\s*Secure/i.test((await login(hh, headers)).headers.get("set-cookie") ?? ""); } finally { await hh.close(); }
  };

  test("Secure follows the effective base URL, or a proxy we trust saying https", async () => {
    assert.equal(await secure({}), false);
    assert.equal(await secure({ publicUrl: "https://news.example.com" }), true);
    assert.equal(await secure({ trustProxy: true }, { "x-forwarded-proto": "https" }), true);
    assert.equal(await secure({ trustProxy: true }, { "x-forwarded-proto": "http" }), false);
    assert.equal(await secure({}, { "x-forwarded-proto": "https" }), false, "a client-supplied header means nothing without a trusted proxy");
  });
});

describe("reader-specific pages are never shared-cached", () => {
  test("gated posts and signed-in readers get private, no-store; every post page varies by cookie", async () => {
    const hs = await harness();
    try {
      await hs.call("PATCH", "/publication", { name: "Cache Letter", from_email: "news@example.com", site_url: hs.base });
      const mk = async (title: string, access: string) => {
        const p = (await hs.call("POST", "/posts", { title, blocks: [{ type: "text", props: { markdown: "body" } }], access })).json;
        await hs.call("POST", `/posts/${p.id}/publish`);
        return p.slug as string;
      };
      const open = await fetch(hs.base + `/p/${await mk("Open post", "public")}`);
      assert.equal(open.headers.get("cache-control"), "no-cache");
      assert.match(open.headers.get("vary") ?? "", /Cookie/i);
      const gated = await fetch(hs.base + `/p/${await mk("Members post", "subscribers")}`);
      assert.equal(gated.headers.get("cache-control"), "private, no-store");
      assert.match(gated.headers.get("vary") ?? "", /Cookie/i);
      const poll = (await hs.call("POST", "/polls", { question: "Q?", options: ["a", "b"] })).json;
      const page = await fetch(hs.base + `/poll/${poll.id}/0?s=sometoken`);
      assert.equal(page.headers.get("cache-control"), "private, no-store");
      assert.match(page.headers.get("vary") ?? "", /Cookie/i);
    } finally { await hs.close(); }
  });
});

describe("merge tags", () => {
  test("a tag that is a whole link can't become javascript: or data:, whatever the subscriber typed", () => {
    const html = (v: string) => merge('<a href="{{first_name}}">x</a><img src="{{first_name}}">', { first_name: v }, true);
    assert.equal(html("javascript:alert(1)"), '<a href="#">x</a><img src="#">');
    assert.equal(html(" javascript:alert(1)"), '<a href="#">x</a><img src="#">');
    assert.equal(html("JaVaScRiPt:alert(1)"), '<a href="#">x</a><img src="#">');
    assert.equal(html("data:text/html,<script>"), '<a href="#">x</a><img src="#">');
    assert.equal(html("//evil.example"), '<a href="#">x</a><img src="#">');
    for (const ok of ["https://example.com/a?b=1&c=2", "http://example.com", "mailto:a@example.com", "/uploads/x.png", "#top"]) {
      assert.ok(!html(ok).includes('href="#"') || ok === "#top", ok);
    }
    assert.equal(merge('<a href="{{u}}">', { u: "https://x.test/?a=1&b=2" }, true), '<a href="https://x.test/?a=1&amp;b=2">');
    assert.equal(merge('<a href="{{u | https://fallback.test}}">', {}, true), '<a href="https://fallback.test">', "an empty tag uses the owner's fallback");
    assert.equal(merge("<p>Hi {{first_name}}</p>", { first_name: "javascript:alert(1)" }, true), "<p>Hi javascript:alert(1)</p>", "text is only escaped");
  });

  test("names that exist on every object are not merge tags", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.equal(merge(`[{{${name}}}]`, {}), "[]", name);
      assert.equal(merge(`[{{${name} | fallback}}]`, {}), "[fallback]", name);
    }
  });
});

describe("odd input", () => {
  test("an unknown segment field or operator is a 422, not a 500", async () => {
    for (const cond of [{ field: "constructor", op: "eq", value: 1 }, { field: "toString", op: "eq", value: 1 }, { field: "opens", op: "constructor", value: 1 }, { field: "opens", op: "__proto__", value: 1 }, { field: "created_at", op: "hasOwnProperty", value: 1 }]) {
      const r = await h.call("POST", "/segments/preview", { rules: { match: "all", conditions: [cond] } });
      assert.equal(r.status, 422, JSON.stringify(cond));
    }
  });

  test("broken % encoding in an API path is a 400", async () => {
    assert.equal((await h.call("GET", "/subscribers/%E0%A4%A")).status, 400);
    assert.equal((await h.call("DELETE", "/suppressions/%E0%A4%A")).status, 400);
  });

  test("?page= can be anything and the site still answers", async () => {
    for (const page of ["1.1", "1e30", "abc", "-5", "0", "", "2", "Infinity", "99999999999999999999"]) {
      assert.equal((await fetch(`${h.base}/p?page=${page}`)).status, 200, page);
    }
  });

  test("form fields called __proto__ or constructor are just fields", async () => {
    const res = await fetch(h.base + "/subscribe", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: "email=proto%40example.org&__proto__=x&__proto__=y&constructor=1&constructor=2&toString=z" });
    assert.equal(res.status, 200);
    assert.equal(({} as any).x, undefined);
    const json = await fetch(h.base + "/subscribe", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: '{"email":"proto2@example.org","__proto__":{"website":"bot"}}' });
    assert.equal(json.status, 200);
    assert.equal((await h.call("GET", "/subscribers/proto2@example.org")).status, 200, "an inherited honeypot value can't swallow the sign-up");
  });

  test("?p= on an unsubscribe link is only kept when it is a real post", async () => {
    const sub = (await h.call("POST", "/subscribers", { email: "unsub-p@example.org" })).json;
    const tok = (h.app.db.prepare("SELECT token FROM subscribers WHERE id = ?").get(sub.id) as { token: string }).token;
    const post = (await h.call("POST", "/posts", { title: "Real post" })).json;
    const unsub = (p: string) => fetch(`${h.base}/u/${tok}?p=${encodeURIComponent(p)}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
    const recorded = () => (h.app.db.prepare("SELECT post_id FROM subscriber_events WHERE subscriber_id = ? AND type = 'unsubscribed'").get(sub.id) as { post_id: string | null } | undefined);

    assert.equal((await unsub("<script>alert(1)</script>" + "x".repeat(500))).status, 200);
    assert.equal(recorded()?.post_id, null);
    h.app.db.prepare("DELETE FROM subscriber_events WHERE subscriber_id = ? AND type = 'unsubscribed'").run(sub.id);
    h.app.db.prepare("UPDATE subscribers SET status = 'active' WHERE id = ?").run(sub.id);
    await unsub(post.id);
    assert.equal(recorded()?.post_id, post.id);

    const page = await (await fetch(`${h.base}/u/${tok}?p=%22%3E%3Cscript%3E`)).text();
    assert.ok(!page.includes("<script>") && !page.includes("?p="), "the page doesn't echo a made-up post id");
  });
});
