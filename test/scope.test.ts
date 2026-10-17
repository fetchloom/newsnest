import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { harness, verifiedDomain } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
let keyA: string;
let keyB: string;
let keyOther: string;
const ids: Record<string, string> = {};

before(async () => {
  h = await harness();
  await verifiedDomain(h);
  const other = await verifiedDomain(h, "other.test");
  await h.call("PATCH", "/publication", { name: "Scope Letter", from_email: "news@example.com", site_url: h.base, address: "1 Test St" });
  keyA = (await h.call("POST", "/api-keys", { name: "a", permission: "sending" })).json.key;
  keyB = (await h.call("POST", "/api-keys", { name: "b", permission: "sending" })).json.key;
  keyOther = (await h.call("POST", "/api-keys", { name: "other", permission: "sending", domain_id: other.id })).json.key;
  const send = (k: string, from: string, subject: string) => h.call("POST", "/emails", { from, to: "x@dest.test", subject, text: "hello", scheduled_at: new Date(Date.now() + 3600_000).toISOString() }, {}, k);
  ids.a = (await send(keyA, "a@example.com", "from A")).json.id;
  ids.b = (await send(keyB, "b@example.com", "from B")).json.id;
  ids.other = (await send(keyOther, "o@other.test", "from other")).json.id;
  // A system email (confirmation) and a full-key email.
  await h.call("POST", "/subscribers", { email: "pending@example.org", send_confirmation: true });
  ids.system = (await h.call("GET", "/emails?kind=system")).json.data[0].id;
  ids.full = (await h.call("POST", "/emails", { from: "f@example.com", to: "x@dest.test", subject: "from full", text: "hello" })).json.id;
});
after(() => h.close());

const as = (k: string, method: string, path: string, body?: unknown) => h.call(method, path, body, {}, k);

describe("sending keys only see their own API mail", () => {
  test("the list holds only mail this key sent, whatever kind is asked for", async () => {
    for (const q of ["", "?kind=all", "?kind=system", "?kind=broadcast"]) {
      const data = (await as(keyA, "GET", `/emails${q}`)).json.data as { id: string; kind: string }[];
      assert.ok(data.every((e) => e.kind === "api" && e.id === ids.a), `${q}: ${JSON.stringify(data)}`);
    }
    assert.deepEqual(((await as(keyA, "GET", "/emails?kind=all")).json.data as { id: string }[]).map((e) => e.id), [ids.a]);
    assert.deepEqual(((await as(keyB, "GET", "/emails")).json.data as { id: string }[]).map((e) => e.id), [ids.b]);
    assert.deepEqual(((await as(keyOther, "GET", "/emails")).json.data as { id: string }[]).map((e) => e.id), [ids.other]);
  });

  test("other keys' mail and system mail can't be read, listed, cancelled or rescheduled", async () => {
    for (const id of [ids.b, ids.system, ids.full]) {
      assert.equal((await as(keyA, "GET", `/emails/${id}`)).status, 404, "get");
      assert.equal((await as(keyA, "GET", `/emails/${id}/events`)).status, 404, "events");
      assert.equal((await as(keyA, "PATCH", `/emails/${id}`, { scheduled_at: null })).status, 404, "reschedule");
      assert.equal((await as(keyA, "POST", `/emails/${id}/cancel`)).status, 404, "cancel");
    }
    assert.notEqual((await h.call("GET", `/emails/${ids.b}`)).json.deliveries[0].status, "canceled");
  });

  test("a key still manages its own mail", async () => {
    const mine = await as(keyA, "GET", `/emails/${ids.a}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.json.text, "hello");
    assert.equal((await as(keyA, "GET", `/emails/${ids.a}/events`)).status, 200);
    assert.equal((await as(keyA, "PATCH", `/emails/${ids.a}`, { scheduled_at: new Date(Date.now() + 7200_000).toISOString() })).status, 200);
    assert.equal((await as(keyA, "POST", `/emails/${ids.a}/cancel`)).status, 200);
  });

  test("the pagination cursor can't be used to probe other keys' mail", async () => {
    assert.equal((await as(keyA, "GET", `/emails?after=${ids.b}`)).status, 422);
  });
});

describe("full keys and the dashboard keep seeing everything", () => {
  test("a full key lists and reads every kind", async () => {
    const all = (await h.call("GET", "/emails?kind=all&limit=100")).json.data as { id: string }[];
    for (const id of [ids.a, ids.b, ids.other, ids.system, ids.full]) assert.ok(all.some((e) => e.id === id), id);
    assert.equal((await h.call("GET", `/emails/${ids.system}`)).status, 200);
  });
});
