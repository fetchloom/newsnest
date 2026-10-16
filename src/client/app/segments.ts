import { api } from "./api.js";
import { h } from "./dom.js";
import { emptyRules, loadCatalog, rulesBuilder } from "./rules.js";
import type { Group } from "./rules.js";
import { confirmDialog } from "./controls.js";
import { busy, card, debounce, empty, field, input, num, pageHead, toast } from "./ui.js";

export async function segmentsList(): Promise<HTMLElement> {
  const segs = (await api("GET", "/segments")).data as any[];
  return h("div", { class: "view stack" },
    pageHead("Segments", "Groups of subscribers. Dynamic ones update themselves; static ones are fixed lists.", h("a", { class: "btn btn-solid", href: "#/segments/new" }, "New segment")),
    h("div", { class: "card" }, segs.length
      ? h("div", { class: "table-scroll" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Type"), h("th", { class: "num" }, "Active subscribers"))),
          h("tbody", {}, segs.map((s) => h("tr", { class: "link", onclick: () => { location.hash = `#/segments/${s.id}`; } }, h("td", {}, s.name), h("td", { class: "muted" }, s.kind), h("td", { class: "num" }, num(s.active_subscribers)))))))
      : empty("No segments yet", "Segment by tag, activity, engagement, custom fields and more.")));
}

export async function segmentEditor(id: string): Promise<HTMLElement> {
  const cat = await loadCatalog();
  const existing = id === "new" ? null : await api("GET", `/segments/${id}`);
  const S = { name: existing?.name ?? "", kind: existing?.kind ?? "dynamic", rules: (existing?.rules?.conditions ? existing.rules : emptyRules()) as Group };
  const name = input({ value: S.name, placeholder: "e.g. Engaged readers", "aria-label": "Segment name" });
  const countEl = h("div", { class: "stat-card" });
  const sample = h("div", { class: "muted small" });

  const refresh = debounce(async () => {
    try {
      const r = await api("POST", "/segments/preview", { rules: S.rules });
      countEl.replaceChildren(h("div", { class: "n" }, num(r.active_subscribers)), h("div", { class: "l" }, "active subscribers match"));
      sample.textContent = r.sample.length ? `e.g. ${r.sample.join(", ")}` : "";
    } catch (e) { countEl.replaceChildren(h("div", { class: "l" }, (e as Error).message)); }
  }, 400);
  const builder = rulesBuilder(S.rules, () => refresh(), cat);
  if (S.kind === "dynamic") refresh();

  const save = h("button", { class: "btn btn-solid", type: "button" }, existing ? "Save" : "Create segment");
  save.addEventListener("click", () => void busy(save, async () => {
    if (!name.value.trim()) { toast("Give the segment a name", "bad"); return; }
    const body = { name: name.value, kind: S.kind, rules: S.kind === "dynamic" ? S.rules : undefined };
    const r = existing ? await api("PATCH", `/segments/${id}`, body) : await api("POST", "/segments", body);
    toast("Saved"); location.hash = `#/segments/${r.id}`;
  }));

  const actions: HTMLElement[] = [];
  if (existing) {
    actions.push(h("a", { class: "btn btn-ghost", href: `#/subscribers?segment=${id}` }, "View members"));
    actions.push(h("button", { class: "btn btn-ghost", type: "button", onclick: () => void api("POST", `/segments/${id}/snapshot`).then((s) => { toast("Snapshot saved as a static segment"); location.hash = `#/segments/${s.id}`; }, (e) => toast((e as Error).message, "bad")) }, "Save as static list"));
    actions.push(h("button", { class: "btn btn-danger", type: "button", onclick: () => void confirmDialog("Delete this segment?", { title: "Delete segment" }).then((ok) => ok && api("DELETE", `/segments/${id}`).then(() => { location.hash = "#/segments"; })) }, "Delete"));
  }

  const bodyHost = h("div");
  const drawBody = (): void => bodyHost.replaceChildren(S.kind === "dynamic"
    ? h("div", { class: "stack" }, field("Who belongs here", builder, "Edits are checked live against your audience."), h("div", { class: "stats-grid", style: "grid-template-columns:1fr" }, countEl), sample)
    : h("div", { class: "stack" }, h("p", { class: "small muted" }, "A static segment is a fixed list. Add people by email below, or use “Save as static list” on any dynamic segment."), existing ? staticMembers(id) : h("span", { class: "hint" }, "Create it first, then add members.")));
  drawBody();

  return h("div", { class: "view stack" }, h("a", { class: "crumb", href: "#/segments" }, "← Segments"), pageHead(existing ? existing.name : "New segment", undefined, ...actions, save),
    card(null, h("div", { class: "card-pad stack" }, field("Name", name),
      existing ? null : field("Type", h("div", { class: "row" },
        h("label", { class: "check" }, h("input", { type: "radio", name: "kind", checked: S.kind === "dynamic", onchange: () => { S.kind = "dynamic"; drawBody(); refresh(); } }), "Dynamic (rules)"),
        h("label", { class: "check" }, h("input", { type: "radio", name: "kind", checked: S.kind === "static", onchange: () => { S.kind = "static"; drawBody(); } }), "Static (fixed list)"))),
      bodyHost)));
}

function staticMembers(id: string): HTMLElement {
  const emails = h("textarea", { class: "textarea", placeholder: "One email per line", style: "min-height:100px" });
  const go = (remove: boolean) => (e: Event): void => void busy(e.currentTarget as HTMLButtonElement, async () => {
    const r = await api("POST", `/segments/${id}/members`, { emails: emails.value.split(/[\s,;]+/).filter(Boolean), remove });
    toast(`${r.changed} ${remove ? "removed" : "added"}. ${r.active_subscribers} active members.`);
  });
  return h("div", { class: "stack" }, emails, h("div", { class: "row" }, h("button", { class: "btn btn-solid", type: "button", onclick: go(false) }, "Add to segment"), h("button", { class: "btn btn-ghost", type: "button", onclick: go(true) }, "Remove from segment")));
}
