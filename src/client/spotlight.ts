/** Tracks the pointer over each product card so the CSS glow can follow it. */
export function initSpotlight(): void {
  document.querySelectorAll<HTMLElement>(".tool").forEach((cell) => {
    cell.addEventListener("pointermove", (e) => {
      const r = cell.getBoundingClientRect();
      cell.style.setProperty("--mx", `${e.clientX - r.left}px`);
      cell.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  });
}
