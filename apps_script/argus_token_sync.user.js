// ==UserScript==
// @name         Argus + Canon → Sheets token sync
// @namespace    pocketfm.localization
// @version      1.1
// @description  Auto-push the fresh Argus (Open WebUI) session token and the
//               canon.pocketfm.ai __session cookie into the Localization
//               Verifier Apps Script, so the chatbot and canon-aware answers
//               never need a manual paste. Runs whenever you open either site.
// @match        https://argus.pocketfm.org/*
// @match        https://canon.pocketfm.ai/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ─── CONFIG — fill these two in once ─────────────────────────────────────────
  // 1. WEBAPP_URL  = the Apps Script Web App URL
  //    (Apps Script → Deploy → New deployment → Web app → copy the /exec URL)
  // 2. SECRET      = the same random string you set as REFRESH_SECRET in
  //    Apps Script → Project Settings → Script Properties
  var WEBAPP_URL = "PASTE_APPS_SCRIPT_WEBAPP_URL_HERE";
  var SECRET     = "PASTE_SAME_SECRET_AS_REFRESH_SECRET_HERE";
  // ─────────────────────────────────────────────────────────────────────────────

  function cookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  var host = location.hostname;
  var field, value, label;

  if (host.indexOf("argus.pocketfm.org") !== -1) {
    // Open WebUI keeps the session JWT in localStorage (preferred) or a cookie.
    try { value = localStorage.getItem("token") || ""; } catch (e) { value = ""; }
    if (!value) value = cookie("token");
    field = "token"; label = "argus";
  } else if (host.indexOf("canon.pocketfm.ai") !== -1) {
    // NOTE: if __session is an httpOnly cookie, the page cannot read it and this
    // will be empty — in that case set CANON_SESSION manually from DevTools.
    value = cookie("__session");
    field = "canon"; label = "canon";
  } else {
    return;
  }

  if (!value) {
    console.warn("[" + label + " sync] no credential readable on this page");
    return;
  }

  // Only push when the value changed, or once an hour, to avoid spamming.
  var memKey = "__sync_" + field;
  var lastVal  = localStorage.getItem(memKey + "_val");
  var lastTime = parseInt(localStorage.getItem(memKey + "_at") || "0", 10);
  if (value === lastVal && (Date.now() - lastTime) < 3600000) return;

  var body = { secret: SECRET };
  body[field] = value;

  fetch(WEBAPP_URL, {
    method: "POST",
    mode: "no-cors",                                  // fire-and-forget; no CORS needed
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body)
  }).then(function () {
    localStorage.setItem(memKey + "_val", value);
    localStorage.setItem(memKey + "_at", String(Date.now()));
    console.log("[" + label + " sync] " + field + " pushed to Sheets");
  }).catch(function (err) {
    console.warn("[" + label + " sync] push failed:", err);
  });
})();
