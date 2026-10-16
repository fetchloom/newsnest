import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { harness, verifiedDomain } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
before(async () => { h = await harness(); });
after(() => h.close());

const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(h.base + path, { method: "POST", headers: { "content-type": "application/json", "x-freepost": "1", ...extra }, body: JSON.stringify(body) });

const cookieOf = (res: Response): string => (res.headers.get("set-cookie") ?? "").split(";")[0];

describe("dashboard login", () => {
  let cookie = "";

  test("starts in setup mode and enforces a password length", async () => {
    const s = await (await fetch(h.base + "/auth/status")).json();
    assert.deepEqual(s, { setup_required: true, authenticated: false });
    assert.equal((await post("/auth/setup", { password: "short" })).status, 422);
  });

  test("setup needs the X-Freepost header", async () => {
    const res = await fetch(h.base + "/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse battery" }) });
    assert.equal(res.status, 403);
  });

  test("setup signs you in with an HttpOnly, SameSite=Strict cookie, then closes", async () => {
    const res = await post("/auth/setup", { password: "correct horse battery" });
    assert.equal(res.status, 201);
    const raw = res.headers.get("set-cookie") ?? "";
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Strict/);
    cookie = cookieOf(res);
    assert.equal((await post("/auth/setup", { password: "another password!" })).status, 409);
  });

  test("a session can use the API, but only with the custom header", async () => {
    const withHeader = await fetch(h.base + "/stats", { headers: { cookie, "x-freepost": "1" } });
    assert.equal(withHeader.status, 200);
    assert.equal((await withHeader.json()).emails, 0);
    assert.equal((await fetch(h.base + "/stats", { headers: { cookie } })).status, 403, "cookie alone must not be enough (CSRF)");
    assert.equal((await fetch(h.base + "/stats", { headers: { "x-freepost": "1" } })).status, 401);
  });

  test("a session can send mail and create keys", async () => {
    await verifiedDomain(h);
    const send = await fetch(h.base + "/emails", {
      method: "POST", headers: { cookie, "x-freepost": "1", "content-type": "application/json" },
      body: JSON.stringify({ from: "a@example.com", to: "b@dest.test", subject: "from dashboard", text: "hi" }),
    });
    assert.equal(send.status, 201);
    const keys = await fetch(h.base + "/api-keys", { method: "POST", headers: { cookie, "x-freepost": "1", "content-type": "application/json" }, body: JSON.stringify({ name: "dash" }) });
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
    assert.equal((await fetch(h.base + "/stats", { headers: { cookie, "x-freepost": "1" } })).status, 401);
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
    const res = await fetch(hh.base + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-freepost": "1" }, body: JSON.stringify({ password: "original password!" }) });
    cookie = cookieOf(res);
  });
  after(() => hh.close());
  const change = (body: unknown, c = cookie) => fetch(hh.base + "/auth/password", { method: "POST", headers: { "content-type": "application/json", "x-freepost": "1", cookie: c }, body: JSON.stringify(body) });

  test("needs a session, the right current password and a long enough new one", async () => {
    assert.equal((await change({ password: "original password!", new_password: "a brand new password" }, "")).status, 401);
    assert.equal((await change({ password: "wrong password!!", new_password: "a brand new password" })).status, 401);
    assert.equal((await change({ password: "original password!", new_password: "short" })).status, 422);
  });

  test("changing it keeps you signed in, signs out other sessions, and the old password stops working", async () => {
    const other = cookieOf(await fetch(hh.base + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-freepost": "1" }, body: JSON.stringify({ password: "original password!" }) }));
    const res = await change({ password: "original password!", new_password: "a brand new password" });
    assert.equal(res.status, 200);
    const fresh = cookieOf(res);
    assert.equal((await (await fetch(hh.base + "/auth/status", { headers: { cookie: fresh } })).json()).authenticated, true);
    assert.equal((await (await fetch(hh.base + "/auth/status", { headers: { cookie: other } })).json()).authenticated, false);
    const login = (password: string) => fetch(hh.base + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-freepost": "1" }, body: JSON.stringify({ password }) });
    assert.equal((await login("original password!")).status, 401);
    assert.equal((await login("a brand new password")).status, 200);
  });

  test("starting the server with FREEPOST_ADMIN_PASSWORD resets a forgotten password", async () => {
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
