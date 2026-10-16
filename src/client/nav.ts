export function initNav(): void {
  const nav = document.getElementById("nav");
  if (!nav) return;
  const update = () => nav.classList.toggle("scrolled", scrollY > 8);
  update();
  addEventListener("scroll", update, { passive: true });
}
