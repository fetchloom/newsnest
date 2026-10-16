import { onceVisible, reducedMotion } from "./motion.js";

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 4);

const fmt = (el: HTMLElement, n: number): string => (el.hasAttribute("data-group") ? n.toLocaleString("en") : String(n));

function run(el: HTMLElement): void {
  const from = Number(el.dataset.from ?? 0);
  const to = Number(el.dataset.to ?? 0);
  if (reducedMotion) { el.textContent = fmt(el, to); return; }

  const duration = 1400;
  const start = performance.now();
  const tick = (now: number) => {
    const t = Math.min((now - start) / duration, 1);
    el.textContent = fmt(el, Math.round(from + (to - from) * easeOut(t)));
    if (t < 1) requestAnimationFrame(tick);
  };
  el.textContent = fmt(el, from);
  requestAnimationFrame(tick);
}

export function initCounters(): void {
  document.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => onceVisible(el, () => run(el), 0.6));
}
