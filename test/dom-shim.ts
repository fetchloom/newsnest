/**
 * A tiny fake DOM, just enough to render the dashboard's views and click through them in tests,
 * without a browser. It supports the element API the app uses; it does not do layout or CSS.
 */
type Listener = (e: any) => void;

export class FakeNode {
  parentNode: FakeElement | null = null;
  get isConnected(): boolean { let n: FakeNode | null = this; while (n) { if (n === (globalThis as any).document?.body) return true; n = n.parentNode; } return false; }
}
export class FakeText extends FakeNode {
  data: string;
  constructor(d: string) { super(); this.data = d; }
  get textContent(): string { return this.data; }
  remove(): void { this.parentNode?.removeChild(this); }
}

const PROPS: Record<string, unknown> = { value: undefined, checked: false, disabled: false, selected: false, required: false, readOnly: false, multiple: false, draggable: false, open: false };
const REFLECT = new Set(["id", "type", "title", "href", "src", "srcdoc", "placeholder", "name", "download", "target", "rel", "min", "max", "step", "minLength", "maxLength", "list", "accept", "rows", "autocomplete", "autofocus", "sandbox", "loading", "tabindex", "role", "for", "htmlFor", "width", "height", "alt", "colSpan"]);

export class FakeElement extends FakeNode {
  tagName: string;
  childNodes: FakeNode[] = [];
  attributes = new Map<string, string>();
  props: Record<string, unknown> = {};
  listeners = new Map<string, Listener[]>();
  style: { cssText: string; [k: string]: unknown } = { cssText: "" };
  constructor(tag: string) { super(); this.tagName = tag.toUpperCase(); }

  get children(): FakeElement[] { return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement); }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get parentElement(): FakeElement | null { return this.parentNode; }
  get className(): string { return this.attributes.get("class") ?? ""; }
  set className(v: string) { this.attributes.set("class", v); }
  get classList() {
    const self = this;
    const get = (): string[] => self.className.split(/\s+/).filter(Boolean);
    const add = (...c: string[]): void => { self.className = [...new Set([...get(), ...c])].join(" "); };
    const remove = (...c: string[]): void => { self.className = get().filter((x) => !c.includes(x)).join(" "); };
    return {
      add, remove,
      toggle: (c: string, force?: boolean) => { const has = get().includes(c); const on = force ?? !has; if (on !== has) (on ? add : remove)(c); return on; },
      contains: (c: string) => get().includes(c),
    };
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attributes) if (k.startsWith("data-")) out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    return out;
  }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.replaceChildren(String(v)); }
  get options(): FakeElement[] { return this.children.filter((c) => c.tagName === "OPTION"); }
  get files(): unknown { return this.props.files ?? null; }

  // Like the real DOM: anything that is not a Node becomes text, so append(null) inserts the word "null".
  append(...nodes: unknown[]): void { for (const n of nodes) this.appendChild(n instanceof FakeNode ? n : new FakeText(String(n))); }
  appendChild<T extends FakeNode>(n: T): T { n.parentNode?.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n: FakeNode): void { const i = this.childNodes.indexOf(n); if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; } }
  insertBefore(n: FakeNode, ref: FakeNode | null): FakeNode { n.parentNode?.removeChild(n); n.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n); return n; }
  replaceChildren(...nodes: unknown[]): void { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...nodes); }
  remove(): void { this.parentNode?.removeChild(this); }
  cloneNode(): FakeElement { const c = new FakeElement(this.tagName); c.attributes = new Map(this.attributes); c.props = { ...this.props }; for (const k of this.childNodes) c.appendChild(k instanceof FakeElement ? k.cloneNode() : new FakeText((k as FakeText).data)); return c; }
  setAttribute(k: string, v: string): void { this.attributes.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attributes.get(k) ?? null; }
  removeAttribute(k: string): void { this.attributes.delete(k); }
  hasAttribute(k: string): boolean { return this.attributes.has(k); }
  addEventListener(t: string, fn: Listener): void { this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]); }
  removeEventListener(t: string, fn: Listener): void { this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f) => f !== fn)); }
  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    const ev = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, clientY: 0, key: "", ...extra };
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    if (type === "click" && this.parentNode && !(ev as any).__stop) { /* bubbling is only needed for document-level listeners, handled by dispatchClick */ }
  }
  click(): void { if (!this.props.disabled) { this.dispatch("click"); for (const fn of (globalThis as any).document.listeners.get("click") ?? []) fn({ type: "click", target: this }); } }
  focus(): void { (globalThis as any).document.activeElement = this; }
  blur(): void { /* no-op */ }
  scrollIntoView(): void { /* no-op */ }
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 40, right: 100, bottom: 40 }; }

  querySelectorAll(sel: string): FakeElement[] {
    const tests = sel.split(",").map((s) => s.trim()).map(compile);
    const out: FakeElement[] = [];
    const walk = (n: FakeElement): void => { for (const c of n.children) { if (tests.some((t) => t(c))) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeElement | null { return this.querySelectorAll(sel)[0] ?? null; }
  closest(): null { return null; }
}

for (const [name, def] of Object.entries(PROPS)) {
  Object.defineProperty(FakeElement.prototype, name, {
    get(this: FakeElement) {
      if (name === "value" && this.tagName === "SELECT" && this.props.value === undefined) return this.options[0]?.props.value ?? this.options[0]?.attributes.get("value") ?? "";
      if (name === "value" && this.props.value === undefined) return this.attributes.get("value") ?? (this.tagName === "TEXTAREA" ? this.textContent : "");
      return this.props[name] ?? def;
    },
    set(this: FakeElement, v: unknown) { this.props[name] = v; if (typeof v === "boolean") { v ? this.attributes.set(name, "") : this.attributes.delete(name); } },
    configurable: true,
  });
}
for (const name of REFLECT) {
  Object.defineProperty(FakeElement.prototype, name, { get(this: FakeElement) { return this.attributes.get(name) ?? ""; }, set(this: FakeElement, v: unknown) { this.attributes.set(name, String(v)); }, configurable: true });
}
// the <option>'s own value
Object.defineProperty(FakeElement.prototype, "label", { get() { return this.textContent; }, configurable: true });

function compile(sel: string): (e: FakeElement) => boolean {
  const m = /^([a-z0-9]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel);
  if (!m) throw new Error(`fake DOM: unsupported selector ${sel}`);
  const [, tag, classes, attrs] = m;
  const cls = classes.split(".").filter(Boolean);
  const attrTests = [...attrs.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map(([, k, v]) => ({ k, v }));
  return (e) => (!tag || e.tagName === tag.toUpperCase()) && cls.every((c) => e.classList.contains(c)) && attrTests.every(({ k, v }) => (v === undefined ? e.hasAttribute(k) : (e.attributes.get(k) ?? (e.props[k] != null ? String(e.props[k]) : undefined)) === v));
}

export function installDom(): { reset(): void } {
  const g = globalThis as any;
  const body = new FakeElement("body");
  const head = new FakeElement("head");
  const docListeners = new Map<string, Listener[]>();
  const root = new FakeElement("html");
  root.setAttribute("data-theme", "light");
  const store = new Map<string, string>();
  g.document = {
    body, head, documentElement: root, activeElement: null, listeners: docListeners,
    createElement: (t: string) => new FakeElement(t),
    createElementNS: (_: string, t: string) => new FakeElement(t),
    createTextNode: (d: string) => new FakeText(d),
    getElementById: (id: string) => body.querySelector(`[id="${id}"]`),
    querySelector: (s: string) => body.querySelector(s),
    querySelectorAll: (s: string) => body.querySelectorAll(s),
    addEventListener: (t: string, fn: Listener) => docListeners.set(t, [...(docListeners.get(t) ?? []), fn]),
    removeEventListener: (t: string, fn: Listener) => docListeners.set(t, (docListeners.get(t) ?? []).filter((f) => f !== fn)),
  };
  g.window = g;
  g.location = { hash: "", reload() { g.__reloaded = (g.__reloaded ?? 0) + 1; } };
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) };
  Object.defineProperty(g, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true });
  // The browser's own dialogs are banned: the dashboard uses its own (controls.ts).
  for (const name of ["alert", "confirm", "prompt"]) g[name] = () => { throw new Error(`native ${name}() used`); };
  g.scrollTo = () => {};
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.dispatchEvent = () => true;
  return { reset: () => { body.replaceChildren(); g.__reloaded = 0; docListeners.clear(); } };
}

/** All text under a node, whitespace-collapsed. */
export const textOf = (n: FakeNode): string => n.textContent.replace(/\s+/g, " ").trim();

export const find = (root: FakeElement, sel: string): FakeElement => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`not found: ${sel}`);
  return el;
};

/** The first element (any tag) whose own text is `label`, for clicking buttons by name. */
export function byText(root: FakeElement, tag: string, label: string | RegExp): FakeElement {
  const hit = root.querySelectorAll(tag).find((e) => (label instanceof RegExp ? label.test(textOf(e)) : textOf(e) === label));
  if (!hit) throw new Error(`no <${tag}> with text ${label}`);
  return hit;
}

/** Types into an input and fires the events a browser would. */
export function type(el: FakeElement, value: string): void { el.value = value; el.dispatch("input"); el.dispatch("change"); }
