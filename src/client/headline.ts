/** Splits the h1 into per-word masks so each word can rise into place. */
export function initHeadline(): void {
  const h1 = document.getElementById("headline");
  if (!h1) return;

  const words = (h1.textContent ?? "").trim().split(/\s+/);
  h1.setAttribute("aria-label", words.join(" "));
  h1.replaceChildren(
    ...words.flatMap((word, i) => {
      const mask = document.createElement("span");
      mask.className = "w";
      mask.setAttribute("aria-hidden", "true");
      mask.style.setProperty("--i", String(i));
      const inner = document.createElement("span");
      inner.textContent = word;
      mask.append(inner);
      return i < words.length - 1 ? [mask, document.createTextNode(" ")] : [mask];
    }),
  );
  requestAnimationFrame(() => requestAnimationFrame(() => h1.classList.add("in")));
}
