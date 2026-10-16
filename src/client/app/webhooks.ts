import { api } from "./api.js";
import { h } from "./dom.js";
import { confirmDialog } from "./controls.js";
import { busy, copyButton, empty, pageHead, toast } from "./ui.js";

const EVENTS = ["email.scheduled", "email.queued", "email.sent", "email.delivered", "email.delivery_delayed", "email.opened", "email.clicked", "email.bounced", "email.failed", "email.suppressed", "email.canceled"];

export async function webhooksPage(): Promise<HTMLElement> {
  const tableHost = h("div");
  const banner = h("div");
  const url = h("input", { class: "input", type: "url", placeholder: "https://example.com/hooks/newsnest", required: true });
  const boxes = EVENTS.map((e) => h("input", { type: "checkbox", value: e }));
  const create = h("button", { class: "btn btn-solid", type: "submit" }, "Add webhook");
  const error = h("div", { class: "error", role: "alert" });

  async function draw(): Promise<void> {
    const hooks = (await api("GET", "/webhooks")).data as any[];
    tableHost.replaceChildren(hooks.length
      ? h("div", { class: "table-scroll" }, h("table", { class: "t" },
          h("thead", {}, h("tr", {}, h("th", {}, "URL"), h("th", {}, "Events"), h("th", {}, "Enabled"), h("th", {}))),
          h("tbody", {}, hooks.map((w) => {
            const toggle = h("input", { type: "checkbox", checked: w.enabled, onchange: () => void api("PATCH", `/webhooks/${w.id}`, { enabled: toggle.checked }).catch((e) => { toast((e as Error).message, "bad"); toggle.checked = !toggle.checked; }) });
            const del = h("button", { class: "btn btn-danger btn-sm", type: "button" }, "Delete");
            del.addEventListener("click", () => void busy(del, async () => {
              if (!(await confirmDialog("Delete this webhook? Nothing will be sent to it any more.", { title: "Delete webhook" }))) return;
              await api("DELETE", `/webhooks/${w.id}`);
              await draw();
            }));
            return h("tr", {}, h("td", { class: "clip" }, h("code", { class: "v" }, w.url)), h("td", { class: "muted small" }, w.events.length ? w.events.join(", ") : "all events"),
              h("td", {}, h("label", { class: "check" }, toggle)), h("td", {}, del));
          }))))
      : empty("No webhooks", "Add an endpoint to be told when emails are sent, bounce or fail."));
  }

  const form = h("form", { class: "form", onsubmit: (e: Event) => {
    e.preventDefault();
    error.textContent = "";
    void busy(create, async () => {
      try {
        const w = await api("POST", "/webhooks", { url: url.value, events: boxes.filter((b) => b.checked).map((b) => b.value) });
        url.value = ""; boxes.forEach((b) => { b.checked = false; });
        banner.replaceChildren(h("div", { class: "notice ok", style: "display:block" },
          h("b", {}, "Signing secret."), " Use it to verify the newsnest-signature header on each request.",
          h("div", { class: "secret" }, h("span", { class: "grow" }, w.secret), copyButton(w.secret))));
        await draw();
      } catch (err) { error.textContent = (err as Error).message; }
    });
  } },
    h("div", { class: "field" }, h("label", {}, "Endpoint URL"), url),
    h("div", { class: "field" }, h("span", { class: "label" }, "Events"), h("div", { class: "checks" }, EVENTS.map((ev, i) => h("label", { class: "check" }, boxes[i], ev))), h("span", { class: "hint" }, "Leave all unticked to receive every event.")),
    error, h("div", { class: "row" }, create));

  await draw();
  return h("div", { class: "view stack" }, pageHead("Webhooks", "Signed HTTP callbacks, retried with backoff if your endpoint is down."),
    banner, h("div", { class: "card card-pad" }, form), h("div", { class: "card" }, tableHost));
}
