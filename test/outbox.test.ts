import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { harness } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
before(async () => { h = await harness({ mode: "outbox", relayUrl: null }); });
after(() => h.close());

test("outbox mode writes .eml files and needs no verified domain", async () => {
  const r = await h.call("POST", "/emails", { from: "me@anything.test", to: "you@dest.test", subject: "Héllo ✓", text: "plain body" });
  assert.equal(r.status, 201);

  const dir = join(h.cfg.dataDir, "outbox");
  await h.waitFor(() => existsSync(dir) && readdirSync(dir).length === 1);
  const eml = readFileSync(join(dir, readdirSync(dir)[0]), "utf8");
  assert.match(eml, /^From: me@anything\.test/);
  assert.match(eml, /Subject: =\?UTF-8\?B\?/);
  assert.ok(!eml.includes("DKIM-Signature"), "no domain, no signature");

  await h.waitFor(() => h.app.db.prepare("SELECT 1 FROM deliveries WHERE email_id = ? AND status = 'sent'").get(r.json.id));
  assert.equal((await h.call("GET", `/emails/${r.json.id}`)).json.last_event, "email.sent");
});

test("work left mid-flight by a crash is picked up again", async () => {
  const r = await h.call("POST", "/emails", { from: "me@anything.test", to: "crash@dest.test", subject: "x", text: "y", scheduled_at: new Date(Date.now() + 60_000).toISOString() });
  h.app.db.prepare("UPDATE deliveries SET status = 'sending' WHERE email_id = ?").run(r.json.id);
  const { startQueue } = await import("../src/server/queue.ts");
  const q = startQueue(h.app.db, h.cfg);
  q.stop();
  const row = h.app.db.prepare("SELECT status FROM deliveries WHERE email_id = ?").get(r.json.id) as { status: string };
  assert.equal(row.status, "queued");
});
