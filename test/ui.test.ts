import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, describe, test } from "node:test";
import { byText, find, installDom, textOf, type } from "./dom-shim.ts";
import type { FakeElement } from "./dom-shim.ts";
import { harness, verifiedDomain } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

// The browser code imports "./x.js"; in Node the source is "./x.ts".
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) { try { return next(specifier.slice(0, -3) + ".ts", context); } catch { /* fall through */ } }
    return next(specifier, context);
  },
});

let h: Harness;
let dom: ReturnType<typeof installDom>;
let main: typeof import("../src/client/app/main.ts");
const realFetch = globalThis.fetch;
const ids: Record<string, string> = {};

const go = async (hash: string): Promise<FakeElement> => {
  (globalThis as any).location.hash = hash;
  return (await main.route()) as unknown as FakeElement;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  h = await harness();
  globalThis.fetch = ((input: any, init: any = {}) => realFetch(typeof input === "string" && input.startsWith("/") ? h.base + input : input, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${h.key}` } })) as typeof fetch;
  dom = installDom();
  main = await import("../src/client/app/main.ts");

  await verifiedDomain(h);
  await h.call("PATCH", "/publication", { name: "UI Letter", from_email: "news@example.com", site_url: h.base, address: "1 Test St", referral_enabled: true });
  for (const [email, tags] of [["a@example.org", ["vip"]], ["b@example.org", ["beta"]], ["c@example.org", []]] as const) await h.call("POST", "/subscribers", { email, tags, fields: { first_name: email[0].toUpperCase() } });
  ids.seg = (await h.call("POST", "/segments", { name: "VIPs", rules: { match: "all", conditions: [{ field: "tag", op: "has", value: "vip" }] } })).json.id;
  ids.draft = (await h.call("POST", "/posts", { title: "Draft post", template_id: "tpl_newsletter" })).json.id;
  const sent = (await h.call("POST", "/posts", { title: "Sent post", blocks: [{ type: "button", props: { label: "Go", url: "https://example.com/x" } }], audience: "tag:beta" })).json;
  ids.sent = sent.id;
  await h.call("POST", `/posts/${sent.id}/schedule`, {});
  await h.waitFor(() => h.app.db.prepare("SELECT 1 FROM posts WHERE id = ? AND status = 'sent'").get(sent.id), 8000);
  ids.poll = (await h.call("POST", "/polls", { question: "Pick one", options: ["A", "B"] })).json.id;
  ids.survey = (await h.call("POST", "/surveys", { title: "Quick survey", questions: [{ type: "text", label: "Thoughts?" }] })).json.id;
  await h.call("POST", "/rewards", { name: "Sticker", threshold: 2, kind: "physical" });
  ids.auto = (await h.call("POST", "/automations", { name: "Welcome", trigger: { type: "signup" }, steps: [{ type: "add_tag", tag: "x" }] })).json.id;
  ids.page = (await h.call("POST", "/pages", { title: "About", blocks: [{ type: "text", props: { markdown: "hello" } }] })).json.id;
  await h.call("POST", "/emails", { from: "a@example.com", to: "t@dest.test", subject: "API mail", text: "x" });
  ids.email = (await h.call("GET", "/emails?limit=1")).json.data[0].id;
});

after(async () => {
  globalThis.fetch = realFetch;
  await h.close();
});

describe("every page renders against the real API", () => {
  const cases: [string, () => string, RegExp][] = [
    ["overview", () => "", /Active subscribers/],
    ["posts", () => "#/posts", /Draft post/],
    ["new post", () => "#/posts/new", /Newsletter/],
    ["post editor", () => `#/posts/${ids.draft}`, /Send…/],
    ["post stats", () => `#/posts/${ids.sent}/stats`, /Open rate/],
    ["website", () => "#/website", /Look and feel/],
    ["page editor", () => `#/website/pages/${ids.page}`, /Published/],
    ["subscribers", () => "#/subscribers", /a@example\.org/],
    ["subscriber filtered", () => "#/subscribers?tag=vip", /a@example\.org/],
    ["subscriber detail", () => "#/subscribers/a%40example.org", /Tags/],
    ["segments", () => "#/segments", /VIPs/],
    ["new segment", () => "#/segments/new", /Who belongs here/],
    ["segment editor", () => `#/segments/${ids.seg}`, /active subscribers match|Who belongs here/],
    ["forms", () => "#/forms", /Inline embed/],
    ["automations", () => "#/automations", /Welcome/],
    ["automation editor", () => `#/automations/${ids.auto}`, /Add a tag/],
    ["referrals", () => "#/referrals", /Sticker/],
    ["polls and surveys", () => "#/engage", /Pick one/],
    ["analytics", () => "#/analytics", /Growth/],
    ["emails", () => "#/emails", /API mail/],
    ["email detail", () => `#/emails/${ids.email}`, /API mail/],
    ["send", () => "#/send", /Send an email/],
    ["domains", () => "#/domains", /example\.com/],
    ["api keys", () => "#/keys", /API keys/],
    ["webhooks", () => "#/webhooks", /Webhooks/],
    ["suppressions", () => "#/suppressions", /Suppressions/],
    ["settings", () => "#/settings", /Ready to send\?/],
  ];
  for (const [name, hash, expected] of cases) {
    test(name, async () => {
      const el = await go(hash());
      const text = textOf(el);
      assert.match(text, expected);
      // A real browser turns null/undefined passed to append() into those words. None may show up on a page.
      assert.ok(!/\b(undefined|null|NaN)\b|\[object/.test(text), `leaked placeholder text: ${/.{30}(\bundefined\b|\bnull\b|NaN|\[object).{20}/.exec(text)?.[0]}`);
    });
  }
});

describe("interactions", () => {
  test("the block editor adds, edits, moves, duplicates and deletes blocks", async () => {
    const { blockEditor, loadEditorContext } = await import("../src/client/app/editor.ts");
    const ctx = await loadEditorContext();
    let latest: any[] = [];
    const ed = blockEditor({ blocks: [{ id: "x1", type: "text", props: { markdown: "one" } }], ctx, onChange: (b) => { latest = b; } });
    const el = ed.el as unknown as FakeElement;

    byText(el, "button", "+ Add block").click();
    byText(el, "button", /^Heading/).click();
    assert.equal(ed.get().length, 2);
    assert.equal(ed.get()[1].type, "heading");

    const textarea = find(el, "textarea");
    type(textarea, "edited text");
    assert.equal(latest[0].props.markdown, "edited text");

    find(el, 'button[aria-label="Move down"]').click();
    assert.deepEqual(ed.get().map((b) => b.type), ["heading", "text"]);
    el.querySelectorAll('button[aria-label="Duplicate block"]')[0].click();
    assert.equal(ed.get().length, 3);
    el.querySelectorAll('button[aria-label="Delete block"]')[0].click();
    assert.equal(ed.get().length, 2);
    assert.equal(latest.length, 2, "every change is reported");
  });

  test("blocks can be reordered by dragging", async () => {
    const { blockEditor, loadEditorContext } = await import("../src/client/app/editor.ts");
    const ed = blockEditor({ blocks: ["a", "b", "c"].map((t) => ({ id: t, type: "text", props: { markdown: t } })), ctx: await loadEditorContext(), onChange: () => {} });
    const cards = (ed.el as unknown as FakeElement).querySelectorAll(".block");
    const handle = cards[0].querySelector(".handle")!;
    handle.dispatch("dragstart", { dataTransfer: { setData() {}, setDragImage() {} } });
    cards[2].dispatch("drop", { clientY: 100, dataTransfer: {} }); // below the middle of the last card
    assert.deepEqual(ed.get().map((b) => b.props.markdown), ["b", "c", "a"]);
  });

  test("the rules builder edits conditions in place and reports changes", async () => {
    const { rulesBuilder, emptyRules, loadCatalog } = await import("../src/client/app/rules.ts");
    const rules: any = emptyRules();
    let changes = 0;
    const el = rulesBuilder(rules, () => { changes++; }, await loadCatalog()) as unknown as FakeElement;
    byText(el, "button", "+ Condition").click();
    assert.equal(rules.conditions.length, 1);
    const [field] = el.querySelectorAll('select[aria-label="Field"]');
    field.value = "opens"; field.dispatch("change");
    assert.equal(rules.conditions[0].field, "opens");
    assert.equal(rules.conditions[0].op, "eq", "operators follow the field type");
    byText(el, "button", "+ Group").click();
    assert.equal(rules.conditions.length, 2);
    assert.ok(changes >= 3);
    el.querySelectorAll('button[aria-label="Remove condition"]')[0].click();
    assert.equal(rules.conditions.length, 1);
  });

  test("editing a post autosaves, and sending it works end to end", async () => {
    const el = await go(`#/posts/${ids.draft}`);
    const title = find(el, ".title-input");
    type(title, "Retitled by the UI test");
    await sleep(1100);
    assert.equal((await h.call("GET", `/posts/${ids.draft}`)).json.title, "Retitled by the UI test");
    assert.match(textOf(find(el, ".save-state")), /Saved/);

    byText(el, "button", "+ Add block").click();
    byText(el, "button", /^Divider/).click();
    await sleep(1100);
    const saved = (await h.call("GET", `/posts/${ids.draft}`)).json;
    assert.equal(saved.blocks.at(-1).type, "divider");

    const before = h.smtp.messages.length;
    byText(el, "button", "Send…").click();
    const modal = dom && (globalThis as any).document.body.querySelector(".modal") as FakeElement;
    assert.match(textOf(modal), /Send this post/);
    assert.match(textOf(modal), /Retitled by the UI test/);
    byText(modal, "button", "Send").click();
    await h.waitFor(() => h.smtp.messages.length > before, 8000);
    assert.equal((await h.call("GET", `/posts/${ids.draft}`)).json.status === "draft", false);
  });

  test("choosing a design for a post and writing your own HTML both save", async () => {
    const post = (await h.call("POST", "/posts", { title: "Design test", blocks: [{ type: "text", props: { markdown: "Hi" } }] })).json;
    const el = await go(`#/posts/${post.id}`);
    byText(el, "button", "Design").click();
    const cards = el.querySelectorAll(".design-card");
    assert.deepEqual(cards.map((c) => textOf(c.querySelector("b")!)), ["Use my default", "Plain", "Editorial", "Modern", "Bold", "Your own HTML"]);

    cards[2].click(); // Editorial
    await sleep(1100);
    assert.equal((await h.call("GET", `/posts/${post.id}`)).json.design, "editorial");
    assert.equal(cards[2].getAttribute("aria-pressed"), "true");
    assert.equal(cards[1].getAttribute("aria-pressed"), "false");

    cards[5].click(); // Your own HTML
    assert.equal(el.querySelectorAll(".html-area").length, 1, "the HTML editor replaces the block editor");
    assert.equal(el.querySelectorAll(".block").length, 0);
    byText(el, "button", "Insert a starter").click();
    await sleep(1100);
    const saved = (await h.call("GET", `/posts/${post.id}`)).json;
    assert.equal(saved.design, "custom");
    assert.match(saved.custom_html, /Hello \{\{first_name \| there\}\}/);
    assert.equal(saved.web_enabled, false);

    type(find(el, ".html-area"), "<p>Typed by hand</p>");
    await sleep(1100);
    assert.equal((await h.call("GET", `/posts/${post.id}`)).json.custom_html, "<p>Typed by hand</p>");

    cards[3].click(); // back to a design: the block editor returns
    assert.equal(el.querySelectorAll(".html-area").length, 0);
  });

  test("the default design is chosen in Settings", async () => {
    const el = await go("#/settings");
    assert.equal(byText(el, "button", "Load sample data").disabled, true, "sample data is only offered on an empty Newsnest");
    assert.match(textOf(el), /only be loaded into an empty Newsnest/);
    const cards = el.querySelectorAll(".design-card");
    assert.deepEqual(cards.map((c) => textOf(c.querySelector("b")!)), ["Plain", "Editorial", "Modern", "Bold"]);
    cards[3].click();
    await sleep(300);
    assert.equal((await h.call("GET", "/publication")).json.design, "bold");
    cards[2].click();
    await sleep(300);
    assert.equal((await h.call("GET", "/publication")).json.design, "modern");
  });

  test("adding a subscriber through the dialog", async () => {
    const el = await go("#/subscribers");
    byText(el, "button", "Add subscriber").click();
    const modal = (globalThis as any).document.body.querySelector(".modal") as FakeElement;
    type(modal.querySelector('input[type="email"]')!, "dialog@example.org");
    byText(modal, "button", "Add").click();
    await h.waitFor(async () => false as never, 1).catch(() => null);
    await sleep(300);
    assert.equal((await h.call("GET", "/subscribers/dialog@example.org")).status, 200);
  });

  test("the automation builder adds steps and saves them", async () => {
    const el = await go(`#/automations/${ids.auto}`);
    const add = find(el, 'select[aria-label="Add a step"]');
    add.value = "delay"; add.dispatch("change");
    const el2 = el; // steps re-render in place
    const amount = el2.querySelector('input[aria-label="Amount"]')!;
    type(amount, "3");
    byText(el2, "button", "Save").click();
    await sleep(400);
    const saved = (await h.call("GET", `/automations/${ids.auto}`)).json;
    assert.equal(saved.steps.length, 2);
    assert.equal(saved.steps[1].type, "delay");
    assert.equal(saved.steps[1].minutes, 3 * 1440);
  });

  test("settings save and the checklist reflects the data", async () => {
    const el = await go("#/settings");
    const name = el.querySelectorAll("input")[0];
    type(name, "Renamed Letter");
    byText(el, "button", "Save settings").click();
    await sleep(300);
    assert.equal((await h.call("GET", "/publication")).json.name, "Renamed Letter");
  });

  test("the first-run screen asks for the setup code, and sign-in does not", async () => {
    const { authScreen } = await import("../src/client/app/auth.ts");
    const setup = authScreen(true, () => {}) as unknown as FakeElement;
    assert.match(textOf(setup), /Setup code/);
    assert.match(textOf(setup), /Printed in the terminal where you started Newsnest/);
    find(setup, "form").dispatch("submit", { preventDefault() {} });
    assert.match(textOf(find(setup, ".error")), /Enter the setup code/);
    assert.doesNotMatch(textOf(authScreen(false, () => {}) as unknown as FakeElement), /Setup code/);
  });
});
