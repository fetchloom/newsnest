import { api } from "./api.js";
import { h } from "./dom.js";
import { busy, logo } from "./ui.js";

/** Create-password or sign-in screen. Calls `done` once there's a session. */
export function authScreen(setup: boolean, done: () => void): HTMLElement {
  const password = h("input", { class: "input", type: "password", autocomplete: setup ? "off" : "current-password", autofocus: true });
  const confirm = h("input", { class: "input", type: "password", autocomplete: "off" });
  const error = h("div", { class: "error", role: "alert" });
  const submit = h("button", { class: "btn btn-solid", type: "submit" }, setup ? "Create password" : "Sign in");

  const form = h("form", { class: "form", onsubmit: (e: Event) => {
    e.preventDefault();
    error.textContent = "";
    if (!password.value) { error.textContent = "Enter your password."; return; }
    if (setup && password.value.length < 10) { error.textContent = "Use at least 10 characters."; return; }
    if (setup && password.value !== confirm.value) { error.textContent = "The two passwords don't match."; return; }
    void busy(submit, async () => {
      try {
        await api("POST", setup ? "/auth/setup" : "/auth/login", { password: password.value });
        done();
      } catch (err) {
        error.textContent = (err as Error).message;
      }
    });
  } },
    h("div", { class: "field" }, h("label", {}, "Password"), password, setup && h("span", { class: "hint" }, "At least 10 characters. Stored hashed on this machine.")),
    setup && h("div", { class: "field" }, h("label", {}, "Repeat password"), confirm),
    error,
    submit,
  );

  return h("main", { class: "auth" }, h("div", { class: "auth-card" },
    logo(),
    h("div", {}, h("h1", {}, setup ? "Welcome." : "Sign in"), h("p", {}, setup ? "Choose a password for this dashboard. You'll only do this once." : "Enter your dashboard password.")),
    form,
  ));
}
