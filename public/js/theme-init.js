// Runs before first paint: apply the saved or system theme and flag JS,
// so scroll-reveal styles only apply when the script can undo them.
(function () {
  var root = document.documentElement;
  // A page can set data-default="dark" on <html> to start dark unless the visitor has chosen a theme.
  var fallback = root.getAttribute("data-default") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  var theme = fallback;
  try { theme = localStorage.getItem("theme") || fallback; } catch (e) { /* storage blocked */ }
  root.setAttribute("data-theme", theme);
  root.classList.add("js");
})();
