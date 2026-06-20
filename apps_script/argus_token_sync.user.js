// ==UserScript==
// @name         Argus → Sheets token sync
// @namespace    pocketfm.localization
// @version      1.0
// @description  Auto-push the fresh Argus (Open WebUI) session token into the
//               Localization Verifier Apps Script so the chatbot never needs a
//               manual token paste. Runs every time you open/refresh Argus.
// @match        https://argus.pocketfm.org/*
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

  function getToken() {
    try {
      var t = localStorage.getItem("token");
      if (t) return t;
    } catch (e) { /* ignore */ }
    var m = document.cookie.match(/(?:^|;\s*)token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  var token = getToken();
  if (!token) { return; }  // not logged in yet

  // Only push when the token actually changed, or once an hour, to avoid spamming.
  var lastTok  = localStorage.getItem("__argus_sync_tok");
  var lastTime = parseInt(localStorage.getItem("__argus_sync_at") || "0", 10);
  var fresh    = token !== lastTok || (Date.now() - lastTime) > 3600000;
  if (!fresh) { return; }

  fetch(WEBAPP_URL, {
    method: "POST",
    mode: "no-cors",                                  // fire-and-forget; no CORS needed
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret: SECRET, token: token })
  }).then(function () {
    localStorage.setItem("__argus_sync_tok", token);
    localStorage.setItem("__argus_sync_at", String(Date.now()));
    console.log("[Argus sync] token pushed to Sheets");
  }).catch(function (err) {
    console.warn("[Argus sync] push failed:", err);
  });
})();
