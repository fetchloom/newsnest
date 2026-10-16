export function initReveal(): void {
  const items = document.querySelectorAll<HTMLElement>("[data-reveal]");
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      io.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  items.forEach((el) => io.observe(el));
}
