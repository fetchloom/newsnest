import { h } from "./dom.js";
import type { Child } from "./dom.js";

type Tone = "ok" | "warn" | "bad" | "neutral";

const STATUS: Record<string, [label: string, tone: Tone]> = {
  "email.scheduled": ["Scheduled", "neutral"],
  "email.queued": ["Queued", "neutral"],
  "email.sent": ["Sent", "ok"],
  "email.delivered": ["Delivered", "ok"],
  "email.delivery_delayed": ["Delayed", "warn"],
  "email.opened": ["Opened", "ok"],
  "email.clicked": ["Clicked", "ok"],
  "email.bounced": ["Bounced", "bad"],
  "email.failed": ["Failed", "bad"],
  "email.suppressed": ["Suppressed", "warn"],
  "email.canceled": ["Canceled", "neutral"],
  verified: ["Verified", "ok"],
  pending: ["Pending", "neutral"],
  failed: ["Not found", "bad"],
};

export const statusInfo = (key: string): [string, Tone] => STATUS[key] ?? [key, "neutral"];

export function badge(key: string): HTMLElement {
  const [label, tone] = statusInfo(key);
  return h("span", { class: `badge ${tone}` }, label);
}

export function toneOf(key: string): Tone {
  return statusInfo(key)[1];
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const [n, unit] = a < 60 ? [a, "s"] : a < 3600 ? [Math.floor(a / 60), "m"] : a < 86400 ? [Math.floor(a / 3600), "h"] : [Math.floor(a / 86400), "d"];
  if (a < 5) return "just now";
  return future ? `in ${n}${unit}` : `${n}${unit} ago`;
}

export const fullDate = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }) : "—";

export function toast(message: string, tone: "ok" | "bad" = "ok"): void {
  let box = document.querySelector(".toasts");
  if (!box) { box = h("div", { class: "toasts", role: "status" }); document.body.append(box); }
  const el = h("div", { class: `toast ${tone === "bad" ? "bad" : ""}` }, message);
  box.append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, tone === "bad" ? 5000 : 2600);
}

export async function copy(text: string, label = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast("Couldn't copy. Select the text and copy it yourself.", "bad");
  }
}

export const copyButton = (text: string, label = "Copy"): HTMLButtonElement =>
  h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => void copy(text) }, label);

export const empty = (title: string, hint: string, ...extra: Child[]): HTMLElement =>
  h("div", { class: "empty" }, h("b", {}, title), hint, ...extra);

/** Runs `fn` while the button is disabled, and reports a failure as a toast. */
export async function busy(button: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
  button.disabled = true;
  try { await fn(); } catch (e) { toast((e as Error).message, "bad"); } finally { button.disabled = false; }
}

export function pageHead(title: string, subtitle?: string, ...actions: Child[]): HTMLElement {
  return h("header", { class: "page-head" }, h("div", {}, h("h1", {}, title), subtitle && h("p", {}, subtitle)), actions.length ? h("div", { class: "row" }, ...actions) : null);
}

/** The Freepost logo, as the mark plus wordmark, with a dark-theme variant that CSS swaps in. */
export function logo(): HTMLAnchorElement {
  const img = (cls: string, src: string, w: number, h2: number, alt = ""): HTMLImageElement =>
    h("img", { class: cls, src, alt, width: w, height: h2 });
  return h("a", { class: "logo", href: "/", "aria-label": "Freepost home" },
    img("lg-mark on-light", "/brand/mark.png", 475, 225), img("lg-mark on-dark", "/brand/mark-light.png", 475, 225),
    img("lg-word on-light", "/brand/wordmark.png", 908, 192, "Freepost"), img("lg-word on-dark", "/brand/wordmark-light.png", 908, 192, "Freepost"));
}

// ---- form helpers -------------------------------------------------------------
export const field = (label: string, control: Child, hint?: string): HTMLElement =>
  h("div", { class: "field" }, h("label", {}, label), control, hint && h("span", { class: "hint" }, hint));

export const input = (props: Record<string, unknown> = {}): HTMLInputElement => h("input", { class: "input", ...props });

export function selectEl(options: ([string, string] | string)[], value = "", props: Record<string, unknown> = {}): HTMLSelectElement {
  const el = h("select", { class: "select", ...props }, options.map((o) => {
    const [v, label] = typeof o === "string" ? [o, o] : o;
    return h("option", { value: v, selected: v === value }, label);
  }));
  el.value = value;
  return el;
}

export const card = (title: string | null, ...children: Child[]): HTMLElement =>
  h("div", { class: "card" }, title ? h("div", { class: "card-head" }, h("h2", {}, title)) : null, ...children);

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { flush(): void; cancel(): void } {
  let t: number | undefined;
  let last: A | null = null;
  const run = (...a: A): void => { last = a; clearTimeout(t); t = window.setTimeout(() => { last = null; fn(...a); }, ms); };
  run.flush = () => { if (last) { clearTimeout(t); const a = last; last = null; fn(...a); } };
  run.cancel = () => { clearTimeout(t); last = null; };
  return run;
}

export const num = (n: number): string => n.toLocaleString();

/** Downloads an authenticated API response (CSV exports) as a file. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await fetch(path, { credentials: "same-origin", headers: { "x-freepost": "1" } });
  if (!res.ok) { toast("Download failed", "bad"); return; }
  const url = URL.createObjectURL(await res.blob());
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ModalHandle { close(): void; el: HTMLElement }

/** A simple dialog. Closes on Escape or a click outside. */
export function modal(title: string, body: Child, footer: Child[] = [], onClose?: () => void): ModalHandle {
  const previous = document.activeElement as HTMLElement | null;
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  const close = (): void => { document.removeEventListener("keydown", onKey); back.remove(); previous?.focus?.(); onClose?.(); };
  const back = h("div", { class: "modal-back", onclick: (e: Event) => { if (e.target === back) close(); } },
    h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "card-head" }, h("h2", {}, title), h("button", { class: "icon-x", type: "button", "aria-label": "Close", onclick: close }, "×")),
      h("div", { class: "modal-body" }, body),
      footer.length ? h("div", { class: "modal-foot" }, ...footer) : null));
  document.body.append(back);
  document.addEventListener("keydown", onKey);
  return { close, el: back };
}

export function bar(percent: number, label?: string): HTMLElement {
  return h("div", { class: "meter", title: label }, h("i", { style: `width:${Math.min(100, Math.max(0, percent))}%` }));
}

export function chips(values: string[], onRemove?: (v: string) => void): HTMLElement {
  return h("div", { class: "chips" }, values.map((v) => h("span", { class: "chip" }, v, onRemove && h("button", { type: "button", "aria-label": `Remove ${v}`, onclick: () => onRemove(v) }, "×"))));
}

export const statusBadge = (status: string): HTMLElement => {
  const tone: Record<string, string> = { active: "ok", live: "ok", sent: "ok", pending: "warn", scheduled: "warn", sending: "warn", paused: "warn", draft: "", unsubscribed: "", bounced: "bad", failed: "bad", completed: "ok", canceled: "" };
  return h("span", { class: `badge ${tone[status] ?? ""}` }, status.replace(/_/g, " "));
};
