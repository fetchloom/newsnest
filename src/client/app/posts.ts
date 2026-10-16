import { api } from "./api.js";
import { h, replace } from "./dom.js";
import { blockEditor, imagePicker, loadEditorContext } from "./editor.js";
import type { Block } from "./editor.js";
import { confirmDialog, dateTimeField, promptDialog } from "./controls.js";
import { ago, busy, debounce, empty, field, fullDate, input, modal, num, pageHead, selectEl, statusBadge, toast } from "./ui.js";

// ---- list ---------------------------------------------------------------------
export async function postsList(query: URLSearchParams): Promise<HTMLElement> {
  const status = query.get("status") ?? "";
  const posts = (await api("GET", `/posts${status ? `?status=${status}` : ""}`)).data as any[];
  const tab = (label: string, value: string): HTMLElement =>
    h("button", { class: "tab", role: "tab", type: "button", "aria-selected": String(status === value), onclick: () => { location.hash = value ? `#/posts?status=${value}` : "#/posts"; } }, label);

  return h("div", { class: "view stack" },
    pageHead("Posts", "Write once. Send it by email, publish it on your website, or both.", h("a", { class: "btn btn-solid", href: "#/posts/new" }, "New post")),
    h("div", { class: "card", style: "overflow:hidden" },
      h("div", { class: "tabs", role: "tablist" }, tab("All", ""), tab("Drafts", "draft"), tab("Scheduled", "scheduled"), tab("Sent", "sent")),
      posts.length
        ? h("div", { class: "table-scroll" }, h("table", { class: "t" },
            h("thead", {}, h("tr", {}, h("th", {}, "Title"), h("th", {}, "Status"), h("th", {}, "Audience"), h("th", { class: "num" }, "Recipients"), h("th", {}, "When"))),
            h("tbody", {}, posts.map((p) => h("tr", { class: "link", onclick: () => { location.hash = `#/posts/${p.id}`; } },
              h("td", { class: "clip" }, p.title, p.web_enabled && p.published_at ? h("span", { class: "muted small" }, "  · on website") : null),
              h("td", {}, statusBadge(p.status)),
              h("td", { class: "muted small" }, p.audience === "all" ? "All subscribers" : p.audience.replace(":", ": ")),
              h("td", { class: "num" }, p.recipients ? num(p.recipients) : "—"),
              h("td", { class: "muted small", title: fullDate(p.sent_at ?? p.send_at ?? p.created_at) }, p.sent_at ? `sent ${ago(p.sent_at)}` : p.send_at ? `for ${fullDate(p.send_at)}` : `edited ${ago(p.updated_at)}`))))))
        : empty("No posts here", status ? "Nothing with that status." : "Start your first post from a template."),
    ));
}

export async function newPost(): Promise<HTMLElement> {
  const templates = (await api("GET", "/templates")).data as any[];
  const pick = (t: any): void => {
    void api("POST", "/posts", { template_id: t.id, title: t.id === "tpl_blank" ? "Untitled" : t.name }).then((p) => { location.hash = `#/posts/${p.id}`; }, (e) => toast((e as Error).message, "bad"));
  };
  return h("div", { class: "view stack" }, h("a", { class: "crumb", href: "#/posts" }, "← Posts"), pageHead("New post", "Pick a starting point. You can change everything afterwards."),
    h("div", { class: "stats-grid", style: "grid-template-columns:repeat(auto-fill,minmax(220px,1fr))" }, templates.map((t) =>
      h("button", { class: "stat-card", type: "button", style: "text-align:left;cursor:pointer;font:inherit;color:inherit", onclick: () => pick(t) },
        h("div", { style: "font:650 18px var(--display);letter-spacing:-.02em" }, t.name), h("div", { class: "l" }, `${t.blocks.length} blocks${t.builtin ? "" : " · yours"}`)))));
}

// ---- editor -------------------------------------------------------------------
export async function postEditor(id: string): Promise<HTMLElement> {
  const [post, ctx, pubSettings, tags, segments] = await Promise.all([
    api("GET", `/posts/${encodeURIComponent(id)}`), loadEditorContext(), api("GET", "/publication"), api("GET", "/fields"), api("GET", "/segments"),
  ]);
  const S = { ...post } as any;
  const locked = S.status === "sending";
  const saveState = h("span", { class: "save-state", "aria-live": "polite" }, "Saved");
  let dirty = false;

  const save = debounce(async () => {
    saveState.textContent = "Saving…";
    try {
      const res = await api("PATCH", `/posts/${S.id}`, {
        title: S.title, subject: S.subject, preview_text: S.preview_text, blocks: S.blocks, audience: S.audience, access: S.access, web_enabled: S.web_enabled, email_enabled: S.email_enabled,
        author: S.author, slug: S.slug, seo_title: S.seo_title, seo_description: S.seo_description, cover_url: S.cover_url, ab: S.ab, from_name: S.from_name || "", from_email: S.from_email || "",
      });
      S.slug = res.slug;
      dirty = false;
      saveState.textContent = "Saved";
    } catch (e) { saveState.textContent = "Not saved"; toast((e as Error).message, "bad"); }
  }, 800);
  const touch = (): void => { dirty = true; saveState.textContent = "Unsaved"; save(); refreshPreview(); };

  // --- preview ---
  const frame = h("iframe", { title: "Preview", sandbox: "" });
  let previewMode: "email" | "web" = "email";
  const previewAs = input({ placeholder: "Preview as subscriber (email, optional)", "aria-label": "Preview as", oninput: () => refreshPreview() });
  const refreshPreview = debounce(async () => {
    try {
      const r = await api("POST", `/posts/${S.id}/preview`, { mode: previewMode, blocks: S.blocks, title: S.title, subject: S.subject, preview_text: S.preview_text, subscriber: previewMode === "email" ? previewAs.value.trim() : "" });
      frame.srcdoc = r.html;
    } catch (e) { frame.srcdoc = `<p style="font:14px system-ui;padding:16px;color:#b00">${String((e as Error).message).replace(/</g, "&lt;")}</p>`; }
  }, 500);

  const editor = blockEditor({ blocks: S.blocks, ctx, onChange: (b: Block[]) => { S.blocks = b; touch(); } });

  // --- settings pieces ---
  const bind = (key: string, el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): typeof el => { el.addEventListener("input", () => { S[key] = el.value; touch(); }); return el; };
  const audienceKind = selectEl([["all", "All active subscribers"], ["tag", "Subscribers with a tag"], ["segment", "A segment"]], S.audience.split(":")[0]);
  const audienceVal = h("div");
  const estimate = h("span", { class: "hint" });
  const estimateNow = debounce(async () => {
    try {
      const [kind, ...rest] = S.audience.split(":");
      const q = new URLSearchParams({ status: "active", limit: "1" });
      if (kind === "tag" && rest.join(":")) q.set("tag", rest.join(":"));
      if (kind === "segment" && rest.join(":")) q.set("segment", rest.join(":"));
      estimate.textContent = `About ${num((await api("GET", `/subscribers?${q}`)).total)} active subscribers will receive this.`;
    } catch { estimate.textContent = ""; }
  }, 300);
  const drawAudience = (): void => {
    const [kind, ...rest] = S.audience.split(":");
    const v = rest.join(":");
    replace(audienceVal, kind === "tag"
      ? input({ value: v, placeholder: "tag name", list: "post-tags", oninput: (e: Event) => { S.audience = `tag:${(e.target as HTMLInputElement).value}`; touch(); estimateNow(); } })
      : kind === "segment"
        ? selectEl([["", "Choose a segment…"], ...segments.data.map((s: any) => [s.id, `${s.name} (${s.active_subscribers})`] as [string, string])], v, { onchange: (e: Event) => { S.audience = `segment:${(e.target as HTMLSelectElement).value}`; touch(); estimateNow(); } })
        : null);
    estimateNow();
  };
  audienceKind.addEventListener("change", () => { S.audience = audienceKind.value === "all" ? "all" : `${audienceKind.value}:`; drawAudience(); touch(); });
  drawAudience();

  const subject = bind("subject", input({ value: S.subject, placeholder: S.title || "Defaults to the title" }));
  const settingsPanel = h("div", { class: "modal-body stack" },
    field("Email subject", subject, "Merge tags work here: {{first_name | friend}}"),
    field("Preview text", bind("preview_text", input({ value: S.preview_text, placeholder: "Shown next to the subject in the inbox", maxLength: 300 }))),
    field("Send to", h("div", { class: "stack" }, audienceKind, audienceVal, estimate, h("datalist", { id: "post-tags" }, tags.tags.map((t: any) => h("option", { value: t.tag }))))),
    field("Author", bind("author", input({ value: S.author, placeholder: "Shown on the website" }))),
    h("details", { class: "more" }, h("summary", {}, "Use a different sender for this post"),
      h("div", { class: "stack" }, field("From name", bind("from_name", input({ value: S.from_name ?? "", placeholder: pubSettings.from_name || pubSettings.name }))), field("From email", bind("from_email", input({ value: S.from_email ?? "", placeholder: pubSettings.from_email || "news@yourdomain.com" }))))),
  );

  const webPanel = h("div", { class: "modal-body stack" },
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.email_enabled, onchange: (e: Event) => { S.email_enabled = (e.target as HTMLInputElement).checked; touch(); } }), "Send by email"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.web_enabled, onchange: (e: Event) => { S.web_enabled = (e.target as HTMLInputElement).checked; touch(); } }), "Show on the website"),
    field("Who can read it on the website", selectEl([["public", "Everyone"], ["subscribers", "Subscribers only (they sign in with an email link)"]], S.access, { onchange: (e: Event) => { S.access = (e.target as HTMLSelectElement).value; touch(); } })),
    field("Web address", bind("slug", input({ value: S.slug })), `${pubSettings.base_url}/p/${S.slug}`),
    field("Cover image", imagePicker(S.cover_url, (u) => { S.cover_url = u; touch(); })),
    field("SEO title", bind("seo_title", input({ value: S.seo_title, placeholder: S.title }))),
    field("SEO description", bind("seo_description", h("textarea", { class: "textarea", style: "min-height:70px;font-family:var(--sans);font-size:14.5px", maxLength: 600 }, S.seo_description) as HTMLTextAreaElement)),
    S.web_enabled && S.status !== "draft" ? null : h("span", { class: "hint" }, "A post goes on the website when it's sent, or when you publish it yourself."),
    publishControls(),
  );

  function publishControls(): HTMLElement {
    const box = h("div", { class: "row" });
    const draw = (): void => {
      const live = !!S.published_at;
      const b = h("button", { class: `btn btn-sm ${live ? "btn-ghost" : "btn-solid"}`, type: "button" }, live ? "Unpublish from website" : "Publish to website now");
      b.addEventListener("click", () => void busy(b, async () => { dirty && save.flush(); const r = await api("POST", `/posts/${S.id}/${live ? "unpublish" : "publish"}`); S.published_at = r.published_at; S.url = r.url; draw(); toast(live ? "Unpublished" : "Published"); }));
      replace(box, b, S.url ? h("a", { class: "btn btn-ghost btn-sm", href: S.url, target: "_blank", rel: "noopener" }, "View live") : null);
    };
    draw();
    return box;
  }

  // --- A/B test ---
  S.ab = S.ab?.enabled ? S.ab : { enabled: false, variants: [{ subject: "" }, { subject: "" }], test_percent: 20, metric: "opens", wait_minutes: 240 };
  const abBody = h("div", { class: "stack" });
  const drawAb = (): void => {
    const ab = S.ab;
    abBody.replaceChildren(
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: ab.enabled, onchange: (e: Event) => { ab.enabled = (e.target as HTMLInputElement).checked; touch(); drawAb(); } }), "Test subject lines on part of the audience"),
      ab.enabled ? h("div", { class: "stack" },
        ...ab.variants.map((v: any, i: number) => field(`Variant ${"ABCD"[i]}`, h("div", { class: "opt-row" }, input({ value: v.subject ?? "", placeholder: i === 0 ? S.subject || S.title : "Another subject line", oninput: (e: Event) => { v.subject = (e.target as HTMLInputElement).value; touch(); } }),
          i >= 2 ? h("button", { class: "ico-btn danger", type: "button", "aria-label": "Remove variant", onclick: () => { ab.variants.splice(i, 1); touch(); drawAb(); } }, "×") : null))),
        ab.variants.length < 4 ? h("button", { class: "btn btn-ghost btn-sm", type: "button", style: "width:fit-content", onclick: () => { ab.variants.push({ subject: "" }); drawAb(); } }, "+ Variant") : null,
        h("div", { class: "split" },
          field("Test group (% of audience)", input({ type: "number", min: 5, max: 50, value: ab.test_percent, oninput: (e: Event) => { ab.test_percent = Number((e.target as HTMLInputElement).value); touch(); } })),
          field("Winner is the best…", selectEl([["opens", "open rate"], ["clicks", "verified click rate"]], ab.metric, { onchange: (e: Event) => { ab.metric = (e.target as HTMLSelectElement).value; touch(); } }))),
        field("Wait before choosing (hours)", input({ type: "number", min: 0.25, step: 0.25, value: ab.wait_minutes / 60, oninput: (e: Event) => { ab.wait_minutes = Math.round(Number((e.target as HTMLInputElement).value) * 60); touch(); } }), "The winning subject is sent to everyone else after this wait."),
      ) : h("span", { class: "hint" }, "Send different subject lines to a small share of subscribers first. The best one goes to the rest."),
    );
  };
  drawAb();
  const abPanel = h("div", { class: "modal-body" }, abBody);

  // --- tabs ---
  const panels: Record<string, HTMLElement> = {
    Preview: h("div", {}, h("div", { class: "toolbar" },
      selectEl([["email", "Email"], ["web", "Website"]], "email", { style: "width:auto", "aria-label": "Preview type", onchange: (e: Event) => { previewMode = (e.target as HTMLSelectElement).value as "email" | "web"; refreshPreview(); } }), previewAs), frame),
    Settings: settingsPanel, "A/B test": abPanel, Website: webPanel,
  };
  const tabBar = h("div", { class: "tabs panel-tabs", role: "tablist" });
  const stage = h("div");
  const select = (name: string): void => { tabBar.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.textContent === name))); stage.replaceChildren(panels[name]); };
  for (const name of Object.keys(panels)) tabBar.append(h("button", { class: "tab", role: "tab", type: "button", onclick: () => select(name) }, name));
  select("Preview");

  // --- actions ---
  const title = h("input", { class: "title-input", value: S.title, placeholder: "Title", "aria-label": "Post title", maxLength: 300, oninput: (e: Event) => { S.title = (e.target as HTMLInputElement).value; subject.placeholder = S.title || "Defaults to the title"; touch(); } });
  const actions = h("div", { class: "row" });

  function sendDialog(): void {
    const when = dateTimeField(); when.disabled = true;
    const mode = h("div", { class: "stack" },
      h("label", { class: "check" }, h("input", { type: "radio", name: "when", value: "now", checked: true, onchange: () => { when.disabled = true; } }), "Send now"),
      h("label", { class: "check" }, h("input", { type: "radio", name: "when", value: "later", onchange: () => { when.disabled = false; } }), "Schedule for later"), when);
    const warnings: string[] = [];
    if (!(S.from_email || pubSettings.from_email)) warnings.push("No From address yet. Set one in Settings.");
    if (pubSettings.base_url_is_local) warnings.push("Your public URL is localhost, so links in the email won't work for readers. Set it in Settings.");
    if (!pubSettings.address) warnings.push("Add a postal address in Settings. Most countries require one in marketing email.");
    if (pubSettings.mode === "outbox") warnings.push("Outbox mode: emails are saved as files, not delivered.");
    const confirmBtn = h("button", { class: "btn btn-solid", type: "button" }, "Send");
    const m = modal("Send this post", h("div", { class: "stack" },
      h("div", {}, h("b", {}, S.subject || S.title), h("div", { class: "muted small" }, S.audience === "all" ? "To all active subscribers" : `To ${S.audience.replace(":", ": ")}`), estimate.cloneNode(true)),
      S.ab.enabled ? h("div", { class: "notice" }, `A/B test: ${S.ab.variants.length} subject lines on ${S.ab.test_percent}% first.`) : null,
      ...warnings.map((w) => h("div", { class: "notice warn" }, w)), mode),
      [h("button", { class: "btn btn-ghost", type: "button", onclick: () => m.close() }, "Cancel"), confirmBtn]);
    confirmBtn.addEventListener("click", () => void busy(confirmBtn, async () => {
      save.flush();
      const later = (m.el.querySelector('input[value="later"]') as HTMLInputElement | null)?.checked;
      await api("POST", `/posts/${S.id}/schedule`, later && when.value ? { send_at: new Date(when.value).toISOString() } : {});
      m.close();
      toast(later ? "Scheduled" : "Sending");
      location.reload();
    }));
  }

  function testDialog(): void {
    const to = input({ placeholder: "you@example.com, another@example.com" });
    const go = h("button", { class: "btn btn-solid", type: "button" }, "Send test");
    const m = modal("Send a test email", h("div", { class: "stack" }, field("To", to, "Up to 5 addresses. Test emails aren't tracked."), ), [go]);
    go.addEventListener("click", () => void busy(go, async () => {
      save.flush();
      const r = await api("POST", `/posts/${S.id}/test`, { to: to.value.split(/[,\s]+/).filter(Boolean) });
      toast(r.sent ? `Sent to ${r.sent}` : "Couldn't send. Check Settings.", r.sent ? "ok" : "bad");
      m.close();
    }));
  }

  const drawActions = (): void => {
    const test = h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: testDialog }, "Send test");
    const more = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "More");
    more.addEventListener("click", () => {
      const dup = h("button", { class: "btn btn-ghost", type: "button" }, "Duplicate");
      const tpl = h("button", { class: "btn btn-ghost", type: "button" }, "Save as template");
      const del = h("button", { class: "btn btn-danger", type: "button" }, "Delete post");
      const m = modal("Post actions", h("div", { class: "stack" }, dup, tpl, del));
      dup.addEventListener("click", () => void busy(dup, async () => { const p = await api("POST", `/posts/${S.id}/duplicate`); m.close(); location.hash = `#/posts/${p.id}`; }));
      tpl.addEventListener("click", () => void busy(tpl, async () => { const name = await promptDialog("Save as template", "Template name", S.title, "Save"); if (!name) return; save.flush(); await api("POST", "/templates", { name, from_post: S.id }); toast("Template saved"); m.close(); }));
      del.addEventListener("click", () => void busy(del, async () => { if (!(await confirmDialog("Delete this post? This can't be undone.", { title: "Delete post" }))) return; await api("DELETE", `/posts/${S.id}`); m.close(); location.hash = "#/posts"; }));
    });
    const primary =
      S.status === "draft" ? h("button", { class: "btn btn-solid btn-sm", type: "button", disabled: !S.email_enabled, onclick: sendDialog }, "Send…")
      : S.status === "scheduled" ? h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => void api("POST", `/posts/${S.id}/unschedule`).then(() => location.reload(), (e) => toast((e as Error).message, "bad")) }, `Scheduled ${fullDate(S.send_at)} · Unschedule`)
      : h("a", { class: "btn btn-solid btn-sm", href: `#/posts/${S.id}/stats` }, S.status === "sending" ? "Sending… view progress" : "View stats");
    actions.replaceChildren(test, more, primary);
  };
  drawActions();

  const error = S.ab_state?.error ? h("div", { class: "notice bad" }, `The last send attempt failed: ${S.ab_state.error}`) : null;
  refreshPreview();
  window.addEventListener("beforeunload", (e) => { if (dirty) { save.flush(); e.preventDefault(); } });

  return h("div", { class: "view stack" },
    h("a", { class: "crumb", href: "#/posts" }, "← Posts"),
    h("div", { class: "editor-top" }, title, saveState, statusBadge(S.status), actions),
    locked ? h("div", { class: "notice warn" }, "This post is being sent, so its content is locked until it finishes.") : null, error,
    h("div", { class: "editor-shell" },
      h("div", {}, editor.el),
      h("div", { class: "card side-panel" }, tabBar, stage)));
}

