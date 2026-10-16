/*
 * Newsnest subscribe form embed.
 *
 *   <div data-newsnest-form></div>
 *   <script async src="https://news.example.com/embed.js"></script>            inline form
 *   <script async src="https://news.example.com/embed.js" data-mode="popup" data-delay="8"></script>
 *   <script async src="https://news.example.com/embed.js" data-mode="popup" data-trigger="exit"></script>
 *   <script async src="https://news.example.com/embed.js" data-mode="slide-in" data-delay="12"></script>
 *
 * The form itself is an iframe served by Newsnest, so this page never touches subscriber input.
 * A visitor who closes a popup or slide-in isn't asked again for 7 days.
 */
(function () {
  "use strict";
  var script = document.currentScript || document.querySelector("script[src$='/embed.js']");
  if (!script) return;
  var origin = new URL(script.src).origin;
  var mode = script.getAttribute("data-mode") || "inline";
  var KEY = "newsnest-dismissed";

  function frame(height) {
    var f = document.createElement("iframe");
    f.src = origin + "/subscribe?embed=1" + (location.search.indexOf("ref=") > -1 ? "&" + location.search.slice(1) : "");
    f.title = "Subscribe";
    f.loading = "lazy";
    f.style.cssText = "border:0;width:100%;height:" + height + "px;display:block;background:transparent";
    return f;
  }

  function dismissed() {
    try { return Date.now() - Number(localStorage.getItem(KEY) || 0) < 7 * 864e5; } catch (e) { return false; }
  }
  function remember() {
    try { localStorage.setItem(KEY, String(Date.now())); } catch (e) { /* storage blocked */ }
  }

  function close(node) {
    remember();
    node.remove();
    document.removeEventListener("keydown", onKey);
  }
  var onKey = function (e) {
    if (e.key === "Escape") { var el = document.querySelector("[data-newsnest-overlay]"); if (el) close(el); }
  };

  function overlay(kind) {
    if (dismissed() || document.querySelector("[data-newsnest-overlay]")) return;
    var wrap = document.createElement("div");
    wrap.setAttribute("data-newsnest-overlay", kind);
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-label", "Subscribe");
    var card = document.createElement("div");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Close");
    btn.textContent = "×";
    btn.style.cssText = "position:absolute;top:6px;right:8px;border:0;background:none;font:24px/1 system-ui;cursor:pointer;color:#666";
    btn.onclick = function () { close(wrap); };
    card.style.cssText = "position:relative;background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);padding:18px 18px 8px;box-sizing:border-box;";
    if (kind === "popup") {
      wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:2147483000;padding:16px;animation:nn-in .25s ease";
      card.style.width = "min(480px,100%)";
      wrap.addEventListener("click", function (e) { if (e.target === wrap) close(wrap); });
    } else {
      wrap.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;width:min(380px,calc(100vw - 32px));animation:nn-in .3s ease";
      card.style.width = "100%";
    }
    card.appendChild(btn);
    card.appendChild(frame(kind === "popup" ? 250 : 230));
    wrap.appendChild(card);
    var style = document.createElement("style");
    style.textContent = "@keyframes nn-in{from{opacity:0;transform:translateY(12px)}}@media (prefers-reduced-motion:reduce){[data-newsnest-overlay]{animation:none!important}}";
    document.head.appendChild(style);
    document.body.appendChild(wrap);
    document.addEventListener("keydown", onKey);
    btn.focus();
  }

  function start() {
    if (mode === "inline") {
      var hosts = document.querySelectorAll("[data-newsnest-form]");
      for (var i = 0; i < hosts.length; i++) hosts[i].appendChild(frame(230));
      return;
    }
    var trigger = script.getAttribute("data-trigger") || "delay";
    if (trigger === "exit") {
      var fired = false;
      document.addEventListener("mouseout", function (e) {
        if (!fired && e.clientY <= 0 && !e.relatedTarget) { fired = true; overlay(mode === "slide-in" ? "slide-in" : "popup"); }
      });
    } else {
      setTimeout(function () { overlay(mode === "slide-in" ? "slide-in" : "popup"); }, Math.max(0, Number(script.getAttribute("data-delay") || 8)) * 1000);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
