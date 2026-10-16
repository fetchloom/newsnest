import { reducedMotion } from "./motion.js";

type Theme = "light" | "dark";

function apply(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("theme", theme); } catch { /* storage blocked: theme just won't persist */ }
}

export function initTheme(): void {
  const button = document.getElementById("theme");
  if (!button) return;

  button.addEventListener("click", () => {
    const next: Theme = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    if (reducedMotion || !document.startViewTransition) return apply(next);

    // Circular reveal that grows from the toggle button.
    const { left, top, width, height } = button.getBoundingClientRect();
    const x = left + width / 2;
    const y = top + height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

    document.startViewTransition(() => apply(next)).ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 650, easing: "cubic-bezier(.22, 1, .36, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    });
  });
}
