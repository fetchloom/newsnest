import { api } from "./api.js";
import { esc } from "./esc.js";
import { h } from "./dom.js";
import { dateTimeField } from "./controls.js";
import { busy, pageHead, toast } from "./ui.js";

const LAST_FROM = "newsnest:last-from";
const list = (v: string): string[] => v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

export async function sendPage(): Promise<HTMLElement> {
  const domains = (await api("GET", "/domains")).data as { name: string; status: string }[];
  let remembered = "";
  try { remembered = localStorage.getItem(LAST_FROM) ?? ""; } catch { /* storage blocked */ }

  const from = h("input", { class: "input", list: "from-options", placeholder: `Name <you@${domains[0]?.name ?? "yourdomain.com"}>`, required: true, value: remembered });
  const to = h("input", { class: "input", placeholder: "someone@example.com, another@example.com", required: true });
  const cc = h("input", { class: "input", placeholder: "Optional" });
  const bcc = h("input", { class: "input", placeholder: "Optional" });
  const subject = h("input", { class: "input", required: true, maxLength: 998 });
  const format = h("select", { class: "select" }, h("option", { value: "markdown" }, "Markdown"), h("option", { value: "html" }, "HTML"), h("option", { value: "text" }, "Plain text"));
  const body = h("textarea", { class: "textarea", required: true, placeholder: "# Hello\n\nWrite in **Markdown**.\n\n[[A button]](https://example.com)" });
  const when = dateTimeField("Send now"); // empty means now
  const error = h("div", { class: "error", role: "alert" });
  const submit = h("button", { class: "btn btn-solid", type: "submit" }, "Send");
  const preview = h("iframe", { class: "preview", sandbox: "", title: "Preview" });

  let timer: number | undefined;
  const refresh = (): void => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (!body.value.trim()) { preview.srcdoc = ""; return; }
      if (format.value === "html") preview.srcdoc = body.value;
      else if (format.value === "text") preview.srcdoc = `<pre style="font:14px/1.6 ui-monospace,monospace;white-space:pre-wrap;padding:16px">${esc(body.value)}</pre>`;
      else { try { preview.srcdoc = (await api("POST", "/preview", { markdown: body.value })).html; } catch { /* keep the last preview */ } }
    }, 350);
  };
  body.addEventListener("input", refresh);
  format.addEventListener("change", refresh);

  const form = h("form", { class: "form", onsubmit: (ev: Event) => {
    ev.preventDefault();
    error.textContent = "";
    void busy(submit, async () => {
      const payload: Record<string, unknown> = { from: from.value.trim(), to: list(to.value), subject: subject.value, [format.value]: body.value };
      if (list(cc.value).length) payload.cc = list(cc.value);
      if (list(bcc.value).length) payload.bcc = list(bcc.value);
      if (when.value) payload.scheduled_at = new Date(when.value).toISOString();
      try {
        const res = await api("POST", "/emails", payload);
        try { localStorage.setItem(LAST_FROM, from.value.trim()); } catch { /* storage blocked */ }
        toast(when.value ? "Scheduled" : "Queued");
        location.hash = `#/emails/${res.id}`;
      } catch (e) { error.textContent = (e as Error).message; }
    });
  } },
    h("div", { class: "field" }, h("label", {}, "From"), from,
      h("datalist", { id: "from-options" }, domains.map((d) => h("option", { value: `hello@${d.name}` }))),
      !domains.length && h("span", { class: "hint" }, "No domain yet. In outbox mode any address works; otherwise add one under Domains.")),
    h("div", { class: "field" }, h("label", {}, "To"), to, h("span", { class: "hint" }, "Separate several addresses with commas.")),
    h("details", { class: "more" }, h("summary", {}, "Cc and Bcc"), h("div", { class: "form" }, h("div", { class: "field" }, h("label", {}, "Cc"), cc), h("div", { class: "field" }, h("label", {}, "Bcc"), bcc))),
    h("div", { class: "field" }, h("label", {}, "Subject"), subject),
    h("div", { class: "field" }, h("div", { class: "row" }, h("label", { class: "grow" }, "Message"), format), body),
    h("div", { class: "field" }, h("label", {}, "Send later (optional)"), when, h("span", { class: "hint" }, "Up to 30 days ahead. Leave empty to send now.")),
    error,
    h("div", { class: "row" }, submit),
  );

  return h("div", { class: "view stack" }, pageHead("Send an email", "Compose and send through your own instance."),
    h("div", { class: "compose" }, h("div", { class: "card card-pad" }, form), h("div", { class: "card", style: "overflow:hidden" }, preview)));
}
