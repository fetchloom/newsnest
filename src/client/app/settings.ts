import { api } from "./api.js";
import { h } from "./dom.js";
import { designPicker } from "./designs.js";
import { busy, card, field, input, pageHead, toast } from "./ui.js";

export async function settingsPage(): Promise<HTMLElement> {
  const [pub, domains] = await Promise.all([api("GET", "/publication"), api("GET", "/domains")]);
  const P = { ...pub };
  const text = (key: string, props: Record<string, unknown> = {}): HTMLInputElement => input({ value: P[key] ?? "", oninput: (e: Event) => { P[key] = (e.target as HTMLInputElement).value; }, ...props });
  const check = (key: string, label: string): HTMLElement => h("label", { class: "check" }, h("input", { type: "checkbox", checked: P[key], onchange: (e: Event) => { P[key] = (e.target as HTMLInputElement).checked; } }), label);

  const fromDomain = String(P.from_email || "").split("@")[1];
  const dom = domains.data.find((d: any) => d.name === fromDomain);
  const checks: [string, boolean, string][] = [
    ["A From address is set", !!P.from_email, "Set it below."],
    ["The sending domain is verified", pub.mode === "outbox" || dom?.status === "verified", fromDomain ? `Add and verify ${fromDomain} under Domains.` : "Set the From address first."],
    ["A public URL is set", !pub.base_url_is_local, "Links in emails need an address people can reach."],
    ["A postal address is set", !!P.address, "Most countries require one in marketing email."],
  ];

  const save = h("button", { class: "btn btn-solid", type: "button" }, "Save settings");
  save.addEventListener("click", () => void busy(save, async () => {
    try {
      await api("PATCH", "/publication", { name: P.name, description: P.description, from_name: P.from_name, from_email: P.from_email, reply_to: P.reply_to, address: P.address, site_url: P.site_url, track_opens: P.track_opens, track_clicks: P.track_clicks, utm_links: P.utm_links });
      toast("Saved"); location.reload();
    } catch (e) { toast((e as Error).message, "bad"); }
  }));

  const current = input({ type: "password", autocomplete: "current-password", "aria-label": "Current password" });
  const next = input({ type: "password", autocomplete: "off", "aria-label": "New password" });
  const again = input({ type: "password", autocomplete: "off", "aria-label": "Repeat new password" });
  const passError = h("div", { class: "error", role: "alert" });
  const change = h("button", { class: "btn btn-ghost", type: "button" }, "Change password");
  change.addEventListener("click", () => void busy(change, async () => {
    passError.textContent = "";
    if (!current.value) { passError.textContent = "Enter your current password."; return; }
    if (next.value.length < 10) { passError.textContent = "Use at least 10 characters."; return; }
    if (next.value !== again.value) { passError.textContent = "The two new passwords don't match."; return; }
    try {
      await api("POST", "/auth/password", { password: current.value, new_password: next.value });
      current.value = next.value = again.value = "";
      toast("Password changed. Other devices were signed out.");
    } catch (e) { passError.textContent = (e as Error).message; }
  }));

  return h("div", { class: "view stack" },
    pageHead("Settings", "Your publication's name, sender and tracking.", save),
    card("Ready to send?", h("ul", { class: "checklist" }, checks.map(([label, ok, fix]) => h("li", { class: ok ? "done" : "" }, h("span", { class: "tick" }), h("span", {}, label, ok ? null : h("span", { class: "muted small" }, ` — ${fix}`)))))),
    card("Email design", h("div", { class: "card-pad stack" },
      await designPicker({ current: pub.design, wide: true, onPick: (id) => void api("PATCH", "/publication", { design: id }).then(() => toast("Design saved"), (e) => toast((e as Error).message, "bad")) }),
      h("p", { class: "hint" }, "The look of every email you send, in your brand colour. A single post can use a different design, or your own HTML."))),
    card("Publication", h("div", { class: "card-pad stack" }, field("Name", text("name")), field("Description", text("description", { placeholder: "One line about what you write" })))),
    card("Sender", h("div", { class: "card-pad stack" },
      h("div", { class: "split" }, field("From name", text("from_name", { placeholder: P.name })), field("From email", text("from_email", { type: "email", placeholder: "news@yourdomain.com" }))),
      field("Reply-to (optional)", text("reply_to", { type: "email" })),
      field("Postal address", text("address", { placeholder: "123 Main St, City, Country" }), "Shown in every email footer."))),
    card("Public URL", h("div", { class: "card-pad stack" }, field("Address", text("site_url", { placeholder: "https://news.yourdomain.com" }), `Used in confirm, unsubscribe and tracking links. Currently ${pub.base_url}.`))),
    card("Tracking", h("div", { class: "card-pad stack" }, check("track_opens", "Track opens (a tiny image in each email)"), check("track_clicks", "Track clicks (links go through your server first)"), check("utm_links", "Add UTM parameters to links so your analytics show where visits came from"),
      h("p", { class: "hint" }, "Opens are approximate: some mail apps load images automatically, which counts as an open. Clicks from security scanners are filtered out."))),
    card("Password", h("div", { class: "card-pad stack" },
      h("div", { class: "split" }, field("Current password", current), h("div")),
      h("div", { class: "split" }, field("New password", next, "At least 10 characters."), field("Repeat new password", again)),
      passError, h("div", {}, change),
      h("p", { class: "hint" }, "Changing it signs out every other browser. Locked out? Start the server once with NEWSNEST_ADMIN_PASSWORD set to a new password."))),
    h("span", { class: "hint" }, `Sending mode: ${pub.mode}. Change it with the NEWSNEST_MODE setting when you start the server.`));
}
