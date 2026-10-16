import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { before, describe, test } from "node:test";
import { byText, installDom } from "./dom-shim.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) { try { return next(specifier.slice(0, -3) + ".ts", context); } catch { /* fall through */ } }
    return next(specifier, context);
  },
});

const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.(ts|js|html)$/.test(e.name)).map((e) => `${e.parentPath}/${e.name}`);
const sources = [...files("src/client"), ...files("public").filter((f) => !f.includes("/fonts/")), ...files("src/server/newsletter")];

describe("nothing the browser draws itself", () => {
  test("no alert, confirm or prompt calls", () => {
    for (const f of sources) {
      const text = readFileSync(f, "utf8");
      assert.ok(!/(?<![.\w])(alert|confirm|prompt)\(/.test(text.replace(/await confirmDialog\(|const confirm = /g, "")), `${f} calls a native dialog`);
    }
  });

  test("no native pickers, validation or tooltips", () => {
    for (const f of sources) {
      const text = readFileSync(f, "utf8");
      const picker = f.startsWith("src/server") ? /type=\\?"(date|datetime-local|time|month|week|color|range)\\?"/ : /type:\s*"(date|datetime-local|time|month|week|color|range)"/;
      assert.ok(!picker.test(text), `${f} uses a native picker`);
      assert.ok(!/<datalist|<select/.test(text.replace(/"\s*\+\s*"/g, "")) || f.endsWith("controls.ts"), `${f} renders a native list`);
      if (f.includes("src/server")) assert.ok(!/<input[^>]*\brequired\b/.test(text), `${f} has a required attribute that triggers the browser's validation bubble`);
    }
  });

  test("every public form skips the browser's validation", () => {
    for (const f of files("src/server/newsletter")) {
      for (const tag of readFileSync(f, "utf8").match(/<form\b[^>]*>/g) ?? []) assert.ok(/novalidate/.test(tag), `${f}: ${tag}`);
    }
  });
});

describe("custom dialogs", () => {
  let controls: typeof import("../src/client/app/controls.ts");
  before(async () => { installDom(); controls = await import("../src/client/app/controls.ts"); });

  test("confirmDialog resolves true only on the confirm button", async () => {
    const yes = controls.confirmDialog("Delete it?", { confirm: "Delete" });
    byText(document.body as any, "button", "Delete").click();
    assert.equal(await yes, true);

    const no = controls.confirmDialog("Delete it?");
    byText(document.body as any, "button", "Cancel").click();
    assert.equal(await no, false);
  });

  test("promptDialog returns the text, or null when cancelled", async () => {
    const asked = controls.promptDialog("New page", "Title", "About");
    byText(document.body as any, "button", "Create").click();
    assert.equal(await asked, "About");

    const cancelled = controls.promptDialog("New page", "Title");
    byText(document.body as any, "button", "Cancel").click();
    assert.equal(await cancelled, null);
  });

  test("the date picker keeps an empty value until a day and time are chosen", () => {
    const when = controls.dateTimeField();
    assert.equal(when.value, "");
    when.value = "2030-01-02T09:30";
    assert.equal(when.value, "2030-01-02T09:30");
    when.disabled = true;
    assert.equal(when.disabled, true);
  });
});
