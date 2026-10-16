export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Calls `fn` once when `el` first enters the viewport. */
export function onceVisible(el: Element, fn: () => void, threshold = 0.15): void {
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    fn();
  }, { threshold });
  io.observe(el);
}
