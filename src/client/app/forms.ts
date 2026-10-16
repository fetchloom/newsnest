import { api } from "./api.js";
import { h } from "./dom.js";
import { busy, copyButton, field, input, pageHead, toast } from "./ui.js";

export async function formsPage(): Promise<HTMLElement> {
  const [forms, pub] = await Promise.all([api("GET", "/forms"), api("GET", "/publication")]);
  const snippet = (title: string, desc: string, code: string): HTMLElement =>
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("div", {}, h("h2", {}, title), h("div", { class: "muted small", style: "margin-top:4px" }, desc)), copyButton(code)), h("pre", { class: "pre", tabindex: "0" }, code));

  const doubleOptIn = h("input", { type: "checkbox", checked: pub.double_opt_in });
  const welcomeOn = h("input", { type: "checkbox", checked: pub.welcome_enabled });
  const wSubject = input({ value: pub.welcome_subject });
  const wBody = h("textarea", { class: "textarea", style: "min-height:140px;font-family:var(--sans);font-size:14.5px" }, pub.welcome_body);
  const save = h("button", { class: "btn btn-solid", type: "button" }, "Save");
  save.addEventListener("click", () => void busy(save, async () => {
    await api("PATCH", "/publication", { double_opt_in: doubleOptIn.checked, welcome_enabled: welcomeOn.checked, welcome_subject: wSubject.value, welcome_body: wBody.value });
    toast("Saved");
  }));

  return h("div", { class: "view stack" },
    pageHead("Forms", "Ways for people to subscribe: a hosted page, embeds for your own site, pop-ups and slide-ins."),
    forms.base_url_is_local ? h("div", { class: "notice warn" }, "Your public URL is ", h("code", {}, forms.base_url), ", which only works on this computer. ", h("a", { href: "#/settings" }, "Set your real address in Settings"), " before putting these on a live site.") : null,
    h("div", { class: "split" },
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Hosted sign-up page"), copyButton(forms.hosted_page)), h("div", { class: "card-pad" }, h("a", { href: forms.hosted_page, target: "_blank", rel: "noopener" }, forms.hosted_page), h("p", { class: "hint", style: "margin-top:6px" }, "Add ?name=1 to also ask for a first name. UTM parameters and ?ref= links are recorded automatically."))),
        snippet("Inline embed", "Drops the form wherever you place the div.", forms.inline),
        snippet("Pop-up", "Appears after 8 seconds. Visitors who close it aren't asked again for a week.", forms.popup),
        snippet("Exit-intent pop-up", "Appears when the pointer leaves the page.", forms.exit_intent),
        snippet("Slide-in", "A small card in the corner.", forms.slide_in),
        snippet("Plain iframe", "Works anywhere that allows iframes.", forms.iframe)),
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Preview")), h("iframe", { src: "/subscribe?embed=1", title: "Form preview", style: "width:100%;height:260px;border:0;background:var(--bg)" })),
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "After someone signs up")), h("div", { class: "card-pad stack" },
          h("label", { class: "check" }, doubleOptIn, "Ask new subscribers to confirm by email (recommended)"),
          h("label", { class: "check" }, welcomeOn, "Send a welcome email once they're confirmed"),
          field("Welcome subject", wSubject), field("Welcome message", wBody, "Markdown. Merge tags: {{first_name | friend}}, {{publication_name}}"), h("div", { class: "row" }, save))))));
}
