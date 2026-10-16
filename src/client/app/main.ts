import { analyticsPage, postStatsPage } from "./analytics.js";
import { api } from "./api.js";
import { authScreen } from "./auth.js";
import { installControls } from "./controls.js";
import { automationEditor, automationsList } from "./automations.js";
import { domainsPage } from "./domains.js";
import { h, icon, replace } from "./dom.js";
import { emailDetail, emailList } from "./emails.js";
import { engagePage } from "./engage.js";
import { formsPage } from "./forms.js";
import { keysPage } from "./keys.js";
import { startLive, stopLive } from "./live.js";
import { overview } from "./overview.js";
import { openPalette } from "./palette.js";
import type { Command } from "./palette.js";
import { newPost, postEditor, postsList } from "./posts.js";
import { referralsPage } from "./referrals.js";
import { segmentEditor, segmentsList } from "./segments.js";
import { sendPage } from "./send.js";
import { settingsPage } from "./settings.js";
import { subscriberDetail, subscribersList } from "./subscribers.js";
import { suppressionsPage } from "./suppressions.js";
import { logo, toast } from "./ui.js";
import { webhooksPage } from "./webhooks.js";
import { pageEditor, websitePage } from "./website.js";

const root = document.getElementById("root")!; // absent when the module is loaded by tests

type NavItem = [label: string, path: string, svg: string[]];
const NAV: { group: string | null; items: NavItem[] }[] = [
  { group: null, items: [["Overview", "", ["M4 13h6V4H4zM14 20h6V11h-6zM14 8h6V4h-6zM4 20h6v-3H4z"]]] },
  { group: "Publish", items: [
    ["Posts", "posts", ["M5 4h14v16H5z", "M8 9h8M8 13h8M8 17h5"]],
    ["Website", "website", ["M12 3a9 9 0 100 18 9 9 0 000-18z", "M3 12h18", "M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"]],
  ] },
  { group: "Audience", items: [
    ["Subscribers", "subscribers", ["M16 11a4 4 0 10-8 0 4 4 0 008 0z", "M4 20c0-4 3.5-6 8-6s8 2 8 6"]],
    ["Segments", "segments", ["M3 6h18M6 12h12M10 18h4"]],
    ["Forms", "forms", ["M4 5h16v14H4z", "M4 10h16M8 15h4"]],
  ] },
  { group: "Grow", items: [
    ["Automations", "automations", ["M13 3L5 14h6l-1 7 8-11h-6z"]],
    ["Referrals", "referrals", ["M12 3v12", "M7 8l5-5 5 5", "M5 21h14"]],
    ["Polls & surveys", "engage", ["M5 20V10M12 20V4M19 20v-7"]],
    ["Analytics", "analytics", ["M4 19l5-6 4 3 7-9", "M4 4v16h16"]],
  ] },
  { group: "Email API", items: [
    ["Emails", "emails", ["M3 6h18v12H3z", "M3 7l9 6 9-6"]],
    ["Send", "send", ["M21 3L10 14", "M21 3l-7 18-4-7-7-4z"]],
    ["Domains", "domains", ["M12 3a9 9 0 100 18 9 9 0 000-18z", "M3 12h18"]],
    ["API keys", "keys", ["M15 7a4 4 0 11-3.9 5L4 19v-3h3v-3h3l1.1-1.1A4 4 0 0115 7z"]],
    ["Webhooks", "webhooks", ["M9 17a5 5 0 110-10M15 7a5 5 0 110 10", "M8 12h8"]],
    ["Suppressions", "suppressions", ["M12 3a9 9 0 100 18 9 9 0 000-18z", "M5.6 5.6l12.8 12.8"]],
  ] },
  { group: null, items: [["Settings", "settings", ["M12 15a3 3 0 100-6 3 3 0 000 6z", "M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 00-2-1.2L14.3 3h-4l-.3 2.7a7 7 0 00-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1c.6.5 1.3.9 2 1.2l.3 2.7h4l.3-2.7c.7-.3 1.4-.7 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"]]] },
];

/** Pages that only show data. These refresh by themselves; pages with forms, editors or one-time secrets never do. */
export function isLiveView(parts: string[]): boolean {
  const [section = "", a, b] = parts;
  switch (section) {
    case "": case "emails": case "analytics": case "referrals": case "engage": case "suppressions": case "subscribers": return true;
    case "posts": return !a || b === "stats";
    case "automations": return !a;
    default: return false;
  }
}

/** The current hash, split into path segments and query string: #/posts/abc?x=1 */
export function parseHash(hash: string): { parts: string[]; query: URLSearchParams } {
  const [path, qs = ""] = hash.replace(/^#\/?/, "").split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs) };
}

export async function route(): Promise<HTMLElement> {
  const { parts, query } = parseHash(location.hash);
  const [section = "", a, b] = parts;
  switch (section) {
    case "": return overview();
    case "posts": return a === "new" ? newPost() : a ? (b === "stats" ? postStatsPage(a) : postEditor(a)) : postsList(query);
    case "website": return a === "pages" && b ? pageEditor(b) : websitePage();
    case "subscribers": return a ? subscriberDetail(a) : subscribersList(query);
    case "segments": return a ? segmentEditor(a) : segmentsList();
    case "forms": return formsPage();
    case "automations": return a ? automationEditor(a) : automationsList();
    case "referrals": return referralsPage();
    case "engage": return engagePage();
    case "analytics": return analyticsPage(query);
    case "emails": return a ? emailDetail(a) : emailList(query);
    case "send": return sendPage();
    case "domains": return domainsPage();
    case "keys": return keysPage();
    case "webhooks": return webhooksPage();
    case "suppressions": return suppressionsPage();
    case "settings": return settingsPage();
    default: return h("div", { class: "view" }, h("p", {}, "Page not found."));
  }
}

async function shell(): Promise<void> {
  const main = h("main", { class: "main", id: "main" });
  const links: HTMLAnchorElement[] = [];
  const sections: { el: HTMLElement; head: HTMLElement; items: HTMLAnchorElement[] }[] = [];
  const navEls = NAV.map(({ group, items }) => {
    const anchors = items.map(([label, path, svg]) => { const a = h("a", { class: "nav-item", href: `#/${path}`, "data-path": path }, icon(...svg), label); links.push(a); return a; });
    if (!group) return anchors;
    const head = h("button", { class: "nav-group", type: "button", "aria-expanded": String(group !== "Email API") }, group);
    const el = h("div", { class: `nav-sec${group === "Email API" ? " collapsed" : ""}` }, head, anchors);
    head.addEventListener("click", () => head.setAttribute("aria-expanded", String(!el.classList.toggle("collapsed"))));
    sections.push({ el, head, items: anchors });
    return el;
  });
  const settings = await api("GET", "/settings");

  const theme = h("button", { class: "nav-item", type: "button", onclick: () => toggleTheme() }, icon("M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"), "Toggle theme");
  const out = h("button", { class: "nav-item", type: "button", onclick: () => void signOut() }, icon("M9 4H5v16h4", "M16 8l4 4-4 4", "M20 12H9"), "Sign out");

  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const searchBtn = h("button", { class: "search-btn", type: "button", onclick: () => openPalette(commands) }, icon("M11 4a7 7 0 100 14 7 7 0 000-14z", "M20 20l-4-4"), h("span", {}, "Jump to…"), h("kbd", {}, mac ? "⌘K" : "Ctrl K"));
  const menuBtn = h("button", { class: "menu-btn", type: "button", "aria-label": "Menu", "aria-expanded": "false", onclick: () => {
    const open = document.getElementById("side")!.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", String(open));
  } }, icon("M4 7h16M4 12h16M4 17h16"));
  const toggleTheme = (): void => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch { /* storage blocked */ }
  };
  const signOut = async (): Promise<void> => { await api("POST", "/auth/logout", {}); location.hash = ""; void boot(); };
  const commands: Command[] = [
    ...NAV.flatMap(({ items }) => items.map(([label, path]): Command => ({ label, hint: "Page", run: () => { location.hash = `#/${path}`; } }))),
    { label: "New post", hint: "Action", run: () => { location.hash = "#/posts/new"; } },
    { label: "New segment", hint: "Action", run: () => { location.hash = "#/segments/new"; } },
    { label: "Toggle dark mode", hint: "Action", run: toggleTheme },
    { label: "Sign out", hint: "Action", run: () => void signOut() },
  ];
  addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(commands); } });

  replace(root, h("div", { class: "app" },
    h("aside", { class: "side", id: "side" }, logo(), menuBtn, searchBtn, ...navEls, h("div", { class: "side-foot" }, h("div", { class: "mode-pill" }, "mode ", h("b", {}, settings.mode)), theme, out)),
    main));

  const progress = h("div", { class: "progress" });
  document.body.append(progress);
  let token = 0;
  let stale = false;
  let renderedAt = Date.now();
  const render = async (live = false): Promise<void> => {
    const mine = ++token;
    const section = parseHash(location.hash).parts[0] ?? "";
    const label = links.find((a) => a.dataset.path === section)?.textContent;
    document.title = label && section ? `${label} · Freepost` : "Freepost";
    if (!live) { document.getElementById("side")?.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); }
    const slow = live ? 0 : window.setTimeout(() => progress.classList.add("on"), 180); // only show the bar if the page is slow
    links.forEach((a) => { if (a.dataset.path === section) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    for (const sec of sections) if (sec.items.some((a) => a.dataset.path === section)) { sec.el.classList.remove("collapsed"); sec.head.setAttribute("aria-expanded", "true"); } // never hide the current page
    try {
      const view = await route();
      if (mine !== token) return; // a newer navigation won
      renderedAt = Date.now();
      if (live) {
        if (main.firstElementChild?.outerHTML === view.outerHTML) return; // nothing changed, leave the page alone
        const y = scrollY;
        view.classList.add("still"); // no entrance animation when the page just updates
        replace(main, view);
        scrollTo(0, y);
        return;
      }
      replace(main, view);
      scrollTo(0, 0);
    } catch (e) {
      if (mine !== token) return;
      if (live) return; // a failed background refresh keeps what is on screen
      replace(main, h("div", { class: "view" }, h("div", { class: "notice bad" }, (e as Error).message)));
    } finally {
      clearTimeout(slow);
      if (mine === token) progress.classList.remove("on");
    }
  };
  addEventListener("hashchange", () => void render());

  // ---- live updates ----
  const pill = h("div", { class: "live-pill", "data-state": "off" }, h("i"), h("span", {}, "Connecting…"));
  document.querySelector(".side-foot")?.prepend(pill);
  const userIsBusy = (): boolean => {
    const a = document.activeElement;
    return !!document.querySelector(".modal-back, .float") || (!!a && main.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  };
  const refresh = (): void => {
    if (!isLiveView(parseHash(location.hash).parts)) { stale = false; return; }
    if (document.hidden || userIsBusy()) { stale = true; return; } // try again when they're done
    stale = false;
    void render(true);
  };
  let pending: number | undefined;
  const soon = (): void => { clearTimeout(pending); pending = window.setTimeout(refresh, 400); };
  startLive({
    onChange: soon,
    onNotice: (text) => toast(text),
    onState: (up) => { pill.dataset.state = up ? "on" : "off"; pill.lastElementChild!.textContent = up ? "Live" : "Reconnecting…"; },
  });
  // Also catches "2m ago" going stale and anything that changed while they were typing.
  setInterval(() => { if (stale || Date.now() - renderedAt > 30_000) refresh(); }, 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && stale) soon(); });
  main.addEventListener("focusout", () => { if (stale) setTimeout(soon, 300); });

  await render();
}

async function boot(): Promise<void> {
  try {
    const status = await api("GET", "/auth/status");
    if (status.authenticated) return await shell();
    replace(root, authScreen(status.setup_required, () => void boot()));
  } catch (e) {
    replace(root, h("main", { class: "auth" }, h("div", { class: "notice bad" }, (e as Error).message)));
  }
}

addEventListener("fp:unauthorized", () => { stopLive(); toast("Your session ended. Sign in again.", "bad"); void boot(); });
if (root) { installControls(); void boot(); }
