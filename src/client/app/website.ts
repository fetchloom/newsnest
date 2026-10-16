import { api } from "./api.js";
import { h, replace } from "./dom.js";
import { blockEditor, imagePicker, loadEditorContext } from "./editor.js";
import type { Block } from "./editor.js";
import { colorField, confirmDialog, promptDialog } from "./controls.js";
import { busy, card, debounce, empty, field, input, pageHead, selectEl, statusBadge, toast } from "./ui.js";

export async function websitePage(): Promise<HTMLElement> {
  const [pub, pages] = await Promise.all([api("GET", "/publication"), api("GET", "/pages")]);
  const P = { ...pub, nav: [...pub.nav] };
  const text = (key: string, props: Record<string, unknown> = {}): HTMLInputElement => input({ value: P[key] ?? "", oninput: (e: Event) => { P[key] = (e.target as HTMLInputElement).value; }, ...props });

  const hex = text("brand_color", { placeholder: "#1663fe", style: "max-width:130px" });
  const color = colorField(P.brand_color, (c) => { P.brand_color = c; hex.value = c; });
  hex.addEventListener("input", () => { if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) color.set(hex.value); });

  const navBox = h("div", { class: "stack" });
  const drawNav = (): void => replace(navBox, ...P.nav.map((n: any, i: number) => h("div", { class: "opt-row" },
    input({ value: n.label, placeholder: "Label", oninput: (e: Event) => { n.label = (e.target as HTMLInputElement).value; } }), input({ value: n.url, placeholder: "https://… or /page", oninput: (e: Event) => { n.url = (e.target as HTMLInputElement).value; } }),
    h("button", { class: "ico-btn danger", type: "button", "aria-label": "Remove link", onclick: () => { P.nav.splice(i, 1); drawNav(); } }, "×"))),
    P.nav.length < 10 ? h("button", { class: "btn btn-ghost btn-sm", type: "button", style: "width:fit-content", onclick: () => { P.nav.push({ label: "", url: "" }); drawNav(); } }, "+ Menu link") : null);
  drawNav();

  const save = h("button", { class: "btn btn-solid", type: "button" }, "Save website settings");
  save.addEventListener("click", () => void busy(save, async () => {
    try {
      await api("PATCH", "/publication", { brand_color: P.brand_color, font: P.font, logo_url: P.logo_url, footer: P.footer, seo_title: P.seo_title, seo_description: P.seo_description, og_image_url: P.og_image_url, site_domain: P.site_domain, nav: P.nav.filter((n: any) => n.label && n.url) });
      toast("Saved");
    } catch (e) { toast((e as Error).message, "bad"); }
  }));

  const newPage = h("button", { class: "btn btn-solid btn-sm", type: "button" }, "New page");
  newPage.addEventListener("click", () => void busy(newPage, async () => { const t = await promptDialog("New page", "Page title", "About"); if (!t) return; const p = await api("POST", "/pages", { title: t, blocks: [{ type: "text", props: { markdown: "" } }], in_nav: true }); location.hash = `#/website/pages/${p.id}`; }));

  return h("div", { class: "view stack" },
    pageHead("Website", "A public site for your posts, with an archive, RSS and your own domain.", h("a", { class: "btn btn-ghost", href: "/p", target: "_blank", rel: "noopener" }, "View site"), save),
    h("div", { class: "split" },
      h("div", { class: "stack" },
        card("Look and feel", h("div", { class: "card-pad stack" },
          field("Brand color", h("div", { class: "row" }, color, hex), "Used for buttons and links on the site and in emails."),
          field("Font", selectEl([["sans", "Sans-serif"], ["serif", "Serif"], ["mono", "Monospace"]], P.font, { onchange: (e: Event) => { P.font = (e.target as HTMLSelectElement).value; } })),
          field("Logo", imagePicker(P.logo_url, (u) => { P.logo_url = u; }), "Shown in the site header and at the top of every email."),
          field("Footer text", text("footer", { placeholder: "Made with care in …" })))),
        card("Menu", h("div", { class: "card-pad stack" }, navBox, h("span", { class: "hint" }, "Pages you mark “in menu” are added automatically."))),
        card("Search engines and sharing", h("div", { class: "card-pad stack" }, field("Site title", text("seo_title", { placeholder: P.name })), field("Site description", text("seo_description", { placeholder: P.description })), field("Sharing image", imagePicker(P.og_image_url, (u) => { P.og_image_url = u; }), "Shown when links to your site are shared.")))),
      h("div", { class: "stack" },
        card("Your own domain", h("div", { class: "card-pad stack" }, field("Domain", text("site_domain", { placeholder: "news.yourdomain.com" })),
          h("p", { class: "small muted" }, "Point this domain's DNS at the server running Newsnest and put HTTPS in front of it (Caddy or nginx work well). Requests for it then show your site at the root, with no /p/ prefix. Also set the matching public URL in Settings so links in emails use it."))),
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Pages"), newPage),
          pages.data.length ? h("div", { class: "table-scroll" }, h("table", { class: "t" }, h("tbody", {}, pages.data.map((p: any) => h("tr", { class: "link", onclick: () => { location.hash = `#/website/pages/${p.id}`; } }, h("td", {}, p.title), h("td", { class: "muted small" }, `/p/${p.slug}`), h("td", {}, statusBadge(p.published ? "live" : "draft")))))))
            : empty("No pages yet", "Add an About page or a Contact page.")),
        card("Preview", h("iframe", { src: "/p", title: "Site preview", style: "width:100%;height:420px;border:0;background:var(--bg);border-radius:0 0 14px 14px" })))));
}

export async function pageEditor(id: string): Promise<HTMLElement> {
  const [page, ctx] = await Promise.all([api("GET", `/pages/${id}`), loadEditorContext()]);
  const S = { ...page };
  const state = h("span", { class: "save-state" }, "Saved");
  const save = debounce(async () => {
    state.textContent = "Saving…";
    try { const r = await api("PATCH", `/pages/${id}`, { title: S.title, slug: S.slug, blocks: S.blocks, published: S.published, in_nav: S.in_nav }); S.slug = r.slug; state.textContent = "Saved"; } catch (e) { state.textContent = "Not saved"; toast((e as Error).message, "bad"); }
  }, 800);
  const touch = (): void => { state.textContent = "Unsaved"; save(); };
  const editor = blockEditor({ blocks: S.blocks as Block[], ctx, onChange: (b) => { S.blocks = b; touch(); } });
  const del = h("button", { class: "btn btn-danger btn-sm", type: "button", onclick: () => void confirmDialog("Delete this page?", { title: "Delete page" }).then((ok) => ok && api("DELETE", `/pages/${id}`).then(() => { location.hash = "#/website"; })) }, "Delete");

  return h("div", { class: "view stack" },
    h("a", { class: "crumb", href: "#/website" }, "← Website"),
    h("div", { class: "editor-top" }, h("input", { class: "title-input", value: S.title, "aria-label": "Page title", oninput: (e: Event) => { S.title = (e.target as HTMLInputElement).value; touch(); } }), state, del),
    h("div", { class: "card card-pad stack" },
      h("div", { class: "split" }, field("Web address", input({ value: S.slug, oninput: (e: Event) => { S.slug = (e.target as HTMLInputElement).value; touch(); } }), "Appears as /p/your-address"), h("div", { class: "stack", style: "align-content:end" },
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.published, onchange: (e: Event) => { S.published = (e.target as HTMLInputElement).checked; touch(); } }), "Published"),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.in_nav, onchange: (e: Event) => { S.in_nav = (e.target as HTMLInputElement).checked; touch(); } }), "Show in the site menu"))),
      editor.el));
}
