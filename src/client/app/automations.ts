import { api } from "./api.js";
import { h, replace } from "./dom.js";
import { blockEditor, loadEditorContext } from "./editor.js";
import type { Block, EditorCtx } from "./editor.js";
import { rulesBuilder } from "./rules.js";
import { confirmDialog } from "./controls.js";
import { ago, busy, empty, field, fullDate, input, num, pageHead, selectEl, statusBadge, toast } from "./ui.js";

const TRIGGERS: [string, string][] = [["signup", "Someone subscribes"], ["tag_added", "A tag is added"], ["link_clicked", "A link is clicked"], ["custom_event", "A custom event is sent (API)"], ["poll_voted", "Someone votes in a poll"], ["referral_milestone", "Someone earns a referral reward"]];
const triggerLabel = (t: any): string => (TRIGGERS.find(([k]) => k === t.type)?.[1] ?? t.type) + (t.tag ? `: ${t.tag}` : t.name ? `: ${t.name}` : "");

export async function automationsList(): Promise<HTMLElement> {
  const list = (await api("GET", "/automations")).data as any[];
  const create = h("button", { class: "btn btn-solid", type: "button" }, "New automation");
  create.addEventListener("click", () => void busy(create, async () => { const a = await api("POST", "/automations", { name: "Untitled automation", trigger: { type: "signup" } }); location.hash = `#/automations/${a.id}`; }));
  return h("div", { class: "view stack" },
    pageHead("Automations", "Emails and actions that run on their own when something happens: a welcome series, a follow-up after a click, a tag after a purchase.", create),
    h("div", { class: "card" }, list.length
      ? h("div", { class: "table-scroll" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Starts when"), h("th", {}, "Status"), h("th", { class: "num" }, "Running"), h("th", { class: "num" }, "Finished"))),
          h("tbody", {}, list.map((a) => h("tr", { class: "link", onclick: () => { location.hash = `#/automations/${a.id}`; } }, h("td", {}, a.name), h("td", { class: "muted small" }, triggerLabel(a.trigger)), h("td", {}, statusBadge(a.status)), h("td", { class: "num" }, num(a.runs.active)), h("td", { class: "num" }, num(a.runs.completed)))))))
      : empty("No automations yet", "A welcome email is a good first one.")));
}

const STEP_TYPES: [string, string][] = [["email", "Send an email"], ["delay", "Wait"], ["condition", "If / else"], ["add_tag", "Add a tag"], ["remove_tag", "Remove a tag"], ["webhook", "Call a webhook"]];
const sid = (): string => "st" + Math.random().toString(36).slice(2, 10);
const newStep = (type: string): any => ({
  email: { id: sid(), type, subject: "", preview: "", blocks: [{ id: "b1", type: "text", props: { markdown: "" } }] }, delay: { id: sid(), type, minutes: 1440 },
  condition: { id: sid(), type, rules: { match: "all", conditions: [{ field: "tag", op: "has", value: "" }] }, yes: [], no: [] },
  add_tag: { id: sid(), type, tag: "" }, remove_tag: { id: sid(), type, tag: "" }, webhook: { id: sid(), type, url: "" },
}[type]);

export async function automationEditor(id: string): Promise<HTMLElement> {
  const [auto, ctx, runs] = await Promise.all([api("GET", `/automations/${id}`), loadEditorContext(), api("GET", `/automations/${id}/runs`)]);
  const rewards = (await api("GET", "/rewards")).data as any[];
  const A = { name: auto.name, trigger: auto.trigger, steps: auto.steps as any[], allow_reentry: auto.allow_reentry };
  const dirtyNote = h("span", { class: "save-state" }, "Saved");
  const mark = (): void => { dirtyNote.textContent = "Unsaved changes"; };

  // ---- trigger ----
  const triggerBox = h("div", { class: "stack" });
  const drawTrigger = (): void => {
    const t = A.trigger;
    const kind = selectEl(TRIGGERS, t.type, { "aria-label": "Trigger", onchange: (e: Event) => { A.trigger = { type: (e.target as HTMLSelectElement).value }; mark(); drawTrigger(); } });
    const extra: (HTMLElement | null)[] = [];
    const upd = (k: string) => (e: Event): void => { t[k] = (e.target as HTMLInputElement).value; mark(); };
    if (t.type === "tag_added") extra.push(field("Tag", input({ value: t.tag ?? "", placeholder: "e.g. vip", list: "auto-tags", oninput: upd("tag") })), h("datalist", { id: "auto-tags" }, ctx.catalog.tags.map((x) => h("option", { value: x }))));
    if (t.type === "link_clicked") extra.push(field("Link contains (optional)", input({ value: t.url_contains ?? "", placeholder: "example.com/pricing", oninput: upd("url_contains") })), field("In this post (optional)", selectEl([["", "Any post"], ...ctx.catalog.posts.map((p) => [p.id, p.title] as [string, string])], t.post_id ?? "", { onchange: upd("post_id") })));
    if (t.type === "custom_event") extra.push(field("Event name", input({ value: t.name ?? "", placeholder: "purchase", oninput: upd("name") }), "Send it with POST /events { email, name }."));
    if (t.type === "poll_voted") extra.push(field("Poll (optional)", selectEl([["", "Any poll"], ...ctx.polls.map((p) => [p.id, p.question] as [string, string])], t.poll_id ?? "", { onchange: upd("poll_id") })));
    if (t.type === "referral_milestone") extra.push(field("Reward (optional)", selectEl([["", "Any reward"], ...rewards.map((r) => [r.id, r.name] as [string, string])], t.reward_id ?? "", { onchange: upd("reward_id") })));
    if (t.type === "signup") extra.push(field("Only for sign-ups from (optional)", selectEl([["", "Anywhere"], "form", "referral", "import", "api", "manual"], t.source ?? "", { onchange: upd("source") })));
    replace(triggerBox, field("This automation starts when", kind), ...extra, h("label", { class: "check" }, h("input", { type: "checkbox", checked: A.allow_reentry, onchange: (e: Event) => { A.allow_reentry = (e.target as HTMLInputElement).checked; mark(); } }), "Let the same person go through it more than once"));
  };
  drawTrigger();

  // ---- steps ----
  function stepList(steps: any[], depth: number): HTMLElement {
    const host = h("div", { class: "flow" });
    const draw = (): void => {
      replace(host, ...steps.flatMap((s, i) => [h("div", { class: "connector" }), stepCard(s, i)]), h("div", { class: "connector" }), addMenu());
    };
    const addMenu = (): HTMLElement => selectEl([["", "+ Add a step…"], ...STEP_TYPES], "", { class: "select", style: "width:auto;min-width:180px", "aria-label": "Add a step", onchange: (e: Event) => { const t = (e.target as HTMLSelectElement).value; if (t) { steps.push(newStep(t)); mark(); draw(); } } });
    function stepCard(s: any, i: number): HTMLElement {
      const label = STEP_TYPES.find(([k]) => k === s.type)![1];
      const head = h("div", { class: "card-head" }, h("h2", { style: "font-size:15px" }, `${i + 1}. ${label}`),
        h("div", { class: "row", style: "gap:2px" },
          h("button", { class: "ico-btn", type: "button", "aria-label": "Move up", disabled: i === 0, onclick: () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; mark(); draw(); } }, "↑"),
          h("button", { class: "ico-btn", type: "button", "aria-label": "Move down", disabled: i === steps.length - 1, onclick: () => { [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; mark(); draw(); } }, "↓"),
          h("button", { class: "ico-btn danger", type: "button", "aria-label": "Delete step", onclick: () => { steps.splice(i, 1); mark(); draw(); } }, "×")));
      const body = h("div", { class: "step-body" });
      const upd = (k: string) => (e: Event): void => { s[k] = (e.target as HTMLInputElement).value; mark(); };
      if (s.type === "email") {
        const ed = blockEditor({ blocks: s.blocks as Block[], ctx: ctx as EditorCtx, onChange: (b) => { s.blocks = b; mark(); } });
        body.append(field("Subject", input({ value: s.subject, placeholder: "Welcome, {{first_name | friend}}", oninput: upd("subject") })), field("Preview text", input({ value: s.preview ?? "", oninput: upd("preview") })),
          h("details", { class: "more", open: true }, h("summary", {}, "Content"), ed.el));
      } else if (s.type === "delay") {
        const unit = s.minutes % 1440 === 0 ? "days" : s.minutes % 60 === 0 ? "hours" : "minutes";
        const mult = { minutes: 1, hours: 60, days: 1440 };
        const amount = input({ type: "number", min: 1, value: s.minutes / mult[unit as keyof typeof mult], "aria-label": "Amount" });
        const unitSel = selectEl(["minutes", "hours", "days"], unit, { "aria-label": "Unit" });
        const sync = (): void => { s.minutes = Math.max(1, Math.round(Number(amount.value) * mult[unitSel.value as keyof typeof mult])); mark(); };
        amount.addEventListener("input", sync); unitSel.addEventListener("change", sync);
        body.append(h("div", { class: "row" }, h("span", {}, "Wait"), h("div", { style: "width:100px" }, amount), unitSel, h("span", { class: "muted small" }, "then continue")));
      } else if (s.type === "condition") {
        body.append(h("span", { class: "label" }, "If this person matches"), rulesBuilder(s.rules, mark, ctx.catalog),
          h("div", { class: "branches" }, h("div", { class: "branch" }, h("h4", {}, "Yes"), stepList(s.yes, depth + 1)), h("div", { class: "branch" }, h("h4", {}, "No"), stepList(s.no, depth + 1))));
      } else if (s.type === "add_tag" || s.type === "remove_tag") {
        body.append(input({ value: s.tag, placeholder: "tag name", list: "auto-tags2", oninput: upd("tag"), "aria-label": "Tag" }), h("datalist", { id: "auto-tags2" }, ctx.catalog.tags.map((x) => h("option", { value: x }))));
      } else if (s.type === "webhook") {
        body.append(input({ value: s.url, placeholder: "https://example.com/hook", oninput: upd("url"), "aria-label": "Webhook URL" }), h("span", { class: "hint" }, "Newsnest POSTs the subscriber's email, id and fields as JSON."));
      }
      return h("div", { class: "step-card" }, head, body);
    }
    draw();
    return host;
  }

  const name = h("input", { class: "title-input", value: A.name, "aria-label": "Automation name", oninput: (e: Event) => { A.name = (e.target as HTMLInputElement).value; mark(); } });
  const save = h("button", { class: "btn btn-solid btn-sm", type: "button" }, "Save");
  const doSave = async (): Promise<void> => { await api("PATCH", `/automations/${id}`, { name: A.name, trigger: A.trigger, steps: A.steps, allow_reentry: A.allow_reentry }); dirtyNote.textContent = "Saved"; };
  save.addEventListener("click", () => void busy(save, async () => { try { await doSave(); toast("Saved"); } catch (e) { toast((e as Error).message, "bad"); } }));
  const power = h("button", { class: `btn btn-sm ${auto.status === "live" ? "btn-ghost" : "btn-solid"}`, type: "button" }, auto.status === "live" ? "Pause" : "Turn on");
  power.addEventListener("click", () => void busy(power, async () => { await doSave(); await api("POST", `/automations/${id}/${auto.status === "live" ? "pause" : "activate"}`); location.reload(); }));
  const del = h("button", { class: "btn btn-danger btn-sm", type: "button", onclick: () => void confirmDialog("Delete this automation and its history?", { title: "Delete automation" }).then((ok) => ok && api("DELETE", `/automations/${id}`).then(() => { location.hash = "#/automations"; })) }, "Delete");

  return h("div", { class: "view stack" },
    h("a", { class: "crumb", href: "#/automations" }, "← Automations"),
    h("div", { class: "editor-top" }, name, dirtyNote, statusBadge(auto.status), save, power, del),
    h("div", { class: "stats-grid" },
      h("div", { class: "stat-card" }, h("div", { class: "n" }, num(auto.runs.active)), h("div", { class: "l" }, "Running now")),
      h("div", { class: "stat-card" }, h("div", { class: "n" }, num(auto.runs.completed)), h("div", { class: "l" }, "Finished")),
      h("div", { class: "stat-card" }, h("div", { class: "n" }, num(auto.stats.emails)), h("div", { class: "l" }, "Emails sent")),
      h("div", { class: "stat-card" }, h("div", { class: "n" }, num(auto.stats.opens)), h("div", { class: "l" }, "Opened"))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Trigger")), h("div", { class: "card-pad" }, triggerBox)),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Steps")), h("div", { class: "card-pad" }, stepList(A.steps, 0))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Recent runs")), runs.data.length
      ? h("div", { class: "table-scroll" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, h("th", {}, "Subscriber"), h("th", {}, "Status"), h("th", {}, "Started"), h("th", {}, "Next step"))),
          h("tbody", {}, runs.data.map((r: any) => h("tr", {}, h("td", {}, r.email), h("td", {}, statusBadge(r.status), r.last_error ? h("span", { class: "muted small" }, ` ${r.last_error}`) : null), h("td", { class: "muted small" }, ago(r.started_at)), h("td", { class: "muted small" }, r.status === "active" ? fullDate(r.next_run_at) : "—"))))))
      : empty("No runs yet", "People show up here once the automation is on and its trigger happens.")));
}
