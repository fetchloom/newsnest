import { api } from "./api.js";
import { h } from "./dom.js";
import { confirmDialog } from "./controls.js";
import { ago, busy, copyButton, empty, fullDate, pageHead, toast } from "./ui.js";

export async function keysPage(): Promise<HTMLElement> {
  const domains = (await api("GET", "/domains")).data as { id: string; name: string }[];
  const tableHost = h("div");
  const banner = h("div");

  const name = h("input", { class: "input", placeholder: "e.g. my website", required: true, maxLength: 100 });
  const permission = h("select", { class: "select" }, h("option", { value: "full" }, "Full access"), h("option", { value: "sending" }, "Sending only"));
  const domain = h("select", { class: "select" }, h("option", { value: "" }, "Any domain"), domains.map((d) => h("option", { value: d.id }, d.name)));
  const create = h("button", { class: "btn btn-solid", type: "submit" }, "Create key");
  const error = h("div", { class: "error", role: "alert" });

  async function draw(): Promise<void> {
    const keys = (await api("GET", "/api-keys")).data as any[];
    tableHost.replaceChildren(keys.length
      ? h("div", { class: "table-scroll" }, h("table", { class: "t" },
          h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Key"), h("th", {}, "Access"), h("th", {}, "Last used"), h("th", {}))),
          h("tbody", {}, keys.map((k) => {
            const revoke = h("button", { class: "btn btn-danger btn-sm", type: "button" }, "Revoke");
            revoke.addEventListener("click", () => void busy(revoke, async () => {
              if (!(await confirmDialog(`Revoke "${k.name}"? Anything using it stops working immediately.`, { title: "Revoke API key", confirm: "Revoke" }))) return;
              await api("DELETE", `/api-keys/${k.id}`);
              await draw();
            }));
            const scope = k.permission === "full" ? "Full access" : k.domain_id ? `Sending · ${domains.find((d) => d.id === k.domain_id)?.name ?? "one domain"}` : "Sending only";
            return h("tr", {}, h("td", {}, k.name), h("td", {}, h("code", { class: "v" }, `${k.prefix}…`)), h("td", {}, scope),
              h("td", { class: "muted small", title: fullDate(k.last_used_at) }, k.last_used_at ? ago(k.last_used_at) : "never"), h("td", {}, revoke));
          }))))
      : empty("No API keys", "Create one to send email from your own code."));
  }

  const form = h("form", { class: "form", onsubmit: (e: Event) => {
    e.preventDefault();
    error.textContent = "";
    void busy(create, async () => {
      try {
        const k = await api("POST", "/api-keys", { name: name.value, permission: permission.value, domain_id: domain.value || undefined });
        name.value = "";
        banner.replaceChildren(h("div", { class: "notice ok", style: "display:block" },
          h("b", {}, "Copy your key now."), " It's shown once and only a hash is stored.",
          h("div", { class: "secret" }, h("span", { class: "grow" }, k.key), copyButton(k.key))));
        toast("Key created");
        await draw();
      } catch (err) { error.textContent = (err as Error).message; }
    });
  } },
    h("div", { class: "row" }, h("div", { class: "field grow" }, h("label", {}, "Name"), name), h("div", { class: "field" }, h("label", {}, "Access"), permission)),
    h("div", { class: "field" }, h("label", {}, "Limit to a domain"), domain, h("span", { class: "hint" }, "Only for sending keys.")),
    error, h("div", { class: "row" }, create));

  permission.addEventListener("change", () => { domain.disabled = permission.value !== "sending"; if (domain.disabled) domain.value = ""; });
  domain.disabled = true;

  await draw();
  return h("div", { class: "view stack" }, pageHead("API keys", "Use a key as Authorization: Bearer … when calling the API."),
    banner, h("div", { class: "card card-pad" }, form), h("div", { class: "card" }, tableHost));
}
