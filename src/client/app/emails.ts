import { api } from "./api.js";
import { h } from "./dom.js";
import { confirmDialog } from "./controls.js";
import { ago, badge, busy, empty, fullDate, pageHead, toast, toneOf } from "./ui.js";

export async function emailList(query: URLSearchParams = new URLSearchParams()): Promise<HTMLElement> {
  const kind = query.get("kind") ?? "api";
  const body = h("tbody");
  const more = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Load more");
  const foot = h("div", { class: "row", style: "padding:14px 22px;justify-content:center" }, more);
  const card = h("div", { class: "card" });
  let last: string | null = null;

  async function load(): Promise<void> {
    const page = await api("GET", `/emails?kind=${kind}&limit=25${last ? `&after=${last}` : ""}`);
    for (const e of page.data) {
      body.append(h("tr", { class: "link", onclick: () => { location.hash = `#/emails/${e.id}`; } },
        h("td", { class: "clip" }, e.to.join(", ")),
        h("td", { class: "clip" }, e.subject),
        h("td", {}, badge(e.last_event)),
        h("td", { class: "muted small", title: fullDate(e.created_at) }, e.scheduled_at ? `for ${fullDate(e.scheduled_at)}` : ago(e.created_at))));
      last = e.id;
    }
    foot.style.display = page.has_more ? "" : "none";
    if (!body.children.length) card.replaceChildren(empty("No emails yet", "Send one from the dashboard or with the API."));
  }
  more.addEventListener("click", () => void busy(more, load));
  card.append(h("div", { class: "table-scroll" }, h("table", { class: "t" },
    h("thead", {}, h("tr", {}, h("th", {}, "To"), h("th", {}, "Subject"), h("th", {}, "Status"), h("th", {}, "When"))), body)), foot);
  await load();

  const kindSelect = h("select", { class: "select", style: "width:auto", "aria-label": "Kind", onchange: (e: Event) => { location.hash = `#/emails?kind=${(e.target as HTMLSelectElement).value}`; } },
    ...[["api", "API and dashboard"], ["broadcast", "Newsletter issues"], ["automation", "Automations"], ["system", "Confirmations and welcomes"], ["all", "Everything"]].map(([v, l]) => h("option", { value: v, selected: v === kind }, l)));
  kindSelect.value = kind;
  return h("div", { class: "view stack" }, pageHead("Emails", "Everything sent through this instance, newest first.", kindSelect, h("a", { class: "btn btn-solid", href: "#/send" }, "Send an email")), card);
}

export async function emailDetail(id: string): Promise<HTMLElement> {
  const [e, ev] = await Promise.all([api("GET", `/emails/${encodeURIComponent(id)}`), api("GET", `/emails/${encodeURIComponent(id)}/events`)]);

  const untouched = e.deliveries.every((d: any) => (d.status === "queued" || d.status === "suppressed") && d.attempts === 0);
  const cancel = h("button", { class: "btn btn-danger btn-sm", type: "button" }, "Cancel sending");
  cancel.addEventListener("click", () => void busy(cancel, async () => {
    if (!(await confirmDialog("Cancel this email? It won't be sent.", { title: "Cancel email", confirm: "Cancel sending" }))) return;
    await api("POST", `/emails/${e.id}/cancel`);
    toast("Canceled");
    location.reload();
  }));

  const panels: Record<string, HTMLElement> = {
    Preview: h("iframe", { class: "preview", sandbox: "", srcdoc: e.html, title: "Email preview", style: "border:0;border-radius:0 0 14px 14px;min-height:480px" }),
    "Plain text": h("pre", { class: "pre" }, e.text),
    Events: h("ol", { class: "timeline" }, ev.data.map((x: any) =>
      h("li", { class: toneOf(x.type) }, h("span", {}, badge(x.type).textContent, x.to ? h("span", { class: "muted" }, ` · ${x.to}`) : null,
        x.data?.message ? h("div", { class: "muted small mono" }, x.data.message) : null), h("span", { class: "when", title: fullDate(x.created_at) }, ago(x.created_at))))),
    Deliveries: h("div", { class: "table-scroll" }, h("table", { class: "t" },
      h("thead", {}, h("tr", {}, h("th", {}, "Recipient"), h("th", {}, "Status"), h("th", { class: "num" }, "Attempts"), h("th", {}, "Detail"))),
      h("tbody", {}, e.deliveries.map((d: any) => h("tr", {}, h("td", {}, d.to), h("td", {}, d.status), h("td", { class: "num" }, String(d.attempts)),
        h("td", { class: "muted small mono clip" }, d.error ?? d.response ?? "—")))))),
  };

  const tabs = h("div", { class: "tabs", role: "tablist" });
  const stage = h("div");
  const select = (name: string): void => {
    tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.textContent === name)));
    stage.replaceChildren(panels[name]);
  };
  for (const name of Object.keys(panels)) tabs.append(h("button", { class: "tab", role: "tab", type: "button", onclick: () => select(name) }, name));
  select("Preview");

  return h("div", { class: "view stack" },
    h("a", { class: "crumb", href: "#/emails" }, "← Emails"),
    pageHead(e.subject, undefined, badge(e.last_event), untouched && cancel),
    h("div", { class: "card" }, h("dl", { class: "meta" },
      h("dt", {}, "From"), h("dd", {}, e.from),
      h("dt", {}, "To"), h("dd", {}, e.to.join(", ")),
      e.cc.length ? [h("dt", {}, "Cc"), h("dd", {}, e.cc.join(", "))] : null,
      e.bcc.length ? [h("dt", {}, "Bcc"), h("dd", {}, e.bcc.join(", "))] : null,
      h("dt", {}, e.scheduled_at ? "Scheduled" : "Created"), h("dd", {}, fullDate(e.scheduled_at ?? e.created_at)),
      h("dt", {}, "Message ID"), h("dd", { class: "mono" }, e.message_id),
      e.tags.length ? [h("dt", {}, "Tags"), h("dd", {}, e.tags.map((t: any) => `${t.name}=${t.value}`).join(", "))] : null,
    )),
    h("div", { class: "card", style: "overflow:hidden" }, tabs, stage),
  );
}
