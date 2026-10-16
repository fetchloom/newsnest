import { api } from "./api.js";
import { h, replace } from "./dom.js";
import { input, selectEl } from "./ui.js";

export interface Condition { field: string; op: string; value?: unknown }
export interface Group { match: "all" | "any"; conditions: (Condition | Group)[] }

export interface Catalog {
  customFields: { key: string; label: string; type: string }[];
  tags: string[];
  posts: { id: string; title: string }[];
  polls: { id: string; question: string }[];
  segments: { id: string; name: string }[];
}

export async function loadCatalog(): Promise<Catalog> {
  const [fields, posts, polls, segments] = await Promise.all([api("GET", "/fields"), api("GET", "/posts"), api("GET", "/polls"), api("GET", "/segments")]);
  return {
    customFields: fields.fields, tags: fields.tags.map((t: { tag: string }) => t.tag),
    posts: posts.data.map((p: any) => ({ id: p.id, title: p.title })), polls: polls.data.map((p: any) => ({ id: p.id, question: p.question })),
    segments: segments.data.map((s: any) => ({ id: s.id, name: s.name })),
  };
}

type Kind = "text" | "status" | "number" | "date" | "lastdate" | "engagement" | "tag" | "post" | "poll" | "segment" | "custom";
const TEXT_OPS: [string, string][] = [["is", "is"], ["is_not", "is not"], ["contains", "contains"], ["not_contains", "doesn't contain"], ["starts_with", "starts with"], ["ends_with", "ends with"], ["is_set", "is set"], ["is_empty", "is empty"]];
const OPS: Record<Kind, [string, string][]> = {
  text: TEXT_OPS,
  status: [["is", "is"], ["is_not", "is not"]],
  number: [["eq", "="], ["neq", "≠"], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"]],
  date: [["within_days", "in the last (days)"], ["not_within_days", "not in the last (days)"], ["before", "before"], ["after", "on or after"]],
  lastdate: [["within_days", "in the last (days)"], ["not_within_days", "not in the last (days)"], ["never", "never"], ["is_set", "has happened"]],
  engagement: [["is", "is"], ["is_not", "is not"]],
  tag: [["has", "has tag"], ["not_has", "doesn't have tag"]],
  post: [["has", "did"], ["not_has", "did not"]],
  poll: [["has", "voted"], ["not_has", "didn't vote"]],
  segment: [["is", "is in"], ["is_not", "is not in"]],
  custom: [["is", "is"], ["is_not", "is not"], ["contains", "contains"], ["gt", ">"], ["lt", "<"], ["is_set", "is set"], ["is_empty", "is empty"]],
};
const NO_VALUE = new Set(["is_set", "is_empty", "never"]);

const BASE_FIELDS: [string, string, Kind][] = [
  ["status", "Status", "status"], ["engagement", "Engagement", "engagement"], ["tag", "Tag", "tag"], ["email", "Email", "text"], ["country", "Country", "text"],
  ["source", "Source", "text"], ["utm_source", "UTM source", "text"], ["utm_medium", "UTM medium", "text"], ["utm_campaign", "UTM campaign", "text"], ["referrer", "Referring site", "text"],
  ["created_at", "Joined", "date"], ["last_open_at", "Last opened", "lastdate"], ["last_click_at", "Last clicked", "lastdate"],
  ["opens", "Emails opened", "number"], ["clicks", "Emails clicked", "number"], ["emails_received", "Emails received", "number"], ["referral_count", "Referrals", "number"],
  ["opened_post", "Opened post", "post"], ["clicked_post", "Clicked in post", "post"], ["voted_poll", "Poll", "poll"], ["in_segment", "Segment", "segment"],
];

const kindOf = (field: string): Kind => (field.startsWith("field:") ? "custom" : (BASE_FIELDS.find((f) => f[0] === field)?.[2] ?? "text"));
const isGroup = (c: Condition | Group): c is Group => "conditions" in c;

/**
 * Editable segment rules: nested all/any groups of conditions.
 * The `group` object is edited in place and `onChange` is called after every edit.
 */
export function rulesBuilder(group: Group, onChange: () => void, cat: Catalog, depth = 0, onRemove?: () => void): HTMLElement {
  const root = h("div", { class: "rules" });

  function valueControl(c: Condition, kind: Kind): HTMLElement | null {
    if (NO_VALUE.has(c.op)) return null;
    const set = (v: unknown): void => { c.value = v; onChange(); };
    const val = c.value == null ? "" : String(c.value);
    if (kind === "status") return selectEl(["active", "pending", "unsubscribed", "bounced"], val || "active", { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) });
    if (kind === "engagement") return selectEl([["new", "New (joined this week)"], ["active", "Active (30 days)"], ["at_risk", "At risk (30–90 days)"], ["inactive", "Inactive"]], val || "active", { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) });
    if (kind === "post") return selectEl([["", "Choose a post…"], ...cat.posts.map((p) => [p.id, p.title] as [string, string])], val, { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) });
    if (kind === "poll") return selectEl([["", "Choose a poll…"], ...cat.polls.map((p) => [p.id, p.question] as [string, string])], val, { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) });
    if (kind === "segment") return selectEl([["", "Choose a segment…"], ...cat.segments.map((s) => [s.id, s.name] as [string, string])], val, { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) });
    if (kind === "tag") return input({ value: val, placeholder: "tag name", list: "rules-tags", oninput: (e: Event) => set((e.target as HTMLInputElement).value) });
    const numeric = kind === "number" || c.op === "within_days" || c.op === "not_within_days" || (kind === "custom" && (c.op === "gt" || c.op === "lt"));
    const date = c.op === "before" || c.op === "after";
    return input({ value: val, type: date ? "date" : numeric ? "number" : "text", placeholder: date ? "" : numeric ? "0" : "value", oninput: (e: Event) => set((e.target as HTMLInputElement).value) });
  }

  function condRow(c: Condition, index: number): HTMLElement {
    const kind = kindOf(c.field);
    const fieldOptions: [string, string][] = [...BASE_FIELDS.map(([k, label]) => [k, label] as [string, string]), ...cat.customFields.map((f) => [`field:${f.key}`, `Field: ${f.label}`] as [string, string])];
    const ops = OPS[kind];
    if (!ops.some(([o]) => o === c.op)) c.op = ops[0][0];
    return h("div", { class: "rule" },
      selectEl(fieldOptions, c.field, { "aria-label": "Field", onchange: (e: Event) => { c.field = (e.target as HTMLSelectElement).value; c.op = OPS[kindOf(c.field)][0][0]; c.value = ""; onChange(); render(); } }),
      selectEl(ops, c.op, { class: "select op", "aria-label": "Condition", onchange: (e: Event) => { c.op = (e.target as HTMLSelectElement).value; onChange(); render(); } }),
      valueControl(c, kind),
      h("button", { class: "ico-btn danger", type: "button", "aria-label": "Remove condition", onclick: () => { group.conditions.splice(index, 1); onChange(); render(); } }, "×"));
  }

  function render(): void {
    replace(root,
      h("div", { class: "rules-foot" },
        h("span", { class: "small muted" }, "Match"),
        selectEl([["all", "all"], ["any", "any"]], group.match, { class: "select op", style: "width:auto;flex:none", "aria-label": "Match mode", onchange: (e: Event) => { group.match = (e.target as HTMLSelectElement).value as "all" | "any"; onChange(); } }),
        h("span", { class: "small muted" }, "of these conditions"),
        onRemove && h("button", { class: "ico-btn danger right", type: "button", "aria-label": "Remove group", onclick: onRemove }, "×")),
      ...group.conditions.map((c, i) => isGroup(c)
        ? rulesBuilder(c, onChange, cat, depth + 1, () => { group.conditions.splice(i, 1); onChange(); render(); })
        : condRow(c, i)),
      h("div", { class: "rules-foot" },
        h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { group.conditions.push({ field: "tag", op: "has", value: "" }); onChange(); render(); } }, "+ Condition"),
        depth < 3 && h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { group.conditions.push({ match: "any", conditions: [{ field: "tag", op: "has", value: "" }] }); onChange(); render(); } }, "+ Group")),
      depth === 0 ? h("datalist", { id: "rules-tags" }, cat.tags.map((t) => h("option", { value: t }))) : null,
    );
  }
  render();
  return root;
}

export const emptyRules = (): Group => ({ match: "all", conditions: [] });
