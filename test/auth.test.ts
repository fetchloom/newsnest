import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { request } from "node:http";
import { clientIp } from "../src/server/client.ts";
import { harness, verifiedDomain } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
before(async () => { h = await harness(); });
after(() => h.close());

const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(h.base + path, { method: "POST", headers: { "content-type": "application/json", "x-newsnest": "1", ...extra }, body: JSON.stringify(body) });

const cookieOf = (res: Response): string => (res.headers.get("set-cookie") ?? "").split(";")[0];

describe("dashboard login", () => {
  let cookie = "";

  test("starts in setup mode and enforces a password length", async () => {
    const s = await (await fetch(h.base + "/auth/status")).json();
    assert.deepEqual(s, { setup_required: true, authenticated: false });
    assert.equal((await post("/auth/setup", { password: "short", setup_code: h.app.setupCode })).status, 422);
  });

  test("setup needs the X-Newsnest header", async () => {
    const res = await fetch(h.base + "/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse battery" }) });
    assert.equal(res.status, 403);
  });

  test("setup signs you in with an HttpOnly, SameSite=Strict cookie, then closes", async () => {
    const res = await post("/auth/setup", { password: "correct horse battery", setup_code: h.app.setupCode });
    assert.equal(res.status, 201);
    const raw = res.headers.get("set-cookie") ?? "";
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Strict/);
    cookie = cookieOf(res);
    assert.equal((await post("/auth/setup", { password: "another password!", setup_code: h.app.setupCode })).status, 409, "the code is useless once a password exists");
  });

  test("a session can use the API, but only with the custom header", async () => {
    const withHeader = await fetch(h.base + "/stats", { headers: { cookie, "x-newsnest": "1" } });
    assert.equal(withHeader.status, 200);
    assert.equal((await withHeader.json()).emails, 0);
    assert.equal((await fetch(h.base + "/stats", { headers: { cookie } })).status, 403, "cookie alone must not be enough (CSRF)");
    assert.equal((await fetch(h.base + "/stats", { headers: { "x-newsnest": "1" } })).status, 401);
  });

  test("a session can send mail and create keys", async () => {
    await verifiedDomain(h);
    const send = await fetch(h.base + "/emails", {
      method: "POST", headers: { cookie, "x-newsnest": "1", "content-type": "application/json" },
      body: JSON.stringify({ from: "a@example.com", to: "b@dest.test", subject: "from dashboard", text: "hi" }),
    });
    assert.equal(send.status, 201);
    const keys = await fetch(h.base + "/api-keys", { method: "POST", headers: { cookie, "x-newsnest": "1", "content-type": "application/json" }, body: JSON.stringify({ name: "dash" }) });
    assert.equal(keys.status, 201);
  });

  test("wrong passwords fail and get throttled", async () => {
    assert.equal((await post("/auth/login", { password: "nope nope nope" })).status, 401);
    const ok = await post("/auth/login", { password: "correct horse battery" });
    assert.equal(ok.status, 200);
    for (let i = 0; i < 10; i++) await post("/auth/login", { password: "wrong wrong wrong" });
    assert.equal((await post("/auth/login", { password: "correct horse battery" })).status, 429);
  });

  test("logout ends the session", async () => {
    const res = await post("/auth/logout", {}, { cookie });
    assert.equal(res.status, 200);
    assert.equal((await fetch(h.base + "/stats", { headers: { cookie, "x-newsnest": "1" } })).status, 401);
  });

  test("markdown preview renders and escapes", async () => {
    const r = await h.call("POST", "/preview", { markdown: "# Hi\n\n<script>alert(1)</script> **x**" });
    assert.match(r.json.html, /<h1/);
    assert.ok(!r.json.html.includes("<script>alert"), "inline script text must be escaped");
  });
});

describe("changing and recovering the password", () => {
  let hh: Harness;
  let cookie = "";
  before(async () => {
    hh = await harness({ adminPassword: "original password!" });
    const res = await fetch(hh.base + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-newsnest": "1" }, body: JSON.stringify({ password: "original password!" }) });
    cookie = cookieOf(res);
  });
  after(() => hh.close());
  const change = (body: unknown, c = cookie) => fetch(hh.base + "/auth/password", { method: "POST", headers: { "content-type": "application/json", "x-newsnest": "1", cookie: c }, body: JSON.stringify(body) });

  test("needs a session, the right current password and a long enough new one", async () => {
    assert.equal((await change({ password: "original password!", new_password: "a brand new password" }, "")).status, 401);
    assert.equal((await change({ password: "wrong password!!", new_password: "a brand new password" })).status, 401);
    assert.equal((await change({ password: "original password!", new_password: "short" })).status, 422);
  });

  test("changing it keeps you signed in, signs out other sessions, and the old password stops working", async () => {
    const other = cookieOf(await fetch(hh.base + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-newsnest": "1" }, body: JSON.stringify({ password: "original password!" }) }));
    const res = await change({ password: "original password!", new_password: "a brand new password" });
    assert.equal(res.status, 200);
    const fresh = cookieOf(res);
    assert.equal((await (await fetch(hh.base + "/auth/status", { headers: { cookie: fresh } })).json()).authenticated, true);
    assert.equal((await (await fetch(hh.base + "/auth/status", { headers: { cookie: other } })).json()).authenticated, false);
    const login = (password: string) => fetch(hh.base + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-newsnest": "1" }, body: JSON.stringify({ password }) });
    assert.equal((await login("original password!")).status, 401);
    assert.equal((await login("a brand new password")).status, 200);
  });

  test("starting the server with NEWSNEST_ADMIN_PASSWORD resets a forgotten password", async () => {
    const { createApp } = await import("../src/server/app.ts");
    const { checkPassword } = await import("../src/server/auth.ts");
    const first = createApp({ ...hh.cfg, adminPassword: null }, { serveSite: false });
    assert.ok(!checkPassword(first.db, "recovered password!"));
    await first.close();
    const second = createApp({ ...hh.cfg, adminPassword: "recovered password!" }, { serveSite: false });
    assert.ok(checkPassword(second.db, "recovered password!"));
    await second.close();
  });
});

describe("first-run setup code", () => {
  let hh: Harness;
  before(async () => { hh = await harness(); });
  after(() => hh.close());
  const setup = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(hh.base + "/auth/setup", { method: "POST", headers: { "content-type": "application/json", "x-newsnest": "1", ...headers }, body: JSON.stringify(body) });
  /** fetch() won't let us lie about Host, so go through node:http. */
  const setupWithHost = (host: string, body: unknown) => new Promise<number>((resolve, reject) => {
    const u = new URL(hh.base);
    const req = request({ host: u.hostname, port: u.port, path: "/auth/setup", method: "POST", headers: { host, "content-type": "application/json", "x-newsnest": "1" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });

  test("a code is generated on first start and has the XXXX-XXXX shape", () => {
    assert.match(hh.app.setupCode ?? "", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  test("a missing or wrong code is rejected and creates nothing", async () => {
    assert.equal((await setup({ password: "correct horse battery" })).status, 403);
    assert.equal((await setup({ password: "correct horse battery", setup_code: "AAAA-AAAA" })).status, 403);
    assert.equal((await (await fetch(hh.base + "/auth/status")).json()).setup_required, true);
  });

  test("a proxy header or a non-local Host closes setup even with the right code", async () => {
    const body = { password: "correct horse battery", setup_code: hh.app.setupCode };
    assert.equal((await setup(body, { "x-forwarded-for": "203.0.113.9" })).status, 403);
    assert.equal(await setupWithHost("news.example.com", body), 403);
    assert.equal(await setupWithHost("localhost:8700", { ...body, password: "short" }), 422, "a loopback Host passes the local check");
  });

  test("the right code works once, in any case and with or without the dash", async () => {
    const res = await setup({ password: "correct horse battery", setup_code: hh.app.setupCode!.toLowerCase().replace("-", " ") });
    assert.equal(res.status, 201);
    assert.equal((await setup({ password: "another password!", setup_code: hh.app.setupCode })).status, 409);
  });

  test("guessing the code is throttled like a login", async () => {
    const h2 = await harness();
    try {
      const guess = () => fetch(h2.base + "/auth/setup", { method: "POST", headers: { "content-type": "application/json", "x-newsnest": "1" }, body: JSON.stringify({ password: "correct horse battery", setup_code: "ZZZZ-ZZZZ" }) });
      for (let i = 0; i < 10; i++) assert.equal((await guess()).status, 403);
      assert.equal((await guess()).status, 429);
    } finally { await h2.close(); }
  });

  test("a password in the environment skips the code entirely", async () => {
    const h3 = await harness({ adminPassword: "from the environment" });
    try { assert.equal(h3.app.setupCode, null); } finally { await h3.close(); }
  });
});

describe("login throttle keys", () => {
  let hh: Harness;
  before(async () => { hh = await harness({ trustProxy: true, adminPassword: "original password!" }); });
  after(() => hh.close());
  const login = (password: string, xff?: string, extra: Record<string, string> = {}) =>
    fetch(hh.base + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-newsnest": "1", ...(xff ? { "x-forwarded-for": xff } : {}), ...extra }, body: JSON.stringify({ password }) });

  test("with a trusted proxy each client address has its own bucket", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await login("wrong wrong wrong", "198.51.100.1")).status, 401);
    assert.equal((await login("original password!", "198.51.100.1")).status, 429);
    assert.equal((await login("original password!", "198.51.100.2")).status, 200, "another client is not affected");
  });

  test("only the proxy's own (last) entry counts, so a client can't pick its bucket", async () => {
    assert.equal((await login("original password!", "203.0.113.77, 198.51.100.1")).status, 429, "same last hop, same bucket");
    assert.equal((await login("wrong wrong wrong", "198.51.100.1, 198.51.100.50")).status, 401, "a different last hop is a different client");
  });

  test("a signed-in owner is not blocked by a stranger's failures", async () => {
    const owner = cookieOf(await login("original password!", "198.51.100.99"));
    for (let i = 0; i < 10; i++) await login("wrong wrong wrong", "198.51.100.1");
    const change = await fetch(hh.base + "/auth/password", { method: "POST", headers: { "content-type": "application/json", "x-newsnest": "1", cookie: owner, "x-forwarded-for": "198.51.100.1" }, body: JSON.stringify({ password: "original password!", new_password: "a brand new password" }) });
    assert.equal(change.status, 200);
  });

  test("auth bodies are capped at 4 KB", async () => {
    assert.equal((await login("x".repeat(5000), "198.51.100.3")).status, 413);
  });

  test("without a trusted proxy the header is ignored", async () => {
    const h2 = await harness({ adminPassword: "original password!" });
    try {
      const l = (xff: string) => fetch(h2.base + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-newsnest": "1", "x-forwarded-for": xff }, body: JSON.stringify({ password: "wrong wrong wrong" }) });
      for (let i = 0; i < 10; i++) await l(`10.0.0.${i}`);
      assert.equal((await l("10.9.9.9")).status, 429, "rotating the header doesn't buy fresh attempts");
    } finally { await h2.close(); }
  });

  test("clientIp: IPv6 clients share their /64, v4-mapped addresses are plain v4, junk falls back to the socket", () => {
    const req = (xff: string, peer = "10.0.0.1") => ({ headers: { "x-forwarded-for": xff }, socket: { remoteAddress: peer } }) as never;
    const cfg = { trustProxy: true };
    assert.equal(clientIp(req("2001:db8:1:2:aaaa::1"), cfg), clientIp(req("2001:db8:1:2:bbbb::9"), cfg));
    assert.notEqual(clientIp(req("2001:db8:1:3::1"), cfg), clientIp(req("2001:db8:1:2::1"), cfg));
    assert.equal(clientIp(req("::ffff:192.0.2.5"), cfg), "192.0.2.5");
    assert.equal(clientIp(req("not-an-ip"), cfg), "10.0.0.1");
    assert.equal(clientIp(req("1.2.3.4"), { trustProxy: false }), "10.0.0.1");
  });
});
