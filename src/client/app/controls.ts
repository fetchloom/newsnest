// Replacements for the controls the browser would otherwise draw itself
// (alert/confirm/prompt, select menus, date and colour pickers, tooltips),
// so every popup in the dashboard looks like Freepost.
import { h, icon } from "./dom.js";
import { modal } from "./ui.js";

// ---- floating panel ---------------------------------------------------------------
/** Shows `panel` under `anchor` (above it when there's no room). Closes on outside click, Escape or scroll. */
function floating(anchor: HTMLElement, panel: HTMLElement, onClose?: () => void): () => void {
  panel.classList.add("float");
  document.body.append(panel);
  const place = (): void => {
    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const below = innerHeight - a.bottom - 8;
    const top = below >= Math.min(p.height, 260) || a.top < p.height ? a.bottom + 6 : a.top - p.height - 6;
    panel.style.top = `${Math.max(8, Math.min(top, innerHeight - p.height - 8))}px`;
    panel.style.left = `${Math.max(8, Math.min(a.left, innerWidth - p.width - 8))}px`;
  };
  place();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("resize", close);
    removeEventListener("scroll", onScroll, true);
    panel.remove();
    onClose?.();
  };
  const onDown = (e: Event): void => { if (!panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.stopPropagation(); close(); anchor.focus(); } };
  const onScroll = (e: Event): void => { if (!panel.contains(e.target as Node)) close(); };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true); // capture: Escape closes the panel, not the dialog under it
  addEventListener("resize", close);
  addEventListener("scroll", onScroll, true);
  return close;
}

// ---- select menus -----------------------------------------------------------------
const upgraded = new WeakMap<HTMLSelectElement, HTMLButtonElement>();

function upgradeSelect(sel: HTMLSelectElement): void {
  const known = upgraded.get(sel);
  if (known) { if (sel.nextElementSibling !== known) sel.after(known); return; }

  const label = h("span", { class: "x-label" });
  const trigger = h("button", { class: "select x-select", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": sel.getAttribute("aria-label"), style: sel.getAttribute("style") }, label, icon("M6 9l6 6 6-6"));
  const sync = (): void => { label.textContent = sel.selectedOptions[0]?.textContent ?? ""; trigger.disabled = sel.disabled; };
  const valueOf = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  if (valueOf) Object.defineProperty(sel, "value", { configurable: true, get: () => valueOf.get!.call(sel), set: (v: string) => { valueOf.set!.call(sel, v); sync(); } });
  upgraded.set(sel, trigger);
  sel.classList.add("x-native");
  sel.after(trigger);
  sync();
  new MutationObserver(sync).observe(sel, { attributes: true, attributeFilter: ["disabled"] });

  let close: (() => void) | null = null;
  const open = (): void => {
    if (close || trigger.disabled) return;
    sync();
    const options = [...sel.options];
    let active = Math.max(0, sel.selectedIndex);
    const items = options.map((o, i) => h("div", { class: "x-opt", role: "option", "aria-selected": String(i === sel.selectedIndex), "aria-disabled": String(o.disabled), onclick: () => choose(i) }, h("span", {}, o.textContent), i === sel.selectedIndex && icon("M5 12l5 5 9-10")));
    const menu = h("div", { class: "x-menu", role: "listbox", style: `min-width:${trigger.offsetWidth}px` }, items);
    const mark = (): void => { items.forEach((el, i) => el.classList.toggle("on", i === active)); items[active]?.scrollIntoView?.({ block: "nearest" }); };
    const choose = (i: number): void => {
      if (options[i].disabled) return;
      const changed = sel.selectedIndex !== i;
      sel.value = options[i].value;
      close?.();
      trigger.focus();
      if (changed) { sel.dispatchEvent(new Event("input", { bubbles: true })); sel.dispatchEvent(new Event("change", { bubbles: true })); }
    };
    const step = (d: number): void => { let i = active; do { i = (i + d + options.length) % options.length; } while (options[i].disabled && i !== active); active = i; mark(); };
    let typed = "", typedAt = 0;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "ArrowDown") step(1);
      else if (e.key === "ArrowUp") step(-1);
      else if (e.key === "Home") { active = 0; mark(); }
      else if (e.key === "End") { active = options.length - 1; mark(); }
      else if (e.key === "Enter" || e.key === " ") choose(active);
      else if (e.key === "Tab") { close?.(); return; }
      else if (e.key.length === 1) { // type-ahead
        typed = Date.now() - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase(); typedAt = Date.now();
        const hit = options.findIndex((o) => !o.disabled && (o.textContent ?? "").toLowerCase().startsWith(typed));
        if (hit >= 0) { active = hit; mark(); }
      } else return;
      e.preventDefault();
    };
    trigger.setAttribute("aria-expanded", "true");
    close = floating(trigger, menu, () => { close = null; trigger.setAttribute("aria-expanded", "false"); trigger.removeEventListener("keydown", onKey); });
    trigger.addEventListener("keydown", onKey);
    mark();
  };
  trigger.addEventListener("click", () => (close ? close() : open()));
  trigger.addEventListener("keydown", (e) => { if (!close && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); open(); } });
}

// ---- suggestions (replaces <datalist>) -----------------------------------------------
function upgradeSuggest(inp: HTMLInputElement): void {
  const id = inp.getAttribute("list");
  if (!id) return;
  inp.removeAttribute("list"); // stops the browser drawing its own suggestion popup
  inp.setAttribute("autocomplete", "off");
  let close: (() => void) | null = null;
  let items: HTMLElement[] = [];
  let hits: string[] = [];
  let active = -1;
  const mark = (): void => items.forEach((el, i) => el.classList.toggle("on", i === active));
  let quiet = false;
  const choose = (v: string): void => {
    inp.value = v; close?.();
    quiet = true; // our own input listener must not reopen the list
    inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true }));
    quiet = false;
  };
  const refresh = (): void => {
    if (quiet) return;
    close?.();
    const q = inp.value.trim().toLowerCase();
    const all = [...(document.getElementById(id)?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value") ?? "");
    hits = all.filter((v) => v && v !== inp.value && v.toLowerCase().includes(q)).slice(0, 8);
    active = -1;
    if (!hits.length) return;
    items = hits.map((v) => h("div", { class: "x-opt", role: "option", onpointerdown: (e: Event) => { e.preventDefault(); choose(v); } }, h("span", {}, v)));
    close = floating(inp, h("div", { class: "x-menu", role: "listbox", style: `min-width:${inp.offsetWidth}px` }, items), () => { close = null; });
  };
  inp.addEventListener("focus", refresh);
  inp.addEventListener("input", refresh);
  inp.addEventListener("keydown", (e) => {
    if (!close) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { active = (active + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length; mark(); e.preventDefault(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(hits[active]); }
  });
  inp.addEventListener("blur", () => close?.());
}

// ---- tooltips ---------------------------------------------------------------------
function installTooltips(): void {
  let tip: HTMLElement | null = null;
  let timer: number | undefined;
  const hide = (): void => { clearTimeout(timer); tip?.remove(); tip = null; };
  const show = (el: Element): void => {
    const text = el.getAttribute("data-tip");
    if (!text) return;
    hide();
    tip = h("div", { class: "tooltip", role: "tooltip" }, text);
    document.body.append(tip);
    const a = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(a.left + a.width / 2 - t.width / 2, innerWidth - t.width - 8))}px`;
    tip.style.top = `${a.top - t.height - 8 < 8 ? a.bottom + 8 : a.top - t.height - 8}px`;
  };
  const target = (e: Event): Element | null => (e.target instanceof Element ? e.target.closest("[data-tip]") : null);
  document.addEventListener("pointerover", (e) => { const el = target(e); if (el) { clearTimeout(timer); timer = window.setTimeout(() => show(el), 350); } });
  document.addEventListener("pointerout", (e) => { if (target(e)) hide(); });
  document.addEventListener("focusin", (e) => { const el = target(e); if (el) show(el); });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide, true);
  addEventListener("scroll", hide, true);
}

/** Call once at startup. Upgrades every `select.select` and `input[list]` now and later, and adds tooltips. */
export function installControls(): void {
  if (typeof MutationObserver === "undefined") return; // no layout engine (tests)
  const scan = (root: ParentNode): void => {
    root.querySelectorAll<HTMLSelectElement>("select.select").forEach(upgradeSelect);
    root.querySelectorAll<HTMLInputElement>("input[list]").forEach(upgradeSuggest);
  };
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      if (n.matches("select.select")) upgradeSelect(n as HTMLSelectElement);
      if (n.matches("input[list]")) upgradeSuggest(n as HTMLInputElement);
      scan(n);
    }
  }).observe(document.body, { childList: true, subtree: true });
  scan(document);
  installTooltips();
}

// ---- dialogs ----------------------------------------------------------------------
/** A confirmation dialog. Resolves true only when the person presses the confirm button. */
export function confirmDialog(message: string, { title = "Are you sure?", confirm = "Delete", danger = true } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const yes = h("button", { class: `btn ${danger ? "btn-danger-solid" : "btn-solid"}`, type: "button", onclick: () => { answer = true; m.close(); } }, confirm);
    const m = modal(title, h("p", { class: "dialog-text" }, message),
      [h("button", { class: "btn btn-ghost", type: "button", onclick: () => m.close() }, "Cancel"), yes], () => resolve(answer));
    yes.focus();
  });
}

/** Asks for one line of text. Resolves with the text, or null if cancelled. */
export function promptDialog(title: string, label: string, initial = "", action = "Create"): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const field = h("input", { class: "input", value: initial, "aria-label": label });
    const done = (): void => { if (field.value.trim()) { answer = field.value.trim(); m.close(); } };
    field.addEventListener("keydown", (e) => { if (e.key === "Enter") done(); });
    const m = modal(title, h("div", { class: "field" }, h("label", {}, label), field),
      [h("button", { class: "btn btn-ghost", type: "button", onclick: () => m.close() }, "Cancel"), h("button", { class: "btn btn-solid", type: "button", onclick: done }, action)], () => resolve(answer));
    field.focus();
    field.select?.();
  });
}

// ---- date and time ----------------------------------------------------------------
export type DateTimeField = HTMLDivElement & { value: string; disabled: boolean };

const pad = (n: number): string => String(n).padStart(2, "0");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A date and time picker. `.value` is local time as "YYYY-MM-DDTHH:mm", or "" when empty. */
export function dateTimeField(placeholder = "Pick a date and time"): DateTimeField {
  let value = "";
  let disabled = false;
  const label = h("span", { class: "x-label" });
  const trigger = h("button", { class: "select x-select", type: "button", "aria-haspopup": "dialog" }, label, icon("M4 6h16v14H4z", "M4 10h16M8 3v4M16 3v4"));
  const root = h("div", { class: "x-date" }, trigger) as DateTimeField;
  const show = (): void => {
    label.textContent = value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : placeholder;
    label.classList.toggle("placeholder", !value);
  };
  Object.defineProperty(root, "value", { get: () => value, set: (v: string) => { value = v; show(); } });
  Object.defineProperty(root, "disabled", { get: () => disabled, set: (v: boolean) => { disabled = v; trigger.disabled = v; } });
  show();

  trigger.addEventListener("click", () => {
    const start = value ? new Date(value) : new Date(Date.now() + 3600_000);
    let year = start.getFullYear(), month = start.getMonth(), day = value ? start.getDate() : 0;
    const hour = h("input", { class: "input x-time", inputMode: "numeric", maxLength: 2, value: pad(start.getHours()), "aria-label": "Hour" });
    const minute = h("input", { class: "input x-time", inputMode: "numeric", maxLength: 2, value: pad(start.getMinutes()), "aria-label": "Minute" });
    const clamp = (el: HTMLInputElement, max: number): number => { const n = Math.min(max, Math.max(0, parseInt(el.value, 10) || 0)); el.value = pad(n); return n; };
    const grid = h("div", { class: "x-days" });
    const title = h("b", {});
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const draw = (): void => {
      title.textContent = `${MONTHS[month]} ${year}`;
      const lead = (new Date(year, month, 1).getDay() + 6) % 7; // weeks start on Monday
      const count = new Date(year, month + 1, 0).getDate();
      grid.replaceChildren(
        ...["M", "T", "W", "T", "F", "S", "S"].map((d) => h("span", { class: "x-dow" }, d)),
        ...Array.from({ length: lead }, () => h("span", {})),
        ...Array.from({ length: count }, (_, i) => {
          const d = i + 1;
          const past = new Date(year, month, d) < today;
          return h("button", { class: `x-day${d === day ? " on" : ""}`, type: "button", disabled: past, onclick: () => { day = d; draw(); } }, String(d));
        }));
    };
    const shift = (d: number): void => { const next = new Date(year, month + d, 1); year = next.getFullYear(); month = next.getMonth(); draw(); };
    const error = h("div", { class: "error" });
    let close = (): void => {};
    const panel = h("div", { class: "x-pop", role: "dialog", "aria-label": "Pick a date and time" },
      h("div", { class: "x-cal-head" },
        h("button", { class: "ico-btn", type: "button", "aria-label": "Previous month", onclick: () => shift(-1) }, icon("M15 6l-6 6 6 6")), title,
        h("button", { class: "ico-btn", type: "button", "aria-label": "Next month", onclick: () => shift(1) }, icon("M9 6l6 6-6 6"))),
      grid,
      h("div", { class: "x-time-row" }, h("span", { class: "muted small" }, "Time"), hour, h("span", {}, ":"), minute),
      error,
      h("div", { class: "row", style: "justify-content:flex-end" },
        h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { value = ""; show(); close(); } }, "Clear"),
        h("button", { class: "btn btn-solid btn-sm", type: "button", onclick: () => {
          if (!day) { error.textContent = "Pick a day first."; return; }
          const picked = `${year}-${pad(month + 1)}-${pad(day)}T${pad(clamp(hour, 23))}:${pad(clamp(minute, 59))}`;
          if (new Date(picked).getTime() < Date.now()) { error.textContent = "That time has already passed."; return; }
          value = picked; show(); close();
        } }, "Done")));
    draw();
    close = floating(trigger, panel);
  });
  return root;
}

// ---- colour -----------------------------------------------------------------------
const SWATCHES = ["#1663fe", "#0f172a", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0d9488", "#0891b2", "#4b5563", "#000000"];

/** A colour swatch that opens a palette. `onPick` gets a #rrggbb string. */
export function colorField(initial: string, onPick: (hex: string) => void): HTMLButtonElement & { set(hex: string): void } {
  const dot = h("span", { class: "x-dot" });
  const btn = h("button", { class: "x-swatch", type: "button", "aria-label": "Choose a colour", "aria-haspopup": "dialog" }, dot) as HTMLButtonElement & { set(hex: string): void };
  btn.set = (hex: string): void => { dot.style.background = hex; };
  btn.set(initial);
  btn.addEventListener("click", () => {
    let close = (): void => {};
    const panel = h("div", { class: "x-pop x-palette", role: "dialog", "aria-label": "Colours" },
      SWATCHES.map((c) => h("button", { class: "x-chip", type: "button", style: `background:${c}`, "aria-label": c, onclick: () => { btn.set(c); onPick(c); close(); } })));
    close = floating(btn, panel);
  });
  return btn;
}

// ---- files ------------------------------------------------------------------------
/** A button that opens the system file chooser and hands back the file's text. */
export function filePicker(accept: string, labelText: string, onText: (text: string, name: string) => void): HTMLElement {
  const name = h("span", { class: "muted small" });
  const file = h("input", { type: "file", accept, style: "display:none", onchange: async () => { const f = file.files?.[0]; if (f) { name.textContent = f.name; onText(await f.text(), f.name); } } });
  return h("div", { class: "row" }, file, h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => file.click() }, labelText), name);
}
