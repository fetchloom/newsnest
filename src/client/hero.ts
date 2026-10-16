import { reducedMotion, sleep } from "./motion.js";

type Token = readonly [cls: "k" | "s" | "f" | "v" | "p", text: string];

const SNIPPET: readonly (readonly Token[])[] = [
  [["k", "import"], ["p", " { "], ["v", "Freepost"], ["p", " } "], ["k", "from"], ["s", ' "freepost"'], ["p", ";"]],
  [],
  [["k", "const"], ["v", " fp"], ["p", " = "], ["k", "new"], ["v", " Freepost"], ["p", "("], ["s", '"fp_live_••••"'], ["p", ");"]],
  [],
  [["k", "await"], ["v", " fp"], ["p", ".emails."], ["f", "send"], ["p", "({"]],
  [["p", "  from: "], ["s", '"Ada <ada@yourdomain.com>"'], ["p", ","]],
  [["p", "  to: "], ["s", '"hello@example.com"'], ["p", ","]],
  [["p", "  subject: "], ["s", '"It\'s free. Really."'], ["p", ","]],
  [["p", "  markdown: "], ["s", '"No tiers. No meters."'], ["p", ","]],
  [["p", "});"]],
];

const EVENT_DELAYS = [250, 650, 1250, 2300];

export function initHero(): void {
  const stage = document.getElementById("stage");
  const code = document.getElementById("code");
  const status = document.getElementById("status");
  const mail = document.getElementById("mail");
  const events = Array.from(document.querySelectorAll<HTMLElement>("#events li"));
  if (!stage || !code || !status || !mail) return;

  const showResult = () => {
    status.classList.add("on");
    mail.classList.add("on");
    events.forEach((li) => li.classList.add("on"));
  };
  const clearResult = () => {
    status.classList.remove("on");
    mail.classList.remove("on");
    events.forEach((li) => li.classList.remove("on"));
  };

  const renderStatic = () => {
    code.replaceChildren(...SNIPPET.map((line) => {
      const row = document.createElement("div");
      line.forEach(([cls, text]) => row.append(span(cls, text)));
      if (!line.length) row.append("​");
      return row;
    }));
    showResult();
  };
  if (reducedMotion) return renderStatic();

  // Only animate while the stage is on screen.
  let visible = false;
  let wake: (() => void) | null = null;
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    stage.classList.toggle("live", visible);
    if (visible && wake) { wake(); wake = null; }
  }, { threshold: 0.25 }).observe(stage);
  const untilVisible = () => (visible ? Promise.resolve() : new Promise<void>((r) => { wake = r; }));

  async function typeSnippet(): Promise<void> {
    code!.replaceChildren();
    const caret = document.createElement("span");
    caret.className = "caret";
    for (const line of SNIPPET) {
      const row = document.createElement("div");
      row.append("​", caret);
      code!.append(row);
      for (const [cls, text] of line) {
        const tok = span(cls, "");
        row.insertBefore(tok, caret);
        for (const ch of text) {
          await untilVisible();
          tok.textContent += ch;
          await sleep(ch === " " ? 8 : 16 + Math.random() * 22);
        }
      }
      await sleep(line.length ? 140 : 60);
    }
    caret.remove();
  }

  async function cycle(): Promise<void> {
    for (;;) {
      stage!.classList.remove("reset");
      clearResult();
      await sleep(500);
      await typeSnippet();
      await sleep(350);
      status!.classList.add("on");
      mail!.classList.add("on");
      let last = 0;
      for (let i = 0; i < events.length; i++) {
        await sleep(EVENT_DELAYS[i] - last);
        last = EVENT_DELAYS[i];
        await untilVisible();
        events[i].classList.add("on");
      }
      await sleep(5200);
      stage!.classList.add("reset");
      clearResult();
      await sleep(600);
    }
  }
  void cycle();
}

function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}
