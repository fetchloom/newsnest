import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { harness, verifiedDomain } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
before(async () => {
  h = await harness();
  await verifiedDomain(h);
  const r = await h.call("PATCH", "/publication", { name: "The Test Letter", from_name: "Ada", from_email: "news@example.com", site_url: h.base, address: "1 Test Street, Testville", brand_color: "#1663fe", description: "Notes on writing" });
  assert.equal(r.status, 200);
});
after(() => h.close());

const subjectOf = (data: string): string => /^Subject: (.*)$/m.exec(data)?.[1] ?? "";
const decodeBody = (data: string): string => {
  const out: string[] = [];
  for (const m of data.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)) out.push(Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8"));
  return out.join("\n");
};
const newPost = async (extra: Record<string, unknown> = {}) =>
  (await h.call("POST", "/posts", { title: "Designed post", blocks: [{ type: "text", props: { markdown: "Hello **world**" } }, { type: "button", props: { label: "Go", url: "https://example.com/go" } }], ...extra })).json;

describe("designs", () => {
  test("four designs are listed and a new publication defaults to modern", async () => {
    const list = await h.call("GET", "/designs");
    assert.deepEqual(list.json.data.map((d: any) => d.id), ["plain", "editorial", "modern", "bold"]);
    assert.equal((await h.call("GET", "/publication")).json.design, "modern");
  });

  test("the publication design is validated and can be changed", async () => {
    assert.equal((await h.call("PATCH", "/publication", { design: "neon" })).status, 422);
    assert.equal((await h.call("PATCH", "/publication", { design: "bold" })).json.design, "bold");
    await h.call("PATCH", "/publication", { design: "modern" });
  });

  test("every design renders the same content in its own layout", async () => {
    const marker: Record<string, RegExp> = {
      plain: /border-top:4px solid #1663fe/,
      editorial: /border-top:3px double/,
      modern: /border-radius:16px/,
      bold: /background:#0b1020/,
    };
    for (const [id, re] of Object.entries(marker)) {
      const { json, status } = await h.call("POST", "/designs/sample", { design: id });
      assert.equal(status, 200, id);
      assert.match(json.html, re, id);
      assert.match(json.html, /Why small newsletters win/, id);
      assert.match(json.html, /Unsubscribe/, id);
      assert.match(json.html, /1 Test Street, Testville/, id);
      assert.match(json.html, /#1663fe/, `${id} uses the brand colour`);
    }
    assert.equal((await h.call("POST", "/designs/sample", { design: "nope" })).status, 422);
  });

  test("a post can pick its own design, or follow the publication's", async () => {
    const p = await newPost();
    assert.equal(p.design, "");
    const own = await h.call("POST", `/posts/${p.id}/preview`, {});
    assert.match(own.json.html, /border-radius:16px/, "follows the publication design (modern)");
    assert.equal((await h.call("PATCH", `/posts/${p.id}`, { design: "editorial" })).json.design, "editorial");
    assert.match((await h.call("POST", `/posts/${p.id}/preview`, {})).json.html, /border-top:3px double/);
    assert.match((await h.call("POST", `/posts/${p.id}/preview`, { design: "bold" })).json.html, /background:#0b1020/, "unsaved choices preview too");
    assert.equal((await h.call("PATCH", `/posts/${p.id}`, { design: "sparkly" })).status, 422);
  });

  test("buttons follow the design's corners", async () => {
    const p = await newPost();
    assert.match((await h.call("POST", `/posts/${p.id}/preview`, { design: "modern" })).json.html, /border-radius:999px/);
    assert.match((await h.call("POST", `/posts/${p.id}/preview`, { design: "editorial" })).json.html, /border-radius:0;/);
  });
});

describe("custom HTML emails", () => {
  const SOURCE = `<!doctype html><html><body><h1>Hello {{first_name | friend}}</h1><p>From {{publication_name}}</p><a href='https://example.com/offer' onclick="steal()">Offer</a><script>alert(1)</script></body></html>`;

  test("merge tags are filled in, scripts and handlers are removed, and an unsubscribe link is added", async () => {
    const p = await newPost({ design: "custom", custom_html: SOURCE });
    assert.equal(p.design, "custom");
    const r = (await h.call("POST", `/posts/${p.id}/preview`, {})).json.html as string;
    assert.match(r, /Hello friend/);
    assert.match(r, /From The Test Letter/);
    assert.ok(!/<script/i.test(r) && !/onclick/i.test(r));
    assert.match(r, /href="https:\/\/example\.com\/offer"/, "single-quoted links are normalised");
    assert.match(r, /\/u\/preview/, "an unsubscribe link was added");
    assert.match(r, /1 Test Street, Testville/, "and the postal address");
  });

  test("a file that already links to the unsubscribe address is left alone", async () => {
    const p = await newPost({ design: "custom", custom_html: `<html><body><p>Hi</p><a href="{{unsubscribe_url}}">Leave</a></body></html>` });
    const r = (await h.call("POST", `/posts/${p.id}/preview`, {})).json.html as string;
    assert.equal((r.match(/\/u\/preview/g) ?? []).length, 1);
  });

  test("a fragment without html or body tags still becomes a valid document", async () => {
    const p = await newPost({ design: "custom", custom_html: `<p>Just a paragraph</p>` });
    const r = (await h.call("POST", `/posts/${p.id}/preview`, {})).json.html as string;
    assert.match(r, /^<!doctype html>/i);
    assert.match(r, /<body[\s\S]*Just a paragraph[\s\S]*<\/body>/);
  });

  test("custom posts are email-only", async () => {
    const p = await newPost({ design: "custom", custom_html: SOURCE });
    assert.equal(p.web_enabled, false);
    assert.equal((await h.call("PATCH", `/posts/${p.id}`, { web_enabled: true })).status, 422);
    const q = await newPost({ web_enabled: true });
    assert.equal((await h.call("PATCH", `/posts/${q.id}`, { design: "custom", custom_html: SOURCE })).json.web_enabled, false, "switching to custom turns the website version off");
  });

  test("it can't be sent empty, and is limited in size", async () => {
    const p = await newPost({ design: "custom", custom_html: "  " });
    assert.equal((await h.call("POST", `/posts/${p.id}/schedule`, {})).status, 409);
    assert.equal((await h.call("PATCH", `/posts/${p.id}`, { custom_html: "x".repeat(500_001) })).status, 422);
  });

  test("sending delivers a personalised, tracked copy to each subscriber", async () => {
    await h.call("POST", "/subscribers", { email: "dana@example.org", fields: { first_name: "Dana" } });
    h.smtp.messages.length = 0;
    const p = await newPost({ design: "custom", subject: "Custom offer", custom_html: SOURCE });
    assert.equal((await h.call("POST", `/posts/${p.id}/schedule`, {})).status, 200);
    const mail = await h.waitFor(() => h.smtp.messages.find((m) => m.to[0] === "dana@example.org" && /Custom offer/.test(subjectOf(m.data))), 8000);
    const html = decodeBody(mail.data);
    assert.match(html, /Hello Dana/);
    assert.match(html, /href="[^"]*\/l\/lnk_[^"]+"/, "links are tracked");
    assert.match(html, /\/o\/em_[A-Za-z0-9_-]+\.gif/, "open pixel");
    assert.match(html, /\/u\/[A-Za-z0-9_-]+"/, "their own unsubscribe link");
    assert.ok(!/<script/i.test(html));
  });
});
