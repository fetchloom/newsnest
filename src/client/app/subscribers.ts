import { api } from "./api.js";
import { h } from "./dom.js";
import { confirmDialog, filePicker } from "./controls.js";
import { ago, busy, chips, downloadFile, empty, field, fullDate, input, modal, num, pageHead, selectEl, statusBadge, toast } from "./ui.js";

const ENGAGEMENT: [string, string][] = [["", "Any engagement"], ["new", "New"], ["active", "Active"], ["at_risk", "At risk"], ["inactive", "Inactive"]];

export async function subscribersList(query: URLSearchParams): Promise<HTMLElement> {
  const [fields, segments] = await Promise.all([api("GET", "/fields"), api("GET", "/segments")]);
  const f = { q: query.get("q") ?? "", status: query.get("status") ?? "", tag: query.get("tag") ?? "", segment: query.get("segment") ?? "", engagement: query.get("engagement") ?? "" };
  const body = h("tbody");
  const more = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Load more");
  const foot = h("div", { class: "row", style: "padding:14px 22px;justify-content:center" }, more);
  const count = h("span", { class: "muted small" });
  const card = h("div", { class: "card", style: "overflow:hidden" });
  let last: string | null = null;

  const qs = (extra: Record<string, string> = {}): string => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v);
    return p.toString();
  };

  async function load(reset: boolean): Promise<void> {
    if (reset) { body.replaceChildren(); last = null; }
    const page = await api("GET", `/subscribers?${qs({ limit: "25", ...(last ? { after: last } : {}) })}`);
    count.textContent = `${num(page.total)} subscribers`;
    for (const s of page.data) {
      body.append(h("tr", { class: "link", onclick: () => { location.hash = `#/subscribers/${encodeURIComponent(s.email)}`; } },
        h("td", { class: "clip" }, s.email), h("td", {}, statusBadge(s.status)), h("td", {}, s.tags.length ? chips(s.tags.slice(0, 3)) : h("span", { class: "muted" }, "—")),
        h("td", { class: "muted small" }, s.engagement.replace("_", " ")), h("td", { class: "muted small" }, s.source), h("td", { class: "muted small", title: fullDate(s.created_at) }, ago(s.created_at))));
      last = s.id;
    }
    foot.style.display = page.has_more ? "" : "none";
    emptyNote.style.display = body.children.length ? "none" : "";
  }
  const emptyNote = empty("No subscribers match", "Try clearing a filter, or add people with the buttons above.");
  more.addEventListener("click", () => void busy(more, () => load(false)));

  const apply = (): void => { location.hash = `#/subscribers${qs() ? `?${qs()}` : ""}`; };
  const search = input({ type: "search", placeholder: "Search email or name", value: f.q, "aria-label": "Search", onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") { f.q = (e.target as HTMLInputElement).value; apply(); } } });
  const filters = h("div", { class: "toolbar" }, search,
    selectEl([["", "Any status"], ["active", "Active"], ["pending", "Pending"], ["unsubscribed", "Unsubscribed"], ["bounced", "Bounced"]], f.status, { "aria-label": "Status", onchange: (e: Event) => { f.status = (e.target as HTMLSelectElement).value; apply(); } }),
    selectEl([["", "Any tag"], ...fields.tags.map((t: any) => [t.tag, `${t.tag} (${t.subscribers})`] as [string, string])], f.tag, { "aria-label": "Tag", onchange: (e: Event) => { f.tag = (e.target as HTMLSelectElement).value; apply(); } }),
    selectEl([["", "Any segment"], ...segments.data.map((s: any) => [s.id, s.name] as [string, string])], f.segment, { "aria-label": "Segment", onchange: (e: Event) => { f.segment = (e.target as HTMLSelectElement).value; apply(); } }),
    selectEl(ENGAGEMENT, f.engagement, { "aria-label": "Engagement", onchange: (e: Event) => { f.engagement = (e.target as HTMLSelectElement).value; apply(); } }),
    h("span", { class: "right" }, count));

  card.append(filters, h("div", { class: "table-scroll" }, h("table", { class: "t" },
    h("thead", {}, h("tr", {}, h("th", {}, "Email"), h("th", {}, "Status"), h("th", {}, "Tags"), h("th", {}, "Engagement"), h("th", {}, "Source"), h("th", {}, "Joined"))), body)), emptyNote, foot);
  await load(true);

  const exportBtn = h("button", { class: "btn btn-ghost", type: "button", onclick: () => void downloadFile(`/subscribers/export.csv?${qs()}`, "subscribers.csv") }, "Export CSV");
  return h("div", { class: "view stack" },
    pageHead("Subscribers", "Everyone on your list, with their tags, activity and where they came from.",
      exportBtn, h("button", { class: "btn btn-ghost", type: "button", onclick: importDialog }, "Import CSV"), h("button", { class: "btn btn-solid", type: "button", onclick: addDialog }, "Add subscriber")), card);
}

function addDialog(): void {
  const email = input({ type: "email", placeholder: "someone@example.com", required: true });
  const first = input({ placeholder: "First name (optional)" });
  const tags = input({ placeholder: "Tags, separated by commas (optional)" });
  const confirm = h("input", { type: "checkbox" });
  const welcome = h("input", { type: "checkbox" });
  const error = h("div", { class: "error", role: "alert" });
  const go = h("button", { class: "btn btn-solid", type: "button" }, "Add");
  const m = modal("Add a subscriber", h("div", { class: "stack" }, field("Email", email), field("First name", first), field("Tags", tags),
    h("label", { class: "check" }, confirm, "Ask them to confirm by email first"), h("label", { class: "check" }, welcome, "Send the welcome email"), error), [go]);
  go.addEventListener("click", () => void busy(go, async () => {
    error.textContent = "";
    try {
      const s = await api("POST", "/subscribers", { email: email.value, fields: first.value ? { first_name: first.value } : undefined, tags: tags.value.split(",").map((t) => t.trim()).filter(Boolean), send_confirmation: confirm.checked, send_welcome_email: welcome.checked });
      m.close(); toast(s.created ? "Subscriber added" : "Already subscribed"); location.hash = `#/subscribers/${encodeURIComponent(s.email)}`;
    } catch (e) { error.textContent = (e as Error).message; }
  }));
}

function importDialog(): void {
  const text = h("textarea", { class: "textarea", placeholder: "email,first_name,tags\nada@example.com,Ada,vip;beta", style: "min-height:140px" });
  const file = filePicker(".csv,text/csv", "Choose a CSV file…", (csv) => { text.value = csv; });
  const tags = input({ placeholder: "Add these tags to everyone (optional)" });
  const update = h("input", { type: "checkbox" });
  const result = h("div");
  const go = h("button", { class: "btn btn-solid", type: "button" }, "Import");
  const m = modal("Import subscribers", h("div", { class: "stack" },
    h("p", { class: "small muted" }, "A CSV with an “email” column. Other columns become fields, and a “tags” column (separated by ;) adds tags. Imported people count as already confirmed, so only import people who agreed to hear from you."),
    file, text, field("Tags", tags), h("label", { class: "check" }, update, "Update people who are already on the list"), result), [go]);
  go.addEventListener("click", () => void busy(go, async () => {
    result.replaceChildren();
    try {
      const r = await api("POST", "/subscribers/import", { csv: text.value, tags: tags.value.split(",").map((t) => t.trim()).filter(Boolean), update_existing: update.checked });
      result.append(h("div", { class: "notice ok" }, `${r.created} added, ${r.updated} updated, ${r.skipped} skipped.`), ...r.invalid.slice(0, 5).map((i: any) => h("div", { class: "small muted" }, `Row ${i.row}: ${i.email || "(empty)"} ${i.reason}`)));
      toast("Import finished");
    } catch (e) { result.append(h("div", { class: "error" }, (e as Error).message)); }
  }));
  void m;
}

export async function subscriberDetail(email: string): Promise<HTMLElement> {
  const [s, activity] = await Promise.all([api("GET", `/subscribers/${encodeURIComponent(email)}`), api("GET", `/subscribers/${encodeURIComponent(email)}/activity`)]);
  const reload = (): void => { location.reload(); };

  const tagInput = input({ placeholder: "Add a tag", "aria-label": "Add a tag" });
  const addTag = (): void => { if (tagInput.value.trim()) void api("PATCH", `/subscribers/${encodeURIComponent(s.email)}`, { tags_add: [tagInput.value] }).then(reload, (e) => toast((e as Error).message, "bad")); };
  tagInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTag(); });
  const key = input({ placeholder: "field name" });
  const val = input({ placeholder: "value" });
  const saveField = (): void => { if (key.value.trim()) void api("PATCH", `/subscribers/${encodeURIComponent(s.email)}`, { fields: { [key.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")]: val.value } }).then(reload, (e) => toast((e as Error).message, "bad")); };

  const toggle = s.status === "unsubscribed"
    ? h("button", { class: "btn btn-ghost", type: "button", onclick: () => void api("PATCH", `/subscribers/${encodeURIComponent(s.email)}`, { status: "active" }).then(reload) }, "Resubscribe")
    : s.status === "active" ? h("button", { class: "btn btn-ghost", type: "button", onclick: () => void api("PATCH", `/subscribers/${encodeURIComponent(s.email)}`, { status: "unsubscribed" }).then(reload) }, "Unsubscribe") : null;
  const del = h("button", { class: "btn btn-danger", type: "button" }, "Delete");
  del.addEventListener("click", () => void busy(del, async () => { if (!(await confirmDialog(`Delete ${s.email} and their history? This can't be undone.`, { title: "Delete subscriber" }))) return; await api("DELETE", `/subscribers/${encodeURIComponent(s.email)}`); location.hash = "#/subscribers"; }));

  const meta = (k: string, v: unknown): HTMLElement[] => [h("dt", {}, k), h("dd", {}, v == null || v === "" ? "—" : String(v))];
  return h("div", { class: "view stack" },
    h("a", { class: "crumb", href: "#/subscribers" }, "← Subscribers"),
    pageHead(s.email, undefined, statusBadge(s.status), toggle, del),
    h("div", { class: "stats-grid" },
      h("div", { class: "stat-card" }, h("div", { class: "n" }, num(s.stats.emails_received)), h("div", { class: "l" }, "Emails received")),
      h("div", { class: "stat-card" }, h("div", { class: "n" }, num(s.stats.opens)), h("div", { class: "l" }, "Opened")),
      h("div", { class: "stat-card" }, h("div", { class: "n" }, num(s.stats.clicks)), h("div", { class: "l" }, "Clicked")),
      h("div", { class: "stat-card" }, h("div", { class: "n" }, s.engagement.replace("_", " ")), h("div", { class: "l" }, "Engagement"))),
    h("div", { class: "split" },
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Details")), h("dl", { class: "meta" },
        ...meta("Joined", fullDate(s.created_at)), ...meta("Confirmed", fullDate(s.confirmed_at)), ...meta("Source", s.source), ...meta("UTM source", s.utm_source), ...meta("UTM medium", s.utm_medium),
        ...meta("UTM campaign", s.utm_campaign), ...meta("Referring site", s.referrer), ...meta("Country", s.country), ...meta("Referral link", s.referral.link), ...meta("Referred people", s.referral.confirmed_referrals))),
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Tags")), h("div", { class: "card-pad stack" },
          s.tags.length ? chips(s.tags, (t) => void api("PATCH", `/subscribers/${encodeURIComponent(s.email)}`, { tags_remove: [t] }).then(reload)) : h("span", { class: "muted small" }, "No tags yet."),
          h("div", { class: "tag-input" }, tagInput, h("button", { class: "btn btn-ghost", type: "button", onclick: addTag }, "Add")))),
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Fields")), h("div", { class: "card-pad stack" },
          Object.keys(s.fields).length ? h("dl", { class: "meta", style: "padding:0" }, ...Object.entries(s.fields).flatMap(([k, v]) => meta(k.replace(/_/g, " "), v))) : h("span", { class: "muted small" }, "No custom fields."),
          h("div", { class: "kv" }, key, val, h("button", { class: "btn btn-ghost", type: "button", onclick: saveField }, "Save")))))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Activity")),
      activity.emails.length || activity.subscription.length
        ? h("ol", { class: "timeline" }, ...activity.emails.map((a: any) => h("li", { class: a.type.includes("bounce") || a.type.includes("fail") ? "bad" : "" }, h("span", {}, a.type.replace("email.", "").replace("_", " "), h("span", { class: "muted" }, ` · ${a.subject}`)), h("span", { class: "when", title: fullDate(a.created_at) }, ago(a.created_at)))),
          ...activity.subscription.map((a: any) => h("li", { class: "neutral" }, h("span", {}, a.type), h("span", { class: "when" }, ago(a.created_at)))))
        : empty("No activity yet", "Opens, clicks and bounces will show up here.")));
}
