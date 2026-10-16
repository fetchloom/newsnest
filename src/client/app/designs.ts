import { api } from "./api.js";
import { h, icon } from "./dom.js";
import { filePicker } from "./controls.js";
import { toast } from "./ui.js";

interface DesignInfo { id: string; name: string; description: string }

export interface PickerOptions {
  current: string;
  /** Adds "Use my default design" (for a single post). */
  defaultName?: string;
  /** Adds "Your own HTML". */
  allowCustom?: boolean;
  wide?: boolean;
  onPick(id: string): void;
}

/** Cards that show each design with a live sample of the publication's own colours. */
export async function designPicker(o: PickerOptions): Promise<HTMLElement> {
  const list: DesignInfo[] = (await api("GET", "/designs")).data;
  const samples = await Promise.all(list.map((d) => api("POST", "/designs/sample", { design: d.id }).then((r) => r.html as string, () => "")));

  const cards: [string, HTMLElement][] = [];
  const card = (id: string, name: string, desc: string, thumb: HTMLElement): HTMLElement => {
    const el = h("button", { class: "design-card", type: "button", "aria-pressed": String(o.current === id), onclick: () => pick(id) },
      thumb, h("b", {}, name), h("span", {}, desc));
    cards.push([id, el]);
    return el;
  };
  const pick = (id: string): void => {
    o.current = id;
    for (const [cid, el] of cards) el.setAttribute("aria-pressed", String(cid === id));
    o.onPick(id);
  };

  const all: HTMLElement[] = [];
  if (o.defaultName) all.push(card("", "Use my default", `Currently ${o.defaultName}. Change it in Settings.`, h("div", { class: "design-thumb plain-thumb" }, icon("M5 12l5 5 9-10"))));
  list.forEach((d, i) => all.push(card(d.id, d.name, d.description, h("div", { class: "design-thumb" }, h("iframe", { srcdoc: samples[i], sandbox: "", tabindex: -1, "aria-hidden": "true", title: `${d.name} sample` })))));
  if (o.allowCustom) all.push(card("custom", "Your own HTML", "Paste or upload a complete .html email and keep full control.", h("div", { class: "design-thumb plain-thumb" }, icon("M8 8l-4 4 4 4", "M16 8l4 4-4 4", "M14 5l-4 14"))));

  return h("div", { class: `designs${o.wide ? " wide" : ""}` }, all);
}

const STARTER = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;">
        <tr><td style="padding:32px;font:16px/1.6 Arial,Helvetica,sans-serif;color:#222222;">
          <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;">Hello {{first_name | there}}</h1>
          <p style="margin:0 0 16px;">Write your email here. Use any HTML you like.</p>
          <p style="margin:0 0 24px;"><a href="https://example.com" style="display:inline-block;padding:12px 22px;background:#1663fe;color:#ffffff;text-decoration:none;border-radius:8px;">A button</a></p>
          <p style="margin:0;font-size:13px;color:#777777;"><a href="{{unsubscribe_url}}" style="color:#777777;">Unsubscribe</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
`;

const KB = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;

/** The editor for a post written as raw HTML. */
export function customHtmlEditor(S: { custom_html: string }, onChange: () => void, locked: boolean): HTMLElement {
  const area = h("textarea", { class: "textarea html-area", spellcheck: false, "aria-label": "Email HTML", placeholder: "<!doctype html>\n<html>…", disabled: locked }, S.custom_html ?? "") as HTMLTextAreaElement;
  const size = h("span", { class: "hint" });
  const showSize = (): void => {
    const n = new TextEncoder().encode(area.value).length;
    size.textContent = n ? `${KB(n)}${n > 102 * 1024 ? ". Gmail cuts off emails over 102 KB, so readers would see “View entire message”." : ""}` : "";
    size.classList.toggle("warn-text", n > 102 * 1024);
  };
  const starter = h("button", { class: "btn btn-ghost btn-sm", type: "button", disabled: locked }, "Insert a starter");
  // The starter is only offered on an empty editor, so it can never replace someone's work.
  const syncStarter = (): void => { starter.style.display = area.value.trim() ? "none" : ""; };
  const set = (v: string): void => { S.custom_html = v; area.value = v; showSize(); syncStarter(); onChange(); };
  starter.addEventListener("click", () => set(STARTER));
  area.addEventListener("input", () => { S.custom_html = area.value; showSize(); syncStarter(); onChange(); });
  showSize();
  syncStarter();

  const upload = filePicker(".html,.htm,text/html", "Upload an .html file…", (text, name) => {
    if (text.length > 500_000) { toast("That file is too large (500,000 characters at most).", "bad"); return; }
    set(text); toast(`Loaded ${name}`);
  });

  return h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Your HTML"), h("div", { class: "row" }, starter, upload)),
    h("div", { class: "card-pad stack" },
      area, size,
      h("details", { class: "more" }, h("summary", {}, "What happens to my HTML?"),
        h("div", { class: "stack small muted" },
          h("p", {}, "Merge tags are filled in for each reader: ", h("code", { class: "v" }, "{{first_name | friend}}"), ", ", h("code", { class: "v" }, "{{email}}"), ", ", h("code", { class: "v" }, "{{unsubscribe_url}}"), ", ", h("code", { class: "v" }, "{{referral_link}}"), "."),
          h("p", {}, "Links are tracked and an open pixel is added, as in any other post. Scripts and event handlers are removed because email apps ignore them."),
          h("p", {}, "If your file has no link to ", h("code", { class: "v" }, "{{unsubscribe_url}}"), ", an unsubscribe link and your postal address are added at the bottom, so you stay compliant."),
          h("p", {}, "Use inline styles and tables for layout, and test with “Send test” in a few inboxes. Custom HTML emails are email-only: there is no website version.")))));
}
