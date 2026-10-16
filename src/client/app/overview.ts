import { api } from "./api.js";
import { h } from "./dom.js";
import { ago, badge, empty, pageHead } from "./ui.js";

export async function overview(): Promise<HTMLElement> {
  const [s, settings, recent, audience, pub, sentPosts] = await Promise.all([api("GET", "/stats"), api("GET", "/settings"), api("GET", "/emails?limit=6"), api("GET", "/analytics/audience?days=14"), api("GET", "/publication"), api("GET", "/posts?status=sent")]);

  const d = s.deliveries as Record<string, number>;
  const n = (...keys: string[]): number => keys.reduce((sum, k) => sum + (d[k] ?? 0), 0);
  const max = Math.max(1, ...s.series.map((x: { count: number }) => x.count));

  const steps: [string, string, boolean][] = [
    ["Add your sending domain", "#/domains", s.domains.total > 0],
    ["Publish its DNS records and verify them", "#/domains", s.domains.verified > 0],
    ["Set your sender address and postal address", "#/settings", !!pub.from_email && !!pub.address],
    ["Get your first subscribers", "#/subscribers", audience.totals.active > 0],
    ["Write and send your first post", "#/posts", sentPosts.data.length > 0],
    ["Create an API key for the email API", "#/keys", s.api_keys > 0],
  ];
  const finished = steps.every(([, , done]) => done);

  const modeNote = { outbox: `Outbox mode: emails are saved as files in ${settings.data_dir}/outbox and not sent anywhere. Switch to relay or direct mode to reach real inboxes.` };

  return h("div", { class: "view stack" },
    pageHead("Overview", "What your instance has been doing.", h("a", { class: "btn btn-solid", href: "#/send" }, "Send an email")),
    settings.mode === "outbox" && h("div", { class: "notice warn" }, modeNote.outbox),

    !finished && h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Get set up")),
      h("ul", { class: "checklist" }, steps.map(([label, href, done]) =>
        h("li", { class: done ? "done" : "" }, h("span", { class: "tick" }), h("a", { href }, label)))),
    ),

    h("div", { class: "stats-grid" },
      stat(audience.totals.active, "Active subscribers"),
      stat(audience.growth.reduce((sum: number, g: { net: number }) => sum + g.net, 0), "Net new in 14 days"),
      stat(n("sent", "delivered"), "Emails accepted"),
      stat(n("bounced", "failed"), "Bounced or failed"),
    ),

    h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Last 14 days"), h("span", { class: "muted small" }, `${s.emails_today} today`)),
      h("div", { class: "chart", role: "img", "aria-label": "Emails per day for the last 14 days" },
        s.series.map((x: { date: string; count: number }, i: number) =>
          h("div", { class: "bar", title: `${x.date}: ${x.count}` }, h("i", { class: x.count ? "" : "zero", style: `height:${Math.max(2, (x.count / max) * 100)}%;--i:${i}` })))),
      h("div", { class: "chart-axis" }, h("span", {}, s.series[0].date.slice(5)), h("span", {}, s.series[s.series.length - 1].date.slice(5))),
    ),

    h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Recent emails"), h("a", { class: "muted small", href: "#/emails" }, "View all")),
      recent.data.length
        ? h("div", { class: "table-scroll" }, h("table", { class: "t" }, h("tbody", {}, recent.data.map((e: any) =>
            h("tr", { class: "link", onclick: () => { location.hash = `#/emails/${e.id}`; } },
              h("td", { class: "clip" }, e.to.join(", ")), h("td", { class: "clip muted" }, e.subject), h("td", {}, badge(e.last_event)), h("td", { class: "muted small" }, ago(e.created_at)))))))
        : empty("Nothing sent yet", "Your first email will show up here."),
    ),
  );
}

function stat(value: number, label: string): HTMLElement {
  return h("div", { class: "stat-card" }, h("div", { class: "n" }, String(value)), h("div", { class: "l" }, label));
}
