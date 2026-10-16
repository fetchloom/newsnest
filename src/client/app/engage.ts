import { api } from "./api.js";
import { h } from "./dom.js";
import { confirmDialog } from "./controls.js";
import { ago, bar, busy, copyButton, downloadFile, empty, field, input, modal, num, pageHead, selectEl } from "./ui.js";

export async function engagePage(): Promise<HTMLElement> {
  const [polls, surveys] = await Promise.all([api("GET", "/polls"), api("GET", "/surveys")]);
  const reload = (): void => location.reload();

  function pollDialog(): void {
    const q = input({ placeholder: "What should we cover next?" });
    const opts = h("textarea", { class: "textarea", style: "min-height:110px;font-family:var(--sans)", placeholder: "One option per line (2 to 8)" });
    const error = h("div", { class: "error", role: "alert" });
    const go = h("button", { class: "btn btn-solid", type: "button" }, "Create poll");
    const m = modal("New poll", h("div", { class: "stack" }, field("Question", q), field("Options", opts), error), [go]);
    go.addEventListener("click", () => void busy(go, async () => {
      try { await api("POST", "/polls", { question: q.value, options: opts.value.split("\n").map((s) => s.trim()).filter(Boolean) }); m.close(); reload(); } catch (e) { error.textContent = (e as Error).message; }
    }));
  }

  function surveyDialog(): void {
    const title = input({ placeholder: "Reader survey" });
    const desc = input({ placeholder: "Why you're asking (optional)" });
    const questions: any[] = [{ type: "choice", label: "", options: ["", ""], required: false }];
    const qHost = h("div", { class: "stack" });
    const error = h("div", { class: "error", role: "alert" });
    const draw = (): void => qHost.replaceChildren(...questions.map((q, i) => h("div", { class: "mini-editor stack" },
      h("div", { class: "row" }, selectEl([["choice", "Pick one"], ["multi", "Pick several"], ["text", "Free text"], ["rating", "Rating 1–5"]], q.type, { onchange: (e: Event) => { q.type = (e.target as HTMLSelectElement).value; draw(); }, style: "width:auto" }),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: q.required, onchange: (e: Event) => { q.required = (e.target as HTMLInputElement).checked; } }), "Required"),
        h("button", { class: "ico-btn danger right", type: "button", "aria-label": "Remove question", onclick: () => { questions.splice(i, 1); draw(); } }, "×")),
      input({ value: q.label, placeholder: `Question ${i + 1}`, oninput: (e: Event) => { q.label = (e.target as HTMLInputElement).value; } }),
      q.type === "choice" || q.type === "multi" ? h("textarea", { class: "textarea", style: "min-height:80px;font-family:var(--sans)", placeholder: "One option per line", oninput: (e: Event) => { q.options = (e.target as HTMLTextAreaElement).value.split("\n"); } }, q.options.join("\n")) : null)));
    draw();
    const go = h("button", { class: "btn btn-solid", type: "button" }, "Create survey");
    const m = modal("New survey", h("div", { class: "stack" }, field("Title", title), field("Description", desc), qHost,
      h("button", { class: "btn btn-ghost btn-sm", type: "button", style: "width:fit-content", onclick: () => { questions.push({ type: "text", label: "", options: [], required: false }); draw(); } }, "+ Question"), error), [go]);
    go.addEventListener("click", () => void busy(go, async () => {
      try {
        await api("POST", "/surveys", { title: title.value, description: desc.value, questions: questions.map((q) => ({ ...q, options: (q.options ?? []).map((o: string) => o.trim()).filter(Boolean) })) });
        m.close(); reload();
      } catch (e) { error.textContent = (e as Error).message; }
    }));
  }

  function summaryBlock(s: any): HTMLElement {
    let detail: HTMLElement;
    if (s.type === "text") {
      detail = h("div", { class: "stack" }, ...(s.samples.length ? s.samples.map((t: string) => h("div", { class: "notice" }, t)) : [h("span", { class: "muted small" }, "No answers yet.")]));
    } else if (s.type === "rating") {
      detail = h("div", {}, `Average ${s.average} from ${s.answered} answers`, h("div", { class: "muted small" }, s.counts.map((c: number, i: number) => `${i + 1}★ ${c}`).join("   ")));
    } else {
      detail = h("div", { class: "stack" }, ...Object.entries(s.counts).map(([label, n]) =>
        h("div", {}, h("div", { class: "row small" }, h("span", { class: "grow" }, label), h("span", { class: "muted" }, String(n))), bar(s.answered ? ((n as number) / s.answered) * 100 : 0))));
    }
    return h("div", { class: "stack" }, h("b", {}, s.label), detail);
  }

  async function resultsDialog(id: string): Promise<void> {
    const r = await api("GET", `/surveys/${id}`);
    modal(r.title, h("div", { class: "stack" }, h("div", { class: "muted small" }, `${r.responses.length} responses`), ...r.summary.map(summaryBlock)));
  }

  return h("div", { class: "view stack" },
    pageHead("Polls and surveys", "Ask your readers things. Polls are one click inside an email; surveys are a short form."),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Polls"), h("button", { class: "btn btn-solid btn-sm", type: "button", onclick: pollDialog }, "New poll")),
      polls.data.length ? h("div", { class: "card-pad stack" }, ...polls.data.map((p: any) => h("div", { class: "stack", style: "padding-bottom:14px;border-bottom:1px solid var(--line)" },
        h("div", { class: "row" }, h("b", { class: "grow" }, p.question), h("span", { class: "muted small" }, `${num(p.total_votes)} votes${p.closed ? " · closed" : ""}`),
          h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => void api("PATCH", `/polls/${p.id}`, { closed: !p.closed }).then(reload) }, p.closed ? "Reopen" : "Close"),
          h("button", { class: "btn btn-danger btn-sm", type: "button", onclick: () => void confirmDialog("Delete this poll and its votes?", { title: "Delete poll" }).then((ok) => ok && api("DELETE", `/polls/${p.id}`).then(reload)) }, "Delete")),
        ...p.options.map((o: any) => h("div", {}, h("div", { class: "row small" }, h("span", { class: "grow" }, o.label), h("span", { class: "muted" }, `${o.percent}% · ${o.votes}`)), bar(o.percent))),
        h("div", { class: "hint" }, "Add it to a post with the Poll block. Link: ", copyButton(`/poll/${p.id}`, "Copy results link")))))
        : empty("No polls yet", "A one-question poll is the easiest way to hear from readers.")),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Surveys"), h("button", { class: "btn btn-solid btn-sm", type: "button", onclick: surveyDialog }, "New survey")),
      surveys.data.length
        ? h("div", { class: "table-scroll" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, h("th", {}, "Survey"), h("th", { class: "num" }, "Questions"), h("th", { class: "num" }, "Responses"), h("th", {}, "Created"), h("th", {}))),
            h("tbody", {}, surveys.data.map((s: any) => h("tr", {}, h("td", {}, s.title, s.closed ? h("span", { class: "muted small" }, " · closed") : null), h("td", { class: "num" }, String(s.questions.length)), h("td", { class: "num" }, num(s.responses)), h("td", { class: "muted small" }, ago(s.created_at)),
              h("td", { class: "row", style: "justify-content:flex-end" }, h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => void resultsDialog(s.id) }, "Results"), h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => void downloadFile(`/surveys/${s.id}/export.csv`, "survey.csv") }, "CSV"),
                h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => void api("PATCH", `/surveys/${s.id}`, { closed: !s.closed }).then(reload) }, s.closed ? "Reopen" : "Close"),
                h("button", { class: "btn btn-danger btn-sm", type: "button", onclick: () => void confirmDialog("Delete this survey and its responses?", { title: "Delete survey" }).then((ok) => ok && api("DELETE", `/surveys/${s.id}`).then(reload)) }, "Delete")))))))
        : empty("No surveys yet", "Use the Survey block in a post to send readers to one.")));
}
