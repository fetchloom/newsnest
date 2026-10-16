import { h } from "./dom.js";

export interface Command { label: string; hint?: string; run(): void }

/** Does `text` contain every letter of `query` in order? Substring matches rank first. */
function score(text: string, query: string): number {
  const t = text.toLowerCase();
  const at = t.indexOf(query);
  if (at >= 0) return 100 - at;
  let i = 0;
  for (const ch of t) if (ch === query[i]) i++;
  return i === query.length ? 1 : 0;
}

/** The ⌘K "jump to" box. */
export function openPalette(commands: Command[]): void {
  if (document.querySelector(".palette-back")) return;
  const previous = document.activeElement as HTMLElement | null;
  const input = h("input", { class: "palette-input", placeholder: "Jump to a page or action…", "aria-label": "Search commands", autocomplete: "off", spellcheck: false });
  const list = h("div", { class: "palette-list", role: "listbox" });
  let shown: Command[] = [];
  let active = 0;

  const close = (): void => { document.removeEventListener("keydown", onKey, true); back.remove(); previous?.focus?.(); };
  const run = (c: Command | undefined): void => { if (!c) return; close(); c.run(); };
  const draw = (): void => {
    const q = input.value.trim().toLowerCase();
    shown = (q ? commands.map((c) => [c, score(c.label, q)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([c]) => c) : commands).slice(0, 9);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...(shown.length
      ? shown.map((c, i) => h("div", { class: `palette-item${i === active ? " on" : ""}`, role: "option", "aria-selected": String(i === active), onclick: () => run(c), onmousemove: () => { if (active !== i) { active = i; draw(); } } }, h("span", {}, c.label), c.hint && h("em", {}, c.hint)))
      : [h("div", { class: "palette-empty" }, "Nothing matches that.")]));
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % Math.max(1, shown.length); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + shown.length) % Math.max(1, shown.length); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); run(shown[active]); }
  };
  input.addEventListener("input", () => { active = 0; draw(); });
  const back = h("div", { class: "modal-back palette-back", onclick: (e: Event) => { if (e.target === back) close(); } },
    h("div", { class: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Jump to" }, input, list));
  document.body.append(back);
  document.addEventListener("keydown", onKey, true);
  draw();
  input.focus();
}
