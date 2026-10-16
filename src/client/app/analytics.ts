import { api } from "./api.js";
import { append, h } from "./dom.js";
import { bar, copyButton, downloadFile, empty, num, pageHead, selectEl, statusBadge } from "./ui.js";

const stat = (value: string, label: string): HTMLElement => h("div", { class: "stat-card" }, h("div", { class: "n" }, value), h("div", { class: "l" }, label));

function tableCard(title: string, rows: HTMLElement[], emptyTitle: string, emptyHint: string, head?: HTMLElement): HTMLElement {
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, title)),
    rows.length ? h("div", { class: "table-scroll" }, h("table", { class: "t" }, head ?? null, h("tbody", {}, ...rows))) : empty(emptyTitle, emptyHint));
}

export async function analyticsPage(query: URLSearchParams): Promise<HTMLElement> {
  const days = Number(query.get("days") ?? 30) || 30;
  const a = await api("GET", `/analytics/audience?days=${days}`);
  const t = a.totals;
  const maxUp = Math.max(1, ...a.growth.map((g: any) => Math.max(g.subscribed, g.unsubscribed)));
  const engagementTotal = a.engagement.reduce((s: number, e: any) => s + e.n, 0) || 1;
  const labels: Record<string, string> = { new: "New (joined this week)", active: "Active (opened or clicked in 30 days)", at_risk: "At risk (30–90 days)", inactive: "Inactive (90+ days)" };
  const net = a.growth.reduce((s: number, g: any) => s + g.net, 0);

  const growth = h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Growth"), h("span", { class: "muted small" }, `${net >= 0 ? "+" : ""}${net} net in this period`)),
    h("div", { class: "spark", role: "img", "aria-label": "New and lost subscribers per day" }, ...a.growth.map((g: any) =>
      h("div", { class: "col", title: `${g.date}: +${g.subscribed} −${g.unsubscribed}` },
        h("i", { class: "up", style: `height:${(g.subscribed / maxUp) * 48}%;min-height:${g.subscribed ? 2 : 0}px` }),
        h("i", { class: "down", style: `height:${(g.unsubscribed / maxUp) * 48}%;min-height:${g.unsubscribed ? 2 : 0}px;border-radius:0 0 3px 3px` })))),
    h("div", { class: "legend" }, h("span", {}, h("b", {}), "New"), h("span", {}, h("b", { class: "d" }), "Unsubscribed")));

  const engagement = h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Engagement")),
    t.active
      ? h("div", { class: "card-pad stack" }, ...["new", "active", "at_risk", "inactive"].map((k) => {
        const n = a.engagement.find((e: any) => e.level === k)?.n ?? 0;
        return h("div", {}, h("div", { class: "row small" }, h("span", { class: "grow" }, labels[k]), h("span", { class: "muted" }, num(n))), bar((n / engagementTotal) * 100));
      }))
      : empty("No active subscribers yet", "Engagement appears once people have received a few emails."));

  const sources = tableCard("Where subscribers come from",
    a.sources.map((s: any) => h("tr", {}, h("td", {}, s.source, s.utm_source ? h("span", { class: "muted" }, ` · ${s.utm_source}`) : null), h("td", { class: "num" }, num(s.n)))),
    "No data yet", "Sources fill in as people subscribe.");
  const referringSites = tableCard("Referring sites",
    a.referrers.map((r: any) => h("tr", {}, h("td", {}, r.referrer), h("td", { class: "num" }, num(r.n)))),
    "None recorded", "Captured from the page people were on when they signed up.");
  const topReferrers = tableCard("Top referrers",
    a.top_referrers.map((r: any) => h("tr", {}, h("td", {}, r.email), h("td", { class: "num" }, `${r.referrals}`))),
    "No referrals yet", "Turn on the referral program to grow by word of mouth.");
  const recent = tableCard("Recent posts",
    a.recent_posts.map((p: any) => h("tr", { class: "link", onclick: () => { location.hash = `#/posts/${p.id}/stats`; } },
      h("td", { class: "clip" }, p.title), h("td", { class: "num" }, num(p.sent)), h("td", { class: "num" }, `${p.open_rate}%`), h("td", { class: "num" }, `${p.click_rate}%`), h("td", { class: "num" }, num(p.unsubscribes)))),
    "No posts sent yet", "Send a post and its results show up here.",
    h("thead", {}, h("tr", {}, h("th", {}, "Post"), h("th", { class: "num" }, "Sent"), h("th", { class: "num" }, "Opens"), h("th", { class: "num" }, "Clicks"), h("th", { class: "num" }, "Unsubscribes"))));

  const period = selectEl([["14", "Last 14 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]], String(days), { "aria-label": "Period", style: "width:auto", onchange: (e: Event) => { location.hash = `#/analytics?days=${(e.target as HTMLSelectElement).value}`; } });
  return h("div", { class: "view stack" },
    pageHead("Analytics", "How your audience is growing and how they respond.", period, h("button", { class: "btn btn-ghost", type: "button", onclick: () => void downloadFile("/analytics/posts.csv", "posts.csv") }, "Export posts CSV")),
    h("div", { class: "stats-grid" }, stat(num(t.active), "Active subscribers"), stat(num(t.pending), "Waiting to confirm"), stat(num(t.unsubscribed), "Unsubscribed"), stat(num(t.bounced), "Bounced")),
    growth,
    h("div", { class: "split" }, engagement, sources),
    h("div", { class: "split" }, referringSites, topReferrers),
    recent);
}

export async function postStatsPage(id: string): Promise<HTMLElement> {
  const s = await api("GET", `/posts/${encodeURIComponent(id)}/stats`);
  const root = h("div", { class: "view stack" });
  const maxHour = Math.max(1, ...s.hourly.map((x: any) => x.n));
  const hours = Array.from({ length: 72 }, (_, i) => ({ opens: s.hourly.find((x: any) => x.h === i && x.type === "email.opened")?.n ?? 0, clicks: s.hourly.find((x: any) => x.h === i && x.type === "email.clicked")?.n ?? 0 }));
  const progress = s.recipients ? Math.round(((s.sent + s.bounced) / s.recipients) * 100) : 0;

  append(root, [
    h("a", { class: "crumb", href: `#/posts/${s.post_id}` }, "← Back to post"),
    pageHead(s.title, undefined, statusBadge(s.status)),
    s.status === "sending" ? h("div", { class: "card card-pad stack" }, h("div", { class: "row small" }, h("span", { class: "grow" }, `Sending… ${num(s.sent)} of ${num(s.recipients)} delivered to the mail server`), h("span", { class: "muted" }, `${progress}%`)), bar(progress)) : null,
    s.ab_state?.phase === "testing" ? h("div", { class: "notice" }, "A/B test running. The winning subject goes to everyone else after the wait you set.") : null,
    h("div", { class: "stats-grid", style: "grid-template-columns:repeat(3,1fr)" },
      stat(num(s.sent), "Sent"), stat(`${s.opens.rate}%`, `Open rate · ${num(s.opens.unique)} opened`), stat(`${s.clicks.rate}%`, `Click rate · ${num(s.clicks.verified_unique)} verified`),
      stat(`${s.clicks.click_to_open}%`, "Click-to-open"), stat(num(s.unsubscribes.total), `Unsubscribes · ${s.unsubscribes.rate}%`), stat(num(s.bounced), "Bounced")),
    h("p", { class: "hint" }, s.note),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "First 72 hours")),
      h("div", { class: "spark", role: "img", "aria-label": "Opens and clicks by hour after sending" }, hours.map((x, i) => h("div", { class: "col", title: `Hour ${i}: ${x.opens} opens, ${x.clicks} clicks` }, h("i", { class: "up", style: `height:${(x.opens / maxHour) * 100}%;min-height:${x.opens ? 2 : 0}px` })))),
      h("div", { class: "legend" }, h("span", {}, h("b", {}), "People who opened, per hour"))),
    s.variants.length ? h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "A/B test"), s.ab_state?.winner ? h("span", { class: "muted small" }, `Winner: variant ${s.ab_state.winner}`) : null),
      h("div", { class: "table-scroll" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, h("th", {}, "Variant"), h("th", { class: "num" }, "Sent"), h("th", { class: "num" }, "Open rate"), h("th", { class: "num" }, "Click rate"))),
        h("tbody", {}, s.variants.map((v: any) => h("tr", {}, h("td", {}, `${v.variant}${s.ab_state?.winner === v.variant ? " ★" : ""}`), h("td", { class: "num" }, num(v.sent)), h("td", { class: "num" }, `${v.open_rate}%`), h("td", { class: "num" }, `${v.click_rate}%`))))))) : null,
    h("div", { class: "split" },
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Top links")), s.top_links.length
        ? h("div", { class: "table-scroll" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, h("th", {}, "Link"), h("th", { class: "num" }, "People"), h("th", { class: "num" }, "Verified"), h("th", {}))),
            h("tbody", {}, s.top_links.map((l: any) => h("tr", {}, h("td", { class: "clip" }, l.url), h("td", { class: "num" }, num(l.uniq)), h("td", { class: "num" }, num(l.verified)), h("td", {}, copyButton(l.url)))))))
        : empty("No clicks yet", "Clicks on links in this email show up here.")),
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Devices (opens)")), s.devices.length
        ? h("div", { class: "card-pad stack" }, ...s.devices.map((d: any) => h("div", {}, h("div", { class: "row small" }, h("span", { class: "grow" }, d.device ?? "unknown"), h("span", { class: "muted" }, num(d.n))), bar(s.opens.unique ? (d.n / s.opens.unique) * 100 : 0))))
        : empty("No opens yet", "Opens are measured with a tiny image in the email.")))]);

  // Keep numbers fresh while a send is in progress; stop when the page is left.
  if (s.status === "sending") {
    const timer = window.setInterval(() => {
      if (!root.isConnected) { clearInterval(timer); return; }
      void api("GET", `/posts/${encodeURIComponent(id)}/stats`).then((n) => { if (n.status !== "sending") { clearInterval(timer); location.reload(); } });
    }, 5000);
  }
  return root;
}
