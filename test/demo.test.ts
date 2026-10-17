import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { harness } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
before(async () => { h = await harness(); });
after(() => h.close());

describe("sample data", () => {
  test("loads into an empty Newsnest and fills the dashboard with believable numbers", async () => {
    assert.deepEqual((await h.call("GET", "/demo")).json, { loaded: false, empty: true });
    const res = await h.call("POST", "/demo");
    assert.equal(res.status, 201);
    assert.ok(res.json.subscribers > 300);

    const audience = (await h.call("GET", "/analytics/audience?days=30")).json;
    assert.ok(audience.totals.active > 250);
    assert.ok(audience.growth.some((g: any) => g.subscribed > 0));
    assert.ok(audience.sources.length > 1);
    assert.equal(audience.recent_posts.length, 5);
    for (const p of audience.recent_posts) { assert.ok(p.sent > 50); assert.ok(p.open_rate > 15 && p.open_rate < 80, `open rate ${p.open_rate}`); assert.ok(p.click_rate > 0); }
    assert.ok(audience.engagement.length >= 3, "a spread of engagement levels");

    const posts = (await h.call("GET", "/posts")).json.data;
    const sent = posts.filter((p: any) => p.status === "sent");
    assert.equal(sent.length, 5);
    assert.equal(posts.filter((p: any) => p.status === "draft").length, 2);
    const stats = (await h.call("GET", `/posts/${sent[0].id}/stats`)).json;
    assert.ok(stats.top_links.length >= 1 && stats.devices.length === 2 && stats.hourly.length > 3);

    assert.equal((await h.call("GET", "/segments")).json.data.length, 2);
    assert.equal((await h.call("GET", "/polls")).json.data.length, 1);
    assert.equal((await h.call("GET", "/automations")).json.data[0].status, "live");
    assert.deepEqual((await h.call("GET", "/demo")).json, { loaded: true, empty: false });
  });

  test("every address is a safe example address, and nothing is queued to send", async () => {
    const emails = (h.app.db.prepare("SELECT email FROM subscribers").all() as { email: string }[]).map((r) => r.email);
    assert.ok(emails.every((e) => /@example\.(com|org|net)$/.test(e)));
    assert.equal((h.app.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('queued','sending')").get() as { n: number }).n, 0);
    assert.equal((h.app.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status IN ('scheduled','sending')").get() as { n: number }).n, 0);
  });

  test("the hourly cleanup of stale sign-ups leaves sample data alone", async () => {
    const { purgeStale } = await import("../src/server/newsletter/maintenance.ts");
    const count = (): number => (h.app.db.prepare("SELECT COUNT(*) AS n FROM subscribers").get() as { n: number }).n;
    const before = count();
    assert.equal(purgeStale(h.app.db, h.cfg).subscribers, 0);
    assert.equal(count(), before);
  });

  test("it won't load twice, or into an instance that already has real data", async () => {
    assert.equal((await h.call("POST", "/demo")).status, 409);
  });

  test("removing it leaves an empty Newsnest again", async () => {
    assert.equal((await h.call("DELETE", "/demo")).json.removed, true);
    for (const table of ["subscribers", "posts", "emails", "events", "segments", "polls", "automations", "rewards", "pages", "links", "subscriber_events", "subscriber_tags"]) {
      assert.equal((h.app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
    }
    assert.deepEqual((await h.call("GET", "/demo")).json, { loaded: false, empty: true });
  });

  test("real data blocks sample data", async () => {
    await h.call("POST", "/subscribers", { email: "real@example.org" });
    assert.equal((await h.call("POST", "/demo")).status, 409);
  });
});
