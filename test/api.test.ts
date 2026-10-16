import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dkimVerify } from "../src/server/mime.ts";
import { verifySignature } from "../src/server/webhooks.ts";
import { harness, verifiedDomain } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
let publicKey: string;

before(async () => {
  h = await harness();
  ({ publicKey } = await verifiedDomain(h));
});
after(() => h.close());

const mail = (extra: Record<string, unknown> = {}) => ({
  from: "Ada <ada@example.com>",
  to: ["hello@dest.test"],
  subject: "It's free. Really.",
  markdown: "# Hi\n\nNo tiers. **No meters.**",
  ...extra,
});

describe("auth", () => {
  test("rejects missing and bad keys", async () => {
    assert.equal((await h.call("GET", "/emails", undefined, {}, null)).status, 401);
    assert.equal((await h.call("GET", "/emails", undefined, {}, "nn_nope")).status, 401);
  });

  test("/health needs no key", async () => {
    const r = await h.call("GET", "/health", undefined, {}, null);
    assert.equal(r.status, 200);
  });

  test("sending keys can send but not manage", async () => {
    const created = await h.call("POST", "/api-keys", { name: "ci", permission: "sending" });
    assert.equal(created.status, 201);
    assert.match(created.json.key, /^nn_/);
    const sk = created.json.key;
    assert.equal((await h.call("GET", "/emails", undefined, {}, sk)).status, 200);
    assert.equal((await h.call("GET", "/domains", undefined, {}, sk)).status, 403);
    const list = await h.call("GET", "/api-keys");
    assert.ok(!JSON.stringify(list.json).includes(sk), "plaintext key must never be listed");
  });

  test("revoked keys stop working", async () => {
    const created = await h.call("POST", "/api-keys", { name: "temp" });
    assert.equal((await h.call("GET", "/emails", undefined, {}, created.json.key)).status, 200);
    await h.call("DELETE", `/api-keys/${created.json.id}`);
    assert.equal((await h.call("GET", "/emails", undefined, {}, created.json.key)).status, 401);
  });
});

describe("domains", () => {
  test("verification reports each record", async () => {
    const d = await h.call("POST", "/domains", { name: "other.test" });
    assert.equal(d.status, 201);
    assert.deepEqual(d.json.records.map((r: any) => r.record), ["DKIM", "SPF", "DMARC"]);
    const failed = await h.call("POST", `/domains/${d.json.id}/verify`);
    assert.equal(failed.json.status, "failed");
    assert.equal((await h.call("POST", "/domains", { name: "other.test" })).status, 409);
    assert.equal((await h.call("POST", "/domains", { name: "not a domain" })).status, 422);
  });

  test("sending from an unverified domain is refused", async () => {
    const r = await h.call("POST", "/emails", mail({ from: "x@other.test" }));
    assert.equal(r.status, 403);
    assert.equal(r.json.name, "domain_not_verified");
  });
});

describe("sending", () => {
  test("delivers a DKIM-signed multipart message and records events", async () => {
    const r = await h.call("POST", "/emails", mail({ cc: "cc@dest.test", tags: [{ name: "kind", value: "welcome" }] }));
    assert.equal(r.status, 201);
    const id = r.json.id as string;

    await h.waitFor(() => h.smtp.messages.length >= 2);
    const msg = h.smtp.messages.find((m) => m.to[0] === "hello@dest.test")!;
    assert.equal(msg.from, "ada@example.com");
    assert.match(msg.data, /^DKIM-Signature: /);
    assert.match(msg.data, /Subject: It's free\. Really\./);
    assert.match(msg.data, /multipart\/alternative/);
    assert.ok(dkimVerify(msg.data, publicKey), "DKIM signature must verify against the published key");

    await h.waitFor(() => h.app.db.prepare("SELECT 1 FROM deliveries WHERE email_id = ? AND status = 'sent' GROUP BY email_id HAVING COUNT(*) = 2").get(id));
    const got = await h.call("GET", `/emails/${id}`);
    assert.equal(got.json.last_event, "email.sent");
    assert.deepEqual(got.json.deliveries.map((d: any) => d.to).sort(), ["cc@dest.test", "hello@dest.test"]);
    assert.match(got.json.html, /<strong>No meters\.<\/strong>/);
    assert.match(got.json.text, /No meters\./);

    const events = await h.call("GET", `/emails/${id}/events`);
    assert.deepEqual(events.json.data.map((e: any) => e.type).slice(0, 2), ["email.queued", "email.sent"]);
  });

  test("bcc recipients are delivered but never appear in headers", async () => {
    const before = h.smtp.messages.length;
    await h.call("POST", "/emails", mail({ bcc: ["secret@dest.test"] }));
    await h.waitFor(() => h.smtp.messages.length >= before + 2);
    const msg = h.smtp.messages.find((m) => m.to[0] === "secret@dest.test")!;
    assert.ok(msg);
    assert.ok(!msg.data.includes("secret@dest.test"));
  });

  test("validation errors are 422 with a clear message", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...mail(), from: "nope" }, /"from"/],
      [{ ...mail(), to: [] }, /"to"/],
      [{ ...mail(), subject: undefined }, /"subject"/],
      [{ ...mail(), markdown: undefined }, /html.*text.*markdown/i],
      [{ ...mail(), html: "<p>x</p>" }, /either/],
      [{ ...mail(), headers: { "X-A\r\nBcc": "x" } }, /header name/i],
      [{ ...mail(), headers: { From: "evil@x.test" } }, /cannot be overridden/],
      [{ ...mail(), to: "a@b.test\r\nBcc: z@z.test" }, /line breaks/],
      [{ ...mail(), scheduled_at: "tomorrow-ish" }, /ISO 8601/],
    ];
    for (const [body, re] of cases) {
      const r = await h.call("POST", "/emails", body);
      assert.equal(r.status, 422, JSON.stringify(body));
      assert.match(r.json.message, re);
    }
    assert.equal((await h.call("POST", "/emails", "not json" as any, { "content-type": "text/plain" })).status, 422);
  });

  test("idempotency keys replay the first response", async () => {
    const headers = { "idempotency-key": "order-1001" };
    const a = await h.call("POST", "/emails", mail(), headers);
    const b = await h.call("POST", "/emails", mail(), headers);
    assert.equal(a.json.id, b.json.id);
    assert.equal(b.headers.get("idempotent-replayed"), "true");
    const c = await h.call("POST", "/emails", mail({ subject: "different" }), headers);
    assert.equal(c.status, 409);
  });

  test("batch is atomic", async () => {
    const bad = await h.call("POST", "/emails/batch", [mail(), { ...mail(), from: "broken" }]);
    assert.equal(bad.status, 422);
    assert.match(bad.json.message, /Email 1/);
    const good = await h.call("POST", "/emails/batch", [mail(), mail({ to: "other@dest.test" })]);
    assert.equal(good.status, 201);
    assert.equal(good.json.data.length, 2);
  });

  test("list paginates newest first", async () => {
    const page1 = await h.call("GET", "/emails?limit=2");
    assert.equal(page1.json.data.length, 2);
    assert.equal(page1.json.has_more, true);
    const page2 = await h.call("GET", `/emails?limit=2&after=${page1.json.data[1].id}`);
    assert.ok(page2.json.data.length > 0);
    assert.ok(!page2.json.data.some((e: any) => page1.json.data.some((p: any) => p.id === e.id)));
  });
});

describe("scheduling", () => {
  test("a scheduled email waits, can be rescheduled and canceled", async () => {
    const when = new Date(Date.now() + 3600_000).toISOString();
    const r = await h.call("POST", "/emails", mail({ scheduled_at: when, to: "later@dest.test" }));
    assert.equal(r.status, 201);
    assert.equal((await h.call("GET", `/emails/${r.json.id}`)).json.last_event, "email.scheduled");

    const moved = await h.call("PATCH", `/emails/${r.json.id}`, { scheduled_at: new Date(Date.now() + 7200_000).toISOString() });
    assert.equal(moved.status, 200);

    const canceled = await h.call("POST", `/emails/${r.json.id}/cancel`);
    assert.equal(canceled.status, 200);
    const after = await h.call("GET", `/emails/${r.json.id}`);
    assert.equal(after.json.last_event, "email.canceled");
    assert.equal(after.json.deliveries[0].status, "canceled");
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(!h.smtp.messages.some((m) => m.to.includes("later@dest.test")));
  });

  test("an email that already sent cannot be canceled", async () => {
    const r = await h.call("POST", "/emails", mail({ to: "now@dest.test" }));
    await h.waitFor(() => h.smtp.messages.some((m) => m.to.includes("now@dest.test")));
    await h.waitFor(() => h.app.db.prepare("SELECT 1 FROM deliveries WHERE email_id = ? AND status = 'sent'").get(r.json.id));
    assert.equal((await h.call("POST", `/emails/${r.json.id}/cancel`)).status, 409);
  });
});

describe("bounces, suppressions and webhooks", () => {
  test("a permanent failure bounces, suppresses, and fires a signed webhook", async () => {
    const hook = await h.call("POST", "/webhooks", { url: "https://hooks.test/in", events: ["email.bounced"] });
    assert.equal(hook.status, 201);
    assert.match(hook.json.secret, /^whsec_/);

    h.smtp.rejectRcpt = { match: /gone@dest\.test/, code: 550, text: "5.1.1 mailbox unavailable" };
    const r = await h.call("POST", "/emails", mail({ to: "gone@dest.test" }));
    await h.waitFor(() => h.webhookCalls.length > 0);

    const got = await h.call("GET", `/emails/${r.json.id}`);
    assert.equal(got.json.last_event, "email.bounced");
    assert.equal(got.json.deliveries[0].status, "bounced");

    const call = h.webhookCalls[0];
    assert.equal(call.url, "https://hooks.test/in");
    const payload = JSON.parse(call.body);
    assert.equal(payload.type, "email.bounced");
    assert.equal(payload.data.email_id, r.json.id);
    assert.deepEqual(payload.data.to, ["gone@dest.test"]);
    assert.ok(verifySignature(hook.json.secret, { id: call.headers["newsnest-id"], timestamp: call.headers["newsnest-timestamp"], signature: call.headers["newsnest-signature"] }, call.body));
    assert.ok(!verifySignature("whsec_wrong", { id: call.headers["newsnest-id"], timestamp: call.headers["newsnest-timestamp"], signature: call.headers["newsnest-signature"] }, call.body));

    const sup = await h.call("GET", "/suppressions");
    assert.ok(sup.json.data.some((s: any) => s.email === "gone@dest.test" && s.reason === "bounce"));

    // Sending to a suppressed address does not touch SMTP.
    const count = h.smtp.messages.length;
    const again = await h.call("POST", "/emails", mail({ to: "gone@dest.test" }));
    const detail = await h.call("GET", `/emails/${again.json.id}`);
    assert.equal(detail.json.deliveries[0].status, "suppressed");
    assert.equal(h.smtp.messages.length, count);

    assert.equal((await h.call("DELETE", "/suppressions/gone%40dest.test")).status, 200);
    h.smtp.rejectRcpt = null;
  });

  test("temporary failures retry and report a delay once", async () => {
    h.smtp.rejectRcpt = { match: /slow@dest\.test/, code: 451, text: "4.2.0 try later" };
    const r = await h.call("POST", "/emails", mail({ to: "slow@dest.test" }));
    await h.waitFor(() => h.app.db.prepare("SELECT 1 FROM deliveries WHERE email_id = ? AND status = 'queued' AND attempts = 1").get(r.json.id));
    const events = await h.call("GET", `/emails/${r.json.id}/events`);
    assert.ok(events.json.data.some((e: any) => e.type === "email.delivery_delayed"));
    assert.equal((await h.call("GET", `/emails/${r.json.id}`)).json.deliveries[0].status, "queued");
    h.smtp.rejectRcpt = null;
  });

  test("webhook URLs must be http(s)", async () => {
    assert.equal((await h.call("POST", "/webhooks", { url: "file:///etc/passwd" })).status, 422);
    assert.equal((await h.call("POST", "/webhooks", { url: "https://x.test", events: ["nope"] })).status, 422);
  });
});

describe("misc", () => {
  test("unknown routes and wrong methods", async () => {
    assert.equal((await h.call("GET", "/emails/em_missing")).status, 404);
    assert.equal((await h.call("PUT", "/emails")).status, 405);
  });

  test("rate limiting returns 429 with Retry-After", async () => {
    const tight = await harness({ rateLimitPerSec: 1 });
    try {
      const statuses: number[] = [];
      let last: Headers | null = null;
      for (let i = 0; i < 6; i++) { const r = await tight.call("GET", "/emails"); statuses.push(r.status); last = r.headers; }
      assert.ok(statuses.includes(429), statuses.join());
      assert.ok(last!.get("retry-after") || statuses.at(-1) === 200);
    } finally { await tight.close(); }
  });
});
