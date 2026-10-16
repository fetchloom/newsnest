import { api } from "./api.js";
import { h } from "./dom.js";
import { ago, busy, empty, pageHead } from "./ui.js";

export async function suppressionsPage(): Promise<HTMLElement> {
  const tableHost = h("div");
  const email = h("input", { class: "input", type: "email", placeholder: "someone@example.com", required: true });
  const add = h("button", { class: "btn btn-solid", type: "submit" }, "Suppress");
  const error = h("div", { class: "error", role: "alert" });

  async function draw(): Promise<void> {
    const rows = (await api("GET", "/suppressions")).data as any[];
    tableHost.replaceChildren(rows.length
      ? h("div", { class: "table-scroll" }, h("table", { class: "t" },
          h("thead", {}, h("tr", {}, h("th", {}, "Address"), h("th", {}, "Reason"), h("th", {}, "Detail"), h("th", {}, "Added"), h("th", {}))),
          h("tbody", {}, rows.map((s) => {
            const remove = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Remove");
            remove.addEventListener("click", () => void busy(remove, async () => { await api("DELETE", `/suppressions/${encodeURIComponent(s.email)}`); await draw(); }));
            return h("tr", {}, h("td", {}, s.email), h("td", {}, s.reason), h("td", { class: "muted small clip mono" }, s.detail ?? "—"), h("td", { class: "muted small" }, ago(s.created_at)), h("td", {}, remove));
          }))))
      : empty("Nobody suppressed", "Addresses that hard-bounce are added here automatically."));
  }

  const form = h("form", { class: "row", onsubmit: (e: Event) => {
    e.preventDefault();
    error.textContent = "";
    void busy(add, async () => {
      try { await api("POST", "/suppressions", { email: email.value }); email.value = ""; await draw(); }
      catch (err) { error.textContent = (err as Error).message; }
    });
  } }, h("div", { class: "grow" }, email), add);

  await draw();
  return h("div", { class: "view stack" }, pageHead("Suppressions", "Freepost never sends to these addresses. Hard bounces land here on their own."),
    h("div", { class: "card card-pad stack" }, form, error), h("div", { class: "card" }, tableHost));
}
