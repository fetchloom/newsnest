// Runs before first paint: apply the saved or system theme and flag JS,
// so scroll-reveal styles only apply when the script can undo them.
(function () {
  var root = document.documentElement;
  var theme = "light";
  try {
    theme = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch (e) {
    theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  root.setAttribute("data-theme", theme);
  root.classList.add("js");
})();
