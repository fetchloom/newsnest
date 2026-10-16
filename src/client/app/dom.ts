export type Child = Node | string | number | false | null | undefined | Child[];
export type Props = Record<string, unknown>;

/** Tiny element builder. Strings become text nodes, never HTML, so API data can't inject markup. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (tag === "form") el.setAttribute("novalidate", ""); // the browser's validation bubbles are replaced by our own messages
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === "class") el.className = String(value);
    else if (key === "title" && tag !== "iframe") el.setAttribute("data-tip", String(value)); // native tooltips are replaced by controls.ts
    else if (key === "style" || key === "list" || key === "form" || key.startsWith("aria-") || key.startsWith("data-")) el.setAttribute(key, String(value));
    else if (key in el) (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

const SVG = "http://www.w3.org/2000/svg";
/** Stroke icon from a list of path data. */
export function icon(...paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
