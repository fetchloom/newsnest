import { api } from "./api.js";
import { h } from "./dom.js";
import { emptyRules, loadCatalog, rulesBuilder } from "./rules.js";
import type { Catalog } from "./rules.js";
import { field, input, selectEl, toast } from "./ui.js";

export interface Block { id: string; type: string; props: Record<string, any> }

export interface EditorCtx {
  polls: { id: string; question: string }[];
  surveys: { id: string; title: string }[];
  catalog: Catalog;
}

export async function loadEditorContext(): Promise<EditorCtx> {
  const [catalog, surveys] = await Promise.all([loadCatalog(), api("GET", "/surveys")]);
  return { polls: catalog.polls, surveys: surveys.data.map((s: any) => ({ id: s.id, title: s.title })), catalog };
}

const uid = (): string => "b" + Math.random().toString(36).slice(2, 10);

interface Def { label: string; hint: string; props: () => Record<string, any> }
const DEFS: Record<string, Def> = {
  text: { label: "Text", hint: "Paragraphs in Markdown", props: () => ({ markdown: "" }) },
  heading: { label: "Heading", hint: "A title for a section", props: () => ({ text: "", level: 2, align: "left" }) },
  image: { label: "Image", hint: "Upload or link a picture", props: () => ({ url: "", alt: "", link: "", width: null, caption: "" }) },
  button: { label: "Button", hint: "A link that stands out", props: () => ({ label: "Read more", url: "", align: "left" }) },
  divider: { label: "Divider", hint: "A thin line", props: () => ({}) },
  spacer: { label: "Spacer", hint: "Empty space", props: () => ({ height: 24 }) },
  quote: { label: "Quote", hint: "A pull quote", props: () => ({ text: "", cite: "" }) },
  list: { label: "List", hint: "Bullets or numbers", props: () => ({ style: "bullet", items: [] }) },
  code: { label: "Code", hint: "Monospaced block", props: () => ({ text: "" }) },
  html: { label: "HTML", hint: "Your own markup", props: () => ({ html: "" }) },
  social: { label: "Social links", hint: "Links to your profiles", props: () => ({ links: [{ network: "website", url: "" }] }) },
  poll: { label: "Poll", hint: "One-click voting in the email", props: () => ({ pollId: "" }) },
  survey: { label: "Survey", hint: "A button to a survey", props: () => ({ surveyId: "", label: "Take the survey" }) },
  referral: { label: "Referral", hint: "Their link, count and next reward", props: () => ({ title: "" }) },
  subscribe: { label: "Subscribe", hint: "Sign-up box for the web", props: () => ({ label: "Subscribe", text: "" }) },
  dynamic: { label: "Dynamic content", hint: "Only for matching subscribers", props: () => ({ rules: emptyRules(), blocks: [] }) },
};

export async function uploadImage(file: File): Promise<string> {
  if (file.size > 3.5 * 1024 * 1024) throw new Error("Images must be under 3.5 MB.");
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read that file."));
    r.readAsDataURL(file);
  });
  return (await api("POST", "/uploads", { filename: file.name, data })).url;
}

export function imagePicker(initial: string, onUrl: (url: string) => void): HTMLElement {
  const url = input({ value: initial, placeholder: "https://… or upload", oninput: () => onUrl(url.value) });
  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", style: "display:none", onchange: async () => {
    const f = file.files?.[0];
    if (!f) return;
    try { url.value = await uploadImage(f); onUrl(url.value); toast("Image uploaded"); } catch (e) { toast((e as Error).message, "bad"); }
    file.value = "";
  } });
  return h("div", { class: "row" }, h("div", { class: "grow" }, url), h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => file.click() }, "Upload"), file);
}

export interface BlockEditor { el: HTMLElement; get(): Block[]; set(blocks: Block[]): void }

/** A drag-and-drop block editor. Edits are made in place; `onChange` fires after each one. */
export function blockEditor(o: { blocks: Block[]; ctx: EditorCtx; onChange: (b: Block[]) => void; nested?: boolean }): BlockEditor {
  let blocks: Block[] = o.blocks.map((b) => ({ ...b, props: { ...b.props } }));
  const root = h("div", { class: o.nested ? "mini-editor" : "" });
  const list = h("div", { class: "blocks" });
  let dragFrom = -1;
  let menuHost: HTMLElement | null = null;

  const changed = (): void => o.onChange(blocks);
  const closeMenu = (): void => { menuHost?.remove(); menuHost = null; document.removeEventListener("click", closeMenu); };

  function openMenu(anchor: HTMLElement, insertAt: number): void {
    closeMenu();
    const types = Object.keys(DEFS).filter((t) => !(o.nested && t === "dynamic"));
    menuHost = h("div", { class: "menu", role: "menu" }, types.map((t) => h("button", { type: "button", role: "menuitem", onclick: () => {
      blocks.splice(insertAt, 0, { id: uid(), type: t, props: DEFS[t].props() });
      closeMenu(); render(); changed();
    } }, DEFS[t].label, h("small", {}, DEFS[t].hint))));
    anchor.parentElement!.style.position = "relative";
    anchor.parentElement!.append(menuHost);
    setTimeout(() => document.addEventListener("click", closeMenu), 0);
  }

  function form(b: Block): HTMLElement[] {
    const p = b.props;
    const on = (key: string) => (e: Event): void => { p[key] = (e.target as HTMLInputElement).value; changed(); };
    switch (b.type) {
      case "heading": return [input({ value: p.text, placeholder: "Heading", oninput: on("text"), "aria-label": "Heading text" }),
        h("div", { class: "row" }, selectEl([["1", "Large"], ["2", "Medium"], ["3", "Small"]], String(p.level), { onchange: (e: Event) => { p.level = Number((e.target as HTMLSelectElement).value); changed(); }, "aria-label": "Size" }), selectEl(["left", "center"], p.align, { onchange: on("align"), "aria-label": "Alignment" }))];
      case "text": return [h("textarea", { class: "textarea", placeholder: "Write in Markdown. **bold**, *italic*, [link](https://…), [[Button]](https://…)", oninput: on("markdown"), "aria-label": "Text" }, p.markdown),
        h("span", { class: "hint" }, "Merge tags: {{first_name | there}}, {{referral_link}}, {{unsubscribe_url}}")];
      case "image": {
        const prev = h("div", {}, thumb(p.url));
        return [imagePicker(p.url, (u) => { p.url = u; changed(); prev.replaceChildren(thumb(u)); }), prev,
          h("div", { class: "row" }, input({ value: p.alt, placeholder: "Alt text (for screen readers)", oninput: on("alt") }), input({ value: p.link, placeholder: "Link when clicked (optional)", oninput: on("link") })),
          h("div", { class: "row" }, input({ value: p.caption, placeholder: "Caption (optional)", oninput: on("caption") }), input({ value: p.width ?? "", type: "number", placeholder: "Width in px", oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; p.width = v ? Number(v) : null; changed(); } }))];
      }
      case "button": return [h("div", { class: "row" }, input({ value: p.label, placeholder: "Button text", oninput: on("label") }), input({ value: p.url, placeholder: "https://…", oninput: on("url") })), selectEl(["left", "center"], p.align, { onchange: on("align"), "aria-label": "Alignment" })];
      case "divider": return [h("span", { class: "hint" }, "A thin horizontal line.")];
      case "spacer": return [input({ type: "number", value: p.height, min: 4, max: 160, oninput: (e: Event) => { p.height = Number((e.target as HTMLInputElement).value) || 24; changed(); }, "aria-label": "Height in pixels" }), h("span", { class: "hint" }, "Height in pixels.")];
      case "quote": return [h("textarea", { class: "textarea", style: "min-height:80px", placeholder: "Quote", oninput: on("text") }, p.text), input({ value: p.cite, placeholder: "Who said it (optional)", oninput: on("cite") })];
      case "list": return [selectEl([["bullet", "Bullets"], ["number", "Numbers"]], p.style, { onchange: on("style") }), h("textarea", { class: "textarea", style: "min-height:100px", placeholder: "One item per line", oninput: (e: Event) => { p.items = (e.target as HTMLTextAreaElement).value.split("\n").map((s) => s.trim()).filter(Boolean); changed(); } }, (p.items as string[]).join("\n"))];
      case "code": return [h("textarea", { class: "textarea", placeholder: "Code", oninput: on("text") }, p.text)];
      case "html": return [h("textarea", { class: "textarea", placeholder: "<table>…</table>", oninput: on("html") }, p.html), h("span", { class: "hint" }, "Raw HTML is sent as written. Email clients support only a small part of HTML, so test it.")];
      case "social": {
        const rows = h("div", { class: "stack" });
        const draw = (): void => rows.replaceChildren(...(p.links as any[]).map((l, i) => h("div", { class: "opt-row" },
          selectEl(["website", "x", "instagram", "facebook", "linkedin", "youtube", "tiktok", "github", "mastodon", "bluesky", "threads", "email"], l.network, { onchange: (e: Event) => { l.network = (e.target as HTMLSelectElement).value; changed(); }, style: "max-width:140px" }),
          input({ value: l.url, placeholder: "https://…", oninput: (e: Event) => { l.url = (e.target as HTMLInputElement).value; changed(); } }),
          h("button", { class: "ico-btn danger", type: "button", "aria-label": "Remove link", onclick: () => { p.links.splice(i, 1); changed(); draw(); } }, "×"))));
        draw();
        return [rows, h("button", { class: "btn btn-ghost btn-sm", type: "button", style: "width:fit-content", onclick: () => { p.links.push({ network: "website", url: "" }); draw(); } }, "+ Link")];
      }
      case "poll": return [selectEl([["", "Choose a poll…"], ...o.ctx.polls.map((x) => [x.id, x.question] as [string, string])], p.pollId, { onchange: on("pollId") }), h("a", { class: "hint", href: "#/engage" }, "Create or manage polls →")];
      case "survey": return [selectEl([["", "Choose a survey…"], ...o.ctx.surveys.map((x) => [x.id, x.title] as [string, string])], p.surveyId, { onchange: on("surveyId") }), input({ value: p.label, placeholder: "Button text", oninput: on("label") })];
      case "referral": return [input({ value: p.title, placeholder: "Title (optional)", oninput: on("title") }), h("span", { class: "hint" }, "Shows each reader their personal link, how many people they've referred and the next reward. Turn the referral program on under Referrals.")];
      case "subscribe": return [input({ value: p.label, placeholder: "Button text", oninput: on("label") }), input({ value: p.text, placeholder: "Short pitch (optional)", oninput: on("text") }), h("span", { class: "hint" }, "A sign-up form on the website; a link in email.")];
      case "dynamic": {
        const inner = blockEditor({ blocks: p.blocks, ctx: o.ctx, nested: true, onChange: (nb) => { p.blocks = nb; changed(); } });
        return [h("span", { class: "label" }, "Show this to subscribers who match"), rulesBuilder(p.rules, changed, o.ctx.catalog), h("span", { class: "label" }, "Content"), inner.el];
      }
    }
    return [];
  }
  const thumb = (u: string): HTMLElement => (u ? h("img", { src: u, alt: "", style: "max-height:120px;border-radius:8px;border:1px solid var(--line)" }) : h("span", { class: "hint" }, "No image yet."));

  function card(b: Block, i: number): HTMLElement {
    const el = h("div", { class: "block", "data-id": b.id });
    const handle = h("span", { class: "handle", draggable: true, title: "Drag to reorder", "aria-label": "Drag to reorder" }, "⋮⋮");
    handle.addEventListener("dragstart", (e: DragEvent) => { dragFrom = i; el.classList.add("dragging"); e.dataTransfer?.setData("text/plain", b.id); if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setDragImage(el, 20, 20); } });
    handle.addEventListener("dragend", () => { el.classList.remove("dragging"); list.querySelectorAll(".drop-before,.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after")); dragFrom = -1; });
    el.addEventListener("dragover", (e: DragEvent) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      el.classList.toggle("drop-before", before);
      el.classList.toggle("drop-after", !before);
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
    el.addEventListener("drop", (e: DragEvent) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      let to = e.clientY < r.top + r.height / 2 ? i : i + 1;
      const [moved] = blocks.splice(dragFrom, 1);
      if (dragFrom < to) to--;
      blocks.splice(to, 0, moved);
      dragFrom = -1; render(); changed();
    });
    const move = (d: number): void => { const j = i + d; if (j < 0 || j >= blocks.length) return; [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; render(); changed(); };
    el.append(
      h("div", { class: "block-head" }, handle, h("span", { class: "block-type" }, DEFS[b.type]?.label ?? b.type),
        h("button", { class: "ico-btn", type: "button", "aria-label": "Move up", disabled: i === 0, onclick: () => move(-1) }, "↑"),
        h("button", { class: "ico-btn", type: "button", "aria-label": "Move down", disabled: i === blocks.length - 1, onclick: () => move(1) }, "↓"),
        h("button", { class: "ico-btn", type: "button", "aria-label": "Duplicate block", onclick: () => { blocks.splice(i + 1, 0, { id: uid(), type: b.type, props: JSON.parse(JSON.stringify(b.props)) }); render(); changed(); } }, "⧉"),
        h("button", { class: "ico-btn", type: "button", "aria-label": "Add block below", onclick: (e: Event) => { e.stopPropagation(); openMenu(e.currentTarget as HTMLElement, i + 1); } }, "+"),
        h("button", { class: "ico-btn danger", type: "button", "aria-label": "Delete block", onclick: () => { blocks.splice(i, 1); render(); changed(); } }, "×")),
      h("div", { class: "block-body" }, ...form(b)));
    return el;
  }

  function render(): void {
    list.replaceChildren(...blocks.map(card));
    if (!blocks.length) list.append(h("div", { class: "empty", style: "padding:28px" }, h("b", {}, "Empty"), "Add your first block below."));
  }

  const addButton = h("button", { class: "btn btn-ghost", type: "button", onclick: (e: Event) => { e.stopPropagation(); openMenu(e.currentTarget as HTMLElement, blocks.length); } }, "+ Add block");
  root.append(list, h("div", { class: "add-block", style: "margin-top:10px" }, addButton));
  render();

  return { el: root, get: () => blocks, set: (b) => { blocks = b.map((x) => ({ ...x, props: { ...x.props } })); render(); } };
}
