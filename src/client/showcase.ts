import { onceVisible, reducedMotion, sleep } from "./motion.js";

const EVENTS = [
  "New subscriber: ada@example.com",
  "Opened: “Issue #42” by lin@example.org",
  "Clicked: freepost.dev/guide",
  "New subscriber: sam@example.net",
  "Poll vote: Deliverability",
  "Referral reward earned: Sticker pack",
];

/** The dashboard mock-ups cycle through the kinds of toast the real dashboard raises. */
export function initShowcase(): void {
  if (reducedMotion) return;
  document.querySelectorAll<HTMLElement>("[data-toasts]").forEach((box, n) => onceVisible(box, async () => {
    for (let i = 1 + n * 3; ; i = (i + 1) % EVENTS.length) {
      await sleep(3200);
      const toast = document.createElement("span");
      toast.textContent = EVENTS[i];
      box.replaceChildren(toast);
    }
  }, 0.5));
}
