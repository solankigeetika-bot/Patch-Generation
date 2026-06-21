"use strict";

// ─── config ──────────────────────────────────────────────────────────────────
const SETTINGS_KEY = "ls_verifier_settings";

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); }
  catch { return {}; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

let settings = loadSettings();

function backendUrl() {
  return (settings.backendUrl || "").replace(/\/$/, "") || "";
}

function apiUrl(path) {
  const base = backendUrl();
  return base ? base + path : path;
}

// ─── init ─────────────────────────────────────────────────────────────────────
let currentFile = null;
let currentJobId = null;
let currentResults = [];
// decisions[row] = { value }  (row = Mention Mappings row index, 1-based)
const decisions = {};

document.addEventListener("DOMContentLoaded", () => {
  // populate settings fields from storage
  const s = settings;
  if (s.backendUrl)  document.getElementById("backendUrl").value  = s.backendUrl;
  if (s.userEmail)   document.getElementById("userEmail").value   = s.userEmail;
  if (s.showSlug)    document.getElementById("showSlug").value    = s.showSlug;
  if (s.proxySecret) document.getElementById("proxySecret").value = s.proxySecret;

  document.getElementById("settingsToggle").addEventListener("click", () => {
    document.getElementById("settingsPanel").classList.toggle("hidden");
  });

  document.getElementById("settingsSave").addEventListener("click", () => {
    settings.backendUrl = document.getElementById("backendUrl").value.trim();
    settings.userEmail  = document.getElementById("userEmail").value.trim();
    settings.showSlug   = document.getElementById("showSlug").value.trim();
    settings.proxySecret = document.getElementById("proxySecret").value.trim();
    saveSettings(settings);
    renderCanonBookmarklet();
    document.getElementById("settingsPanel").classList.add("hidden");
  });

  ["backendUrl", "proxySecret"].forEach(id => {
    document.getElementById(id).addEventListener("input", () => {
      settings.backendUrl = document.getElementById("backendUrl").value.trim();
      settings.proxySecret = document.getElementById("proxySecret").value.trim();
      saveSettings(settings);
      renderCanonBookmarklet();
    });
  });

  // sync slug field → settings on change
  document.getElementById("showSlug").addEventListener("change", (e) => {
    settings.showSlug = e.target.value.trim();
    saveSettings(settings);
  });

  setupDropzone();
  setupVerify();
  setupSummaryActions();
  setupQA();
  setupCanonPush();
  setupCanonBookmarklet();
  renderCanonBookmarklet();
});

// ─── dropzone ────────────────────────────────────────────────────────────────
function setupDropzone() {
  const zone  = document.getElementById("dropzone");
  const input = document.getElementById("fileInput");
  const label = document.getElementById("fileName");

  document.getElementById("browseBtn").addEventListener("click", () => input.click());
  input.addEventListener("change", () => setFile(input.files[0]));

  zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("over");
    setFile(e.dataTransfer.files[0]);
  });

  function setFile(f) {
    if (!f) return;
    currentFile = f;
    label.textContent = f.name;
    label.classList.remove("hidden");
  }
}

// ─── verify ──────────────────────────────────────────────────────────────────
function setupVerify() {
  document.getElementById("verifyBtn").addEventListener("click", runVerify);
}

async function runVerify() {
  if (!currentFile) { alert("Please select an .xlsx file first."); return; }

  const btn      = document.getElementById("verifyBtn");
  const progress = document.getElementById("progressBar");
  const fill     = document.getElementById("progressFill");
  const plabel   = document.getElementById("progressLabel");

  btn.disabled = true;
  progress.classList.remove("hidden");
  fill.style.width = "5%";
  plabel.textContent = "Uploading…";

  const fd = new FormData();
  fd.append("file",       currentFile);
  fd.append("use_llm",    document.getElementById("useLlm").checked ? "true" : "false");
  fd.append("show_slug",  document.getElementById("showSlug").value.trim());
  fd.append("user_email", settings.userEmail || "");
  fd.append("src",        document.getElementById("srcLang").value.trim() || "de/en");
  fd.append("tgt",        document.getElementById("tgtLang").value.trim() || "fr");

  try {
    fill.style.width = "30%";
    plabel.textContent = "Verifying…";

    const resp = await fetch(apiUrl("/verify"), { method: "POST", body: fd });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || resp.statusText);
    }

    fill.style.width = "90%";
    const data = await resp.json();

    fill.style.width = "100%";
    plabel.textContent = "Done.";

    currentJobId    = data.job_id;
    currentResults  = data.results;
    Object.keys(decisions).forEach(k => delete decisions[k]);

    renderSummary(data.summary, data.canon_loaded);
    renderResults(data.results);

    document.getElementById("qaSection").classList.remove("hidden");
    document.getElementById("qaMessages").innerHTML = "";

    // update canon dot
    updateCanonDot(data.canon_loaded);

  } catch (e) {
    plabel.textContent = "Error: " + e.message;
    fill.style.width = "0%";
    alert("Verify failed: " + e.message);
  } finally {
    btn.disabled = false;
    setTimeout(() => progress.classList.add("hidden"), 3000);
  }
}

function updateCanonDot(loaded) {
  const el  = document.getElementById("canonStatus");
  const dot = el.querySelector(".dot");
  if (loaded) {
    dot.className = "dot green";
    el.childNodes[1].textContent = " Canon connected";
  } else {
    dot.className = "dot grey";
    el.childNodes[1].textContent = " Canon not connected";
  }
}

// ─── summary ─────────────────────────────────────────────────────────────────
function renderSummary(summary, canonLoaded) {
  const strip = document.getElementById("summary");
  strip.classList.remove("hidden");

  document.getElementById("statTotal").textContent =
    `Total: ${summary.total}`;
  document.getElementById("statAuto").textContent =
    `Auto-verified: ${summary.auto_verified}`;
  document.getElementById("statReview").textContent =
    `Needs review: ${summary.needs_review}`;

  const badge = document.getElementById("canonBadge");
  badge.textContent = canonLoaded ? "Canon loaded ✓" : "";
}

function setupSummaryActions() {
  document.getElementById("applyAllBtn").addEventListener("click", applyAllHighConf);
  document.getElementById("downloadAnnotated").addEventListener("click", downloadAnnotated);
  document.getElementById("finalizeBtn").addEventListener("click", finalize);
}

function applyAllHighConf() {
  currentResults.forEach(r => {
    if (r.confidence >= 85 && r.suggestion && !isConflict(r.status)) {
      decisions[r.row] = { value: r.suggestion };
      const card = document.querySelector(`[data-row="${r.row}"]`);
      if (card) markAccepted(card, r.suggestion);
    }
  });
}

function isConflict(status) {
  return status === "CANON_CONFLICT";
}

async function downloadAnnotated() {
  if (!currentJobId) return;
  window.location.href = apiUrl(`/download/${currentJobId}`);
}

async function finalize() {
  if (!currentJobId) { alert("Run Verify first."); return; }
  const decs = Object.entries(decisions).map(([row, d]) => ({
    row: parseInt(row), value: d.value
  }));

  const btn = document.getElementById("finalizeBtn");
  btn.disabled = true;
  btn.textContent = "Finalizing…";

  try {
    const resp = await fetch(apiUrl(`/finalize/${currentJobId}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: decs }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || resp.statusText);
    }
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "verified_final.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("Finalize failed: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Finalize & download corrected";
  }
}

// ─── results render ──────────────────────────────────────────────────────────
const STATUS_GROUPS = {
  CANON_CONFLICT: "CanonConflict",
  NAME_CHANGED:   "NameChanged",
  MISMATCH:       "HighConf",    // handled below by confidence
  LLM_FIX:        "HighConf",
  MISSING:        "Review",
  SOURCE_LEAK:    "Review",
  NEEDS_REVIEW:   "Review",
  ALIAS_LEARNED:  "Alias",
  INCONSISTENT:   "Alias",
};

function getGroup(r) {
  if (r.status === "CANON_CONFLICT")                       return "CanonConflict";
  if (r.status === "NAME_CHANGED")                         return "NameChanged";
  if (["VERIFIED","LEARNED","LLM_OK"].includes(r.status)) return "HighConf";
  if (r.confidence >= 85)                                  return "HighConf";
  if (r.status === "ALIAS_LEARNED" || r.status === "INCONSISTENT") return "Alias";
  return "Review";
}

function statusBadgeClass(status) {
  const map = {
    VERIFIED: "badge-green", LEARNED: "badge-green", LLM_OK: "badge-green",
    ALIAS_LEARNED: "badge-yellow", INCONSISTENT: "badge-yellow",
    MISMATCH: "badge-orange", LLM_FIX: "badge-orange", CANON_CONFLICT: "badge-orange",
    MISSING: "badge-red", SOURCE_LEAK: "badge-red",
    NAME_CHANGED: "badge-purple",
    NEEDS_REVIEW: "badge-grey",
  };
  return map[status] || "badge-grey";
}

function confClass(c) {
  if (c >= 85) return "high";
  if (c >= 60) return "mid";
  return "low";
}

function renderResults(results) {
  // clear
  ["CanonConflict","NameChanged","HighConf","Review","Alias"].forEach(g => {
    document.getElementById(`cards${g}`).innerHTML = "";
    document.getElementById(`group${g}`).classList.add("hidden");
  });

  const section = document.getElementById("results");
  section.classList.remove("hidden");

  results.forEach(r => {
    const group = getGroup(r);
    const container = document.getElementById(`cards${group}`);
    const card = buildCard(r);
    container.appendChild(card);
    document.getElementById(`group${group}`).classList.remove("hidden");
  });
}

function buildCard(r) {
  const card = document.createElement("div");
  card.className = `result-card status-${r.status}`;
  card.dataset.row = r.row;

  const autoOk = ["VERIFIED","LEARNED","LLM_OK"].includes(r.status);
  const showActions = !autoOk;

  const confPill = r.confidence != null
    ? `<span class="conf-pill ${confClass(r.confidence)}">${r.confidence}%</span>`
    : "";

  const suggestionRow = r.suggestion && r.suggestion !== r.current
    ? `<div class="row">
         <span class="lbl">Suggestion</span>
         <span class="val suggestion">${esc(r.suggestion)}</span>
         ${confPill}
       </div>`
    : "";

  const reasonRow = r.reason
    ? `<div class="reason">${esc(r.reason)}</div>`
    : "";

  card.innerHTML = `
    <div class="card-row-num">R${r.row}</div>
    <div class="card-body">
      <div class="row">
        <span class="lbl">Original</span>
        <span class="val">${esc(r.original || "")}</span>
      </div>
      <div class="row">
        <span class="lbl">Current</span>
        <span class="val ${r.current !== r.suggestion ? "mismatch" : ""}">${esc(r.current || "—")}</span>
      </div>
      ${suggestionRow}
      ${reasonRow}
    </div>
    <div class="card-actions">
      <span class="status-badge ${statusBadgeClass(r.status)}">${r.status}</span>
      ${showActions ? actionButtons(r) : ""}
    </div>
  `;

  if (showActions) wireActions(card, r);
  return card;
}

function actionButtons(r) {
  const hasSugg = r.suggestion && r.suggestion !== r.current;
  return `
    ${hasSugg ? `<button class="btn-sm btn-accept" data-action="accept">✓ Accept</button>` : ""}
    <button class="btn-sm" data-action="edit">✎ Edit</button>
    <button class="btn-sm btn-skip" data-action="skip">✗ Skip</button>
    <div class="edit-row hidden" data-editrow>
      <input type="text" placeholder="Enter correction…" data-editinput>
      <button class="btn-sm btn-accept" data-action="save-edit">Save</button>
    </div>
  `;
}

function wireActions(card, r) {
  card.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (!action) return;

    if (action === "accept") {
      decisions[r.row] = { value: r.suggestion };
      markAccepted(card, r.suggestion);
      await saveCorrection(r, r.suggestion);
    } else if (action === "edit") {
      card.querySelector("[data-editrow]").classList.toggle("hidden");
      const inp = card.querySelector("[data-editinput]");
      if (inp) { inp.value = r.suggestion || r.current || ""; inp.focus(); }
    } else if (action === "save-edit") {
      const val = card.querySelector("[data-editinput]").value.trim();
      if (!val) return;
      decisions[r.row] = { value: val };
      markAccepted(card, val);
      await saveCorrection(r, val);
    } else if (action === "skip") {
      card.classList.add("status-accepted");
      card.querySelector(".card-actions").innerHTML =
        `<span class="status-badge badge-grey">SKIPPED</span>`;
    }
  });
}

function markAccepted(card, val) {
  card.classList.add("status-accepted");
  const actions = card.querySelector(".card-actions");
  if (actions) {
    actions.innerHTML =
      `<span class="status-badge badge-green">ACCEPTED</span>
       <span style="font-size:12px;color:#276221">${esc(val)}</span>`;
  }
}

async function saveCorrection(r, value) {
  if (!currentJobId || !r.cid) return;
  try {
    await fetch(apiUrl("/correction"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id:           currentJobId,
        cid:              String(r.cid),
        original_mention: r.original || "",
        value:            value,
        user_email:       settings.userEmail || "",
      }),
    });
  } catch {
    // non-critical; correction learning failure doesn't break workflow
  }
}

// ─── Q&A ─────────────────────────────────────────────────────────────────────
function setupQA() {
  document.getElementById("qaBtn").addEventListener("click", askQuestion);
  document.getElementById("qaInput").addEventListener("keydown", e => {
    if (e.key === "Enter") askQuestion();
  });
}

async function askQuestion() {
  const input = document.getElementById("qaInput");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";

  const msgs = document.getElementById("qaMessages");

  const userBubble = document.createElement("div");
  userBubble.className = "qa-bubble user";
  userBubble.textContent = q;
  msgs.appendChild(userBubble);

  const loadBubble = document.createElement("div");
  loadBubble.className = "qa-bubble system loading";
  loadBubble.textContent = "Thinking…";
  msgs.appendChild(loadBubble);
  msgs.scrollTop = msgs.scrollHeight;

  const sheetCtx = currentResults.slice(0, 80).map(r =>
    `Row ${r.row}: ${r.original} → ${r.current} (${r.status})`
  ).join("\n");

  try {
    const resp = await fetch(apiUrl("/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question:     q,
        sheet_context: sheetCtx,
        source_lang:  document.getElementById("srcLang").value.trim() || "de/en",
        target_lang:  document.getElementById("tgtLang").value.trim() || "fr",
        show_slug:    document.getElementById("showSlug").value.trim(),
        user_email:   settings.userEmail || "",
      }),
    });
    const data = await resp.json();
    loadBubble.className = "qa-bubble system";
    loadBubble.textContent = data.answer || data.detail || "No response.";
  } catch (e) {
    loadBubble.className = "qa-bubble system";
    loadBubble.textContent = "Error: " + e.message;
  }
  msgs.scrollTop = msgs.scrollHeight;
}

// ─── canon manual push ────────────────────────────────────────────────────────
function setupCanonPush() {
  document.getElementById("pushCanonBtn").addEventListener("click", async () => {
    const val    = document.getElementById("manualCanon").value.trim();
    const secret = (settings.proxySecret || document.getElementById("proxySecret").value || "").trim();
    if (!val || !secret) return;

    const status = document.getElementById("canonPushStatus");
    status.textContent = "Pushing…";
    try {
      const resp = await fetch(apiUrl("/update-canon-session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, canon: val }),
      });
      const data = await resp.json();
      if (resp.ok) {
        status.textContent = "✓ " + (data.message || "Connected");
        updateCanonDot(true);
      } else {
        status.textContent = "✗ " + (data.detail || "Failed");
      }
    } catch (e) {
      status.textContent = "✗ " + e.message;
    }
  });
}

function setupCanonBookmarklet() {
  document.getElementById("copyBookmarkletBtn").addEventListener("click", async () => {
    const code = document.getElementById("bookmarkletCode").value;
    const status = document.getElementById("bookmarkletStatus");
    if (!code || code.indexOf("PASTE_") !== -1) {
      status.textContent = "Enter backend URL and proxy secret first.";
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      status.textContent = "Copied. Create a bookmark and paste this as the URL.";
    } catch (e) {
      document.getElementById("bookmarkletCode").select();
      status.textContent = "Select/copy the code from the box.";
    }
  });
}

function renderCanonBookmarklet() {
  const codeEl = document.getElementById("bookmarkletCode");
  const linkEl = document.getElementById("canonBookmarkletLink");
  const status = document.getElementById("bookmarkletStatus");
  if (!codeEl || !linkEl) return;

  const base = (backendUrl() || window.location.origin).replace(/\/$/, "");
  const secret = (settings.proxySecret || "").trim();
  if (!base || !secret) {
    const placeholder = "Enter Backend URL and Proxy secret, then Save.";
    codeEl.value = placeholder;
    linkEl.href = "#";
    linkEl.classList.add("disabled");
    status.textContent = "";
    return;
  }

  const bookmarklet = buildCanonBookmarklet(base, secret);
  codeEl.value = bookmarklet;
  linkEl.href = bookmarklet;
  linkEl.classList.remove("disabled");
  status.textContent = "Ready. Drag the blue link to your bookmarks bar.";
}

function buildCanonBookmarklet(base, secret) {
  const endpoint = base.replace(/\/$/, "") + "/update-canon-session";
  return "javascript:(function(){"
    + "var W=" + JSON.stringify(endpoint) + ",S=" + JSON.stringify(secret) + ";"
    + "if(location.hostname.indexOf('canon')<0){alert('Open canon.pocketfm.ai first, then click this bookmark.');return;}"
    + "function ext(name){var scripts=[].slice.call(document.scripts).map(function(s){return s.textContent||'';}).sort(function(a,b){return b.length-a.length;});"
    + "for(var si=0;si<scripts.length;si++){var txt=scripts[si],idx=txt.indexOf(name);if(idx<0)continue;var st=txt.indexOf('{',idx);if(st<0)continue;var d=0,end=-1,str=false,esc=false;"
    + "for(var i=st;i<txt.length;i++){var c=txt[i];if(esc){esc=false;continue;}if(c==='\\\\'){esc=true;continue;}if(c==='\\\"')str=!str;if(str)continue;if(c==='{')d++;else if(c==='}'){d--;if(d===0){end=i+1;break;}}}"
    + "if(end>0){try{return JSON.parse(txt.slice(st,end));}catch(e){}}}return null;}"
    + "var wiki=(window.WIKI_DATA&&typeof window.WIKI_DATA==='object')?window.WIKI_DATA:ext('WIKI_DATA');"
    + "var show=(window.SHOW_DATA&&typeof window.SHOW_DATA==='object')?window.SHOW_DATA:ext('SHOW_DATA');"
    + "if(!wiki){alert('Story Canon data not found on this page. Open the show canon page, wait for it to load, then click again.');return;}"
    + "var slug=(location.pathname.split('/').filter(Boolean)[0]||'');"
    + "fetch(W,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:S,slug:slug,url:location.href,wiki:wiki,show:show})})"
    + ".then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.detail||d.error||r.status);return d;});})"
    + ".then(function(d){alert(d.message||'Story Canon connected ✓');})"
    + ".catch(function(e){alert('Failed to connect Story Canon: '+e.message);});"
    + "})();";
}

// ─── utils ────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
