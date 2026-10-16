import { onceVisible, reducedMotion, sleep } from "./motion.js";

const EVENTS = [
  "New subscriber: ada@example.com",
  "Opened: “Issue #42” by lin@example.org",
  "Clicked: freepost.dev/guide",
  "New subscriber: sam@example.net",
  "Poll vote: Deliverability",
  "Referral reward earned: Sticker pack",
];

/** The dashboard mock-up cycles through the kinds of toast the real dashboard raises. */
export function initShowcase(): void {
  const box = document.getElementById("toasts");
  if (!box || reducedMotion) return;
  onceVisible(box, async () => {
    for (let i = 1; ; i = (i + 1) % EVENTS.length) {
      await sleep(3200);
      const toast = document.createElement("span");
      toast.textContent = EVENTS[i];
      box.replaceChildren(toast);
    }
  }, 0.5);
}
