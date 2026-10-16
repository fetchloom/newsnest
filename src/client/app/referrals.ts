import { api } from "./api.js";
import { h } from "./dom.js";
import { confirmDialog } from "./controls.js";
import { ago, busy, copyButton, empty, field, input, modal, num, pageHead, selectEl, statusBadge, toast } from "./ui.js";

export async function referralsPage(): Promise<HTMLElement> {
  const [ov, rewards, claims, pub] = await Promise.all([api("GET", "/referrals"), api("GET", "/rewards"), api("GET", "/rewards/claims"), api("GET", "/publication")]);
  const reload = (): void => location.reload();

  const toggle = h("input", { type: "checkbox", checked: ov.enabled, onchange: (e: Event) => void api("PATCH", "/publication", { referral_enabled: (e.target as HTMLInputElement).checked }).then(() => toast("Saved"), (err) => toast((err as Error).message, "bad")) });

  function rewardDialog(r?: any): void {
    const name = input({ value: r?.name ?? "", placeholder: "Free ebook" });
    const threshold = input({ type: "number", min: 1, value: r?.threshold ?? 3 });
    const kind = selectEl([["digital", "Digital (we email a link)"], ["physical", "Physical (you send it)"]], r?.kind ?? "digital");
    const url = input({ value: r?.url ?? "", placeholder: "https://… link to the download or coupon" });
    const desc = input({ value: r?.description ?? "", placeholder: "Shown in the email (optional)" });
    const error = h("div", { class: "error", role: "alert" });
    const go = h("button", { class: "btn btn-solid", type: "button" }, r ? "Save" : "Add reward");
    const m = modal(r ? "Edit reward" : "New reward", h("div", { class: "stack" }, field("Name", name), field("Referrals needed", threshold), field("Type", kind), field("Link", url, "Required for digital rewards."), field("Description", desc), error), [go]);
    go.addEventListener("click", () => void busy(go, async () => {
      try { const body = { name: name.value, threshold: Number(threshold.value), kind: kind.value, url: url.value, description: desc.value }; await (r ? api("PATCH", `/rewards/${r.id}`, body) : api("POST", "/rewards", body)); m.close(); reload(); }
      catch (e) { error.textContent = (e as Error).message; }
    }));
  }

  return h("div", { class: "view stack" },
    pageHead("Referrals", "Give every subscriber a personal link. Reward them when friends join.", h("button", { class: "btn btn-solid", type: "button", onclick: () => rewardDialog() }, "Add reward")),
    h("div", { class: "card card-pad stack" }, h("label", { class: "check" }, toggle, h("b", {}, "Referral program is on")),
      h("p", { class: "small muted" }, "Each subscriber gets a link like ", h("code", {}, `${pub.base_url}/subscribe?ref=…`), ". It's available in emails with {{referral_link}} and in the Referral block. A referral counts once the friend confirms their subscription.")),
    h("div", { class: "stats-grid", style: "grid-template-columns:repeat(2,1fr)" },
      h("div", { class: "stat-card" }, h("div", { class: "n" }, num(ov.referred_subscribers)), h("div", { class: "l" }, "Subscribers who came from a referral")),
      h("div", { class: "stat-card" }, h("div", { class: "n" }, num(ov.referrers)), h("div", { class: "l" }, "People who referred someone"))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Rewards")), rewards.data.length
      ? h("div", { class: "table-scroll" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, h("th", {}, "Reward"), h("th", {}, "Referrals"), h("th", {}, "Type"), h("th", { class: "num" }, "Earned"), h("th", {}))),
          h("tbody", {}, rewards.data.map((r: any) => h("tr", {}, h("td", {}, r.name), h("td", {}, String(r.threshold)), h("td", { class: "muted" }, r.kind), h("td", { class: "num" }, `${r.earned} (${r.fulfilled} sent)`),
            h("td", { class: "row", style: "justify-content:flex-end" }, h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => rewardDialog(r) }, "Edit"),
              h("button", { class: "btn btn-danger btn-sm", type: "button", onclick: () => void confirmDialog("Delete this reward?", { title: "Delete reward" }).then((ok) => ok && api("DELETE", `/rewards/${r.id}`).then(reload)) }, "Delete")))))))
      : empty("No rewards yet", "Add milestones such as “3 referrals: free ebook”.")),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Earned rewards")), claims.data.length
      ? h("div", { class: "table-scroll" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, h("th", {}, "Subscriber"), h("th", {}, "Reward"), h("th", {}, "Status"), h("th", {}, "Earned"), h("th", {}))),
          h("tbody", {}, claims.data.map((c: any) => h("tr", {}, h("td", {}, c.email), h("td", {}, c.reward), h("td", {}, statusBadge(c.status)), h("td", { class: "muted small" }, ago(c.earned_at)),
            h("td", {}, c.status === "earned" ? h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => void api("POST", `/rewards/claims/${c.id}/fulfill`).then(reload) }, "Mark as sent") : null))))))
      : empty("Nobody has earned a reward yet", "They'll appear here, and digital rewards are emailed automatically.")),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Top referrers")), ov.leaderboard.length
      ? h("div", { class: "table-scroll" }, h("table", { class: "t" }, h("tbody", {}, ov.leaderboard.map((r: any, i: number) => h("tr", {}, h("td", { class: "muted" }, String(i + 1)), h("td", {}, r.email), h("td", { class: "num" }, `${r.referrals} referrals`), h("td", {}, copyButton(`${pub.base_url}/subscribe?ref=${r.code}`, "Copy link")))))))
      : empty("No referrals yet", "Once people share their links, the leaderboard fills in.")));
}
