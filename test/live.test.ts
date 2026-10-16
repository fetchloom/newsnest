import assert from "node:assert/strict";
import { get } from "node:http";
import { after, before, describe, test } from "node:test";
import { COOKIE, createSession } from "../src/server/auth.ts";
import { harness } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
before(async () => { h = await harness(); });
after(async () => { await h.close(); });

/** Opens /live and collects what the server sends until `stop()`. */
function listen(cookie?: string): Promise<{ status: number; text: () => string; stop: () => void }> {
  return new Promise((resolve) => {
    get(`${h.base}/live`, { headers: cookie ? { cookie } : {} }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { buf += d; });
      resolve({ status: res.statusCode ?? 0, text: () => buf, stop: () => res.destroy() });
    });
  });
}
const until = async (fn: () => boolean, ms = 4000): Promise<void> => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) assert.fail("timed out"); await new Promise((r) => setTimeout(r, 50)); } };

describe("live updates", () => {
  test("the stream needs a dashboard session", async () => {
    const anon = await listen();
    assert.equal(anon.status, 401);
    anon.stop();
    const api = await listen(`${COOKIE}=nonsense`);
    assert.equal(api.status, 401);
    api.stop();
  });

  test("a new subscriber produces a change and a notice", async () => {
    const stream = await listen(`${COOKIE}=${createSession(h.app.db)}`);
    assert.equal(stream.status, 200);
    await until(() => stream.text().includes("event: hello"));
    await h.call("POST", "/subscribers", { email: "live@example.org" });
    await until(() => stream.text().includes("event: change") && stream.text().includes("New subscriber: live@example.org"));
    stream.stop();
  });

  test("a quiet database sends nothing but keep-alives", async () => {
    const stream = await listen(`${COOKIE}=${createSession(h.app.db)}`);
    await until(() => stream.text().includes("event: hello"));
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!stream.text().includes("event: change"), stream.text());
    stream.stop();
  });
});
