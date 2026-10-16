import { reducedMotion, sleep } from "./motion.js";

const IDEAS = [
  "A welcome email for new readers…",
  "This week's digest, with three links and a note…",
  "Announce our launch to the whole list…",
  "A short survey about what to cover next…",
];

/** The hero's input: example ideas type themselves into the placeholder, and the pills below fill it in. */
export function initComposer(): void {
  const box = document.getElementById("idea") as HTMLTextAreaElement | null;
  if (!box) return;
  const base = box.placeholder;

  document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((pill) =>
    pill.addEventListener("click", () => { box.value = pill.dataset.prompt ?? ""; box.focus(); }));
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); location.hash = "#start"; }
  });
  if (reducedMotion) return;

  // Only animate while nobody is typing and the tab is visible.
  const idle = (): boolean => box.value === "" && document.activeElement !== box && !document.hidden;
  const waitIdle = async (): Promise<void> => { while (!idle()) { box.placeholder = base; await sleep(document.hidden ? 1500 : 400); } };

  void (async () => {
    for (let i = 0; ; i = (i + 1) % IDEAS.length) {
      const text = IDEAS[i];
      for (let n = 0; n <= text.length; n++) { await waitIdle(); box.placeholder = text.slice(0, n); await sleep(42); }
      await sleep(1800);
      for (let n = text.length; n >= 0; n--) { await waitIdle(); box.placeholder = text.slice(0, n); await sleep(16); }
      await sleep(350);
    }
  })();
}
