import { api } from "./api.js";
import { h } from "./dom.js";
import { confirmDialog } from "./controls.js";
import { ago, badge, busy, copyButton, empty, pageHead, toast } from "./ui.js";

export async function domainsPage(): Promise<HTMLElement> {
  const wrap = h("div", { class: "stack" });
  const name = h("input", { class: "input", placeholder: "yourdomain.com", required: true });
  const add = h("button", { class: "btn btn-solid", type: "submit" }, "Add domain");
  const error = h("div", { class: "error", role: "alert" });

  async function draw(): Promise<void> {
    const list = (await api("GET", "/domains")).data as any[];
    wrap.replaceChildren(...(list.length ? list.map(card) : [h("div", { class: "card" }, empty("No domains yet", "Add the domain you want to send from."))]));
  }

  function card(d: any): HTMLElement {
    const verify = h("button", { class: "btn btn-solid btn-sm", type: "button" }, "Check DNS");
    verify.addEventListener("click", () => void busy(verify, async () => {
      const r = await api("POST", `/domains/${d.id}/verify`);
      toast(r.status === "verified" ? "DKIM record found. Domain verified." : "DKIM record not found yet. DNS can take a while to update.", r.status === "verified" ? "ok" : "bad");
      await draw();
    }));
    const del = h("button", { class: "btn btn-danger btn-sm", type: "button" }, "Remove");
    del.addEventListener("click", () => void busy(del, async () => {
      if (!(await confirmDialog(`Remove ${d.name}? Its DKIM key is deleted and keys limited to it stop working.`, { title: "Remove domain", confirm: "Remove" }))) return;
      await api("DELETE", `/domains/${d.id}`);
      await draw();
    }));

    return h("div", { class: "card" },
      h("div", { class: "card-head" },
        h("div", { class: "row" }, h("h2", {}, d.name), badge(d.status)),
        h("div", { class: "row" }, h("span", { class: "muted small" }, d.checked_at ? `checked ${ago(d.checked_at)}` : "not checked yet"), verify, del)),
      h("div", { class: "table-scroll" }, h("table", { class: "t" },
        h("thead", {}, h("tr", {}, h("th", {}, "Record"), h("th", {}, "Type"), h("th", {}, "Host"), h("th", {}, "Value"), h("th", {}, "Status"), h("th", {}))),
        h("tbody", {}, d.records.map((r: any) => h("tr", {},
          h("td", {}, r.record, !r.required && h("span", { class: "muted small" }, " (recommended)")),
          h("td", { class: "mono" }, r.type),
          h("td", {}, h("code", { class: "v" }, r.name)),
          h("td", { style: "max-width:340px" }, h("code", { class: "v" }, r.value)),
          h("td", {}, badge(r.status)),
          h("td", {}, copyButton(r.value))))))),
      h("p", { class: "hint", style: "padding:14px 22px" }, `Add these at your DNS provider. Some providers want the full host, for example ${d.records[0].name}.${d.name}. Only the DKIM record is needed to verify; SPF should list the IP or relay you send from.`),
    );
  }

  const form = h("form", { class: "row", onsubmit: (e: Event) => {
    e.preventDefault();
    error.textContent = "";
    void busy(add, async () => {
      try { await api("POST", "/domains", { name: name.value }); name.value = ""; toast("Domain added. Publish the DNS records below."); await draw(); }
      catch (err) { error.textContent = (err as Error).message; }
    });
  } }, h("div", { class: "grow" }, name), add);

  await draw();
  return h("div", { class: "view stack" }, pageHead("Domains", "Mail is signed with DKIM for each domain you add."), h("div", { class: "card card-pad stack" }, form, error), wrap);
}
