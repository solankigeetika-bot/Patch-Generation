"use strict";

const DEFAULTS = {
  backendUrl: "http://127.0.0.1:8000",
  proxySecret: "",
};
const DEAD_DEFAULT_BACKENDS = new Set([
  "https://confidentiality-latino-nelson-depend.trycloudflare.com",
]);

const state = {
  spreadsheetId: "",
  spreadsheetTitle: "",
  sheets: {},
  ld: [],
  mm: [],
  findings: [],
};

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await getSettings();
  const migratedBackend = DEAD_DEFAULT_BACKENDS.has(cleanBaseUrl(settings.backendUrl));
  const backendUrl = migratedBackend
    ? DEFAULTS.backendUrl
    : settings.backendUrl || DEFAULTS.backendUrl;
  if (migratedBackend) {
    await setSettings({ ...settings, backendUrl });
  }
  $("backendUrl").value = backendUrl;
  $("proxySecret").value = settings.proxySecret || "";

  $("saveSettings").addEventListener("click", saveSettingsFromUi);
  $("healthBtn").addEventListener("click", checkHealth);
  $("refreshBtn").addEventListener("click", loadActiveSheet);
  $("loadSheetBtn").addEventListener("click", loadActiveSheet);
  $("runAllBtn").addEventListener("click", () => runVerifier("all"));
  $("runCultureBtn").addEventListener("click", () => runVerifier("culture"));
  $("writeBtn").addEventListener("click", writeFindings);
  $("previewReplaceBtn").addEventListener("click", () => replaceAcrossSheet(true));
  $("applyReplaceBtn").addEventListener("click", () => replaceAcrossSheet(false));
  $("connectCanonBtn").addEventListener("click", connectStoryCanon);

  await loadActiveSheet();
});

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, resolve);
  });
}

async function setSettings(next) {
  return new Promise((resolve) => chrome.storage.local.set(next, resolve));
}

async function saveSettingsFromUi() {
  await setSettings({
    backendUrl: cleanBaseUrl($("backendUrl").value),
    proxySecret: $("proxySecret").value.trim(),
  });
  setStatus("connectionStatus", "Settings saved.", true);
}

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function getToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) reject(new Error(err ? err.message : "Google auth failed."));
      else resolve(token);
    });
  });
}

async function getProfileEmail() {
  return new Promise((resolve) => {
    chrome.identity.getProfileUserInfo((info) => resolve(info?.email || ""));
  });
}

async function googleFetch(url, options = {}, retryAuth = true) {
  const token = await getToken(true);
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const resp = await fetch(url, { ...options, headers });
  if ((resp.status === 401 || resp.status === 403) && retryAuth) {
    const text = await resp.clone().text().catch(() => "");
    const needsFreshToken = resp.status === 401 || /insufficient|scope|permission/i.test(text);
    if (needsFreshToken) {
      await removeCachedToken(token);
      return googleFetch(url, options, false);
    }
  }
  if (resp.status === 401) {
    chrome.identity.removeCachedAuthToken({ token }, () => {});
  }
  return resp;
}

async function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function spreadsheetIdFromUrl(url) {
  const match = String(url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : "";
}

function quoteSheet(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function colName(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function objectsFromValues(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0].map((h) => String(h || "").trim());
  const rows = [];
  for (let r = 1; r < values.length; r += 1) {
    const row = {};
    let empty = true;
    headers.forEach((h, c) => {
      const value = values[r][c] == null ? "" : String(values[r][c]).trim();
      row[h] = value;
      if (value) empty = false;
    });
    if (!empty) rows.push(row);
  }
  return rows;
}

function findSheetName(names, candidates) {
  const normalized = names.map((name) => ({ name, low: name.toLowerCase() }));
  for (const candidate of candidates) {
    const found = normalized.find((item) => item.low.includes(candidate));
    if (found) return found.name;
  }
  return "";
}

async function loadActiveSheet() {
  try {
    const tab = await activeTab();
    state.spreadsheetId = spreadsheetIdFromUrl(tab && tab.url);
    if (!state.spreadsheetId) {
      setStatus("sheetStatus", "Open a Google Sheet tab first.", false);
      return;
    }

    setStatus("sheetStatus", "Loading sheet...");
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${state.spreadsheetId}?fields=properties.title,sheets.properties.title`;
    const metaResp = await googleFetch(metaUrl);
    const meta = await jsonOrThrow(metaResp);
    state.spreadsheetTitle = meta.properties?.title || "";
    const sheetNames = (meta.sheets || []).map((sheet) => sheet.properties.title);
    const mmName = findSheetName(sheetNames, ["mention mappings", "mention mapping", "mm"]);
    const ldName = findSheetName(sheetNames, ["localization details", "localisation details", "localization detail", "ld"]);
    if (!mmName) throw new Error("Cannot find Mention Mappings tab.");

    const ranges = [`${quoteSheet(mmName)}!A:ZZ`];
    if (ldName) ranges.push(`${quoteSheet(ldName)}!A:ZZ`);
    const params = new URLSearchParams();
    ranges.forEach((range) => params.append("ranges", range));
    params.set("majorDimension", "ROWS");
    const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${state.spreadsheetId}/values:batchGet?${params}`;
    const valuesResp = await googleFetch(valuesUrl);
    const values = await jsonOrThrow(valuesResp);

    const mmValues = values.valueRanges?.[0]?.values || [];
    const ldValues = values.valueRanges?.[1]?.values || [];
    state.sheets = {
      mmName,
      ldName,
      mmValues,
      ldValues,
    };
    state.mm = objectsFromValues(mmValues);
    state.ld = objectsFromValues(ldValues);
    setStatus("sheetStatus", `Loaded ${state.spreadsheetTitle}: ${state.mm.length} mention rows.`, true);
  } catch (err) {
    setStatus("sheetStatus", err.message, false);
  }
}

async function jsonOrThrow(resp) {
  const text = await resp.text();
  const json = text ? JSON.parse(text) : {};
  if (!resp.ok) {
    throw new Error(json.error?.message || json.detail || json.error || resp.statusText);
  }
  return json;
}

async function backendFetch(path, body) {
  const settings = await getSettings();
  const base = cleanBaseUrl(settings.backendUrl);
  const secret = settings.proxySecret || "";
  if (!base) throw new Error("Set Backend URL first.");
  const resp = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: body
      ? { "Content-Type": "application/json", "X-Proxy-Secret": secret }
      : { "X-Proxy-Secret": secret },
    body: body ? JSON.stringify(body) : undefined,
  });
  return jsonOrThrow(resp);
}

async function checkHealth() {
  try {
    const health = await backendFetch("/health");
    setStatus(
      "connectionStatus",
      `Backend ok. Madeye=${Boolean(health.madeye)} user_email=${Boolean(health.user_email)}`,
      true,
    );
  } catch (err) {
    setStatus("connectionStatus", err.message, false);
  }
}

async function runVerifier(mode) {
  if (!state.mm.length) await loadActiveSheet();
  if (!state.mm.length) return;
  try {
    setStatus("runStatus", mode === "culture" ? "Running Opus cultural check..." : "Running checks...");
    const email = await getProfileEmail();
    const payload = {
      ld: state.ld,
      mm: state.mm,
      source_lang: $("sourceLang").value,
      target_lang: $("targetLang").value,
      user_email: email,
      run_llm: true,
      check_mode: mode,
    };
    const result = await backendFetch("/verify-mentions", payload);
    state.findings = result.findings || [];
    renderFindings(result);
    $("writeBtn").disabled = state.findings.length === 0;
    setStatus("runStatus", `${state.findings.length} issue(s) found.`, true);
  } catch (err) {
    setStatus("runStatus", err.message, false);
  }
}

function renderFindings(result) {
  $("stats").classList.remove("hidden");
  $("issueCount").textContent = String((result.findings || []).length);
  $("rowCount").textContent = String(result.rowCount || 0);
  $("mentionCount").textContent = String(result.mmCount || 0);
  const box = $("findings");
  const findings = result.findings || [];
  if (!findings.length) {
    box.innerHTML = '<div class="status ok">No issues found.</div>';
    return;
  }
  box.innerHTML = findings.slice(0, 80).map((f) => `
    <div class="finding">
      <span class="kind">${escapeHtml(f.kind || "ISSUE")}</span>
      <span class="rowtag">Row ${escapeHtml(f.row || "")}</span>
      <div>${escapeHtml(f.detail || "")}</div>
      ${f.suggestion ? `<div class="suggestion">→ ${escapeHtml(f.suggestion)}</div>` : ""}
    </div>
  `).join("");
}

function confidenceFor(rowFindings) {
  const weights = {
    MISSING_LOCALISATION: 100,
    SOURCE_NAME_NOT_LOCALIZED: 100,
    MENTION_MASTER_MISMATCH: 30,
    FAMILY_SURNAME_MISMATCH: 45,
    CHARACTER_CONTEXT_MISMATCH: 35,
    ENTITY_COMPONENT_INCONSISTENCY: 30,
    STRUCTURAL_INCONSISTENCY: 25,
    TARGET_CULTURE_MISMATCH: 25,
    REGISTER_MISMATCH: 20,
    SAME_FIRST_NAME_COLLISION: 40,
    SAME_LAST_NAME_COLLISION: 40,
    CROSS_CHARACTER_INCONSISTENCY: 30,
    CROSS_MENTION_INCONSISTENCY: 30,
    CULTURAL_CONTEXT_INAPPROPRIATE: 20,
    LLM_UNCONFIRMED: 15,
  };
  let explicit = null;
  let penalty = 0;
  for (const finding of rowFindings) {
    if (typeof finding.confidence === "number") {
      explicit = explicit == null ? finding.confidence : Math.min(explicit, finding.confidence);
    }
    penalty += weights[finding.kind] || 20;
  }
  return explicit == null ? Math.max(0, 100 - penalty) : Math.max(0, Math.min(100, explicit));
}

async function ensureColumns(headers, sheetName, columns) {
  const nextHeaders = headers.slice();
  const updates = [];
  for (const column of columns) {
    if (nextHeaders.findIndex((h) => h.toLowerCase() === column.toLowerCase()) >= 0) continue;
    const idx = nextHeaders.length;
    nextHeaders.push(column);
    updates.push({
      range: `${quoteSheet(sheetName)}!${colName(idx)}1`,
      values: [[column]],
    });
  }
  if (updates.length) {
    await sheetsValuesBatchUpdate(updates);
  }
  return nextHeaders;
}

async function writeFindings() {
  try {
    if (!state.findings.length) return;
    const sheetName = state.sheets.mmName;
    const headers = await ensureColumns(
      (state.sheets.mmValues[0] || []).map(String),
      sheetName,
      ["Mention Issues", "Suggested Localized Mention", "Confidence Score"],
    );
    const issueCol = findHeader(headers, ["Mention Issues"]);
    const suggestionCol = findHeader(headers, ["Suggested Localized Mention"]);
    const confidenceCol = findHeader(headers, ["Confidence Score"]);

    const byRow = new Map();
    for (const finding of state.findings) {
      const row = Number(finding.row);
      if (!row) continue;
      if (!byRow.has(row)) byRow.set(row, []);
      byRow.get(row).push(finding);
    }

    const updates = [];
    for (const [row, rowFindings] of byRow.entries()) {
      const issueText = rowFindings.map((f) => `${f.kind || "ISSUE"}: ${f.detail || ""}`).join("\n");
      const suggestion = rowFindings.find((f) => f.suggestion)?.suggestion || "";
      const confidence = `${confidenceFor(rowFindings)}%`;
      updates.push({ range: `${quoteSheet(sheetName)}!${colName(issueCol)}${row}`, values: [[issueText]] });
      updates.push({ range: `${quoteSheet(sheetName)}!${colName(suggestionCol)}${row}`, values: [[suggestion]] });
      updates.push({ range: `${quoteSheet(sheetName)}!${colName(confidenceCol)}${row}`, values: [[confidence]] });
    }
    await sheetsValuesBatchUpdate(updates);
    setStatus("runStatus", `Wrote ${byRow.size} row(s) to Mention Mappings.`, true);
    await loadActiveSheet();
  } catch (err) {
    setStatus("runStatus", err.message, false);
  }
}

async function sheetsValuesBatchUpdate(data) {
  if (!data.length) return;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${state.spreadsheetId}/values:batchUpdate`;
  const resp = await googleFetch(url, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  await jsonOrThrow(resp);
}

function findHeader(headers, candidates) {
  for (const candidate of candidates) {
    const idx = headers.findIndex((h) => String(h).toLowerCase() === candidate.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function replacementRegex(findText) {
  const escaped = String(findText).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startsWord = /^[A-Za-zÀ-ÿ0-9]/.test(findText);
  const endsWord = /[A-Za-zÀ-ÿ0-9]$/.test(findText);
  return new RegExp(`${startsWord ? "\\b" : ""}${escaped}${endsWord ? "\\b" : ""}`, "gi");
}

async function replaceAcrossSheet(previewOnly) {
  try {
    const findText = $("replaceFind").value.trim();
    const replaceText = $("replaceWith").value.trim();
    if (!findText || !replaceText) throw new Error("Enter both replacement values.");
    if (!state.mm.length) await loadActiveSheet();
    const re = replacementRegex(findText);
    const updates = [];
    const details = [];

    collectReplacementUpdates({
      sheetName: state.sheets.mmName,
      values: state.sheets.mmValues,
      columns: ["Localized Mention", "Suggested Localized Mention"],
      re,
      replaceText,
      updates,
      details,
    });
    if (state.sheets.ldName) {
      collectReplacementUpdates({
        sheetName: state.sheets.ldName,
        values: state.sheets.ldValues,
        columns: [
          "Localized Name", "Localised Name", "First Name (Localized)",
          "First Name (Localised)", "Last Name (Localized)", "Last Name (Localised)",
        ],
        re,
        replaceText,
        updates,
        details,
      });
    }

    if (!previewOnly) {
      await sheetsValuesBatchUpdate(updates);
      await loadActiveSheet();
    }
    const cells = updates.length;
    const detail = details.map((d) => `${d.sheet}/${d.column}: ${d.cells}`).join("; ");
    setStatus("replaceStatus", `${previewOnly ? "Preview" : "Applied"}: ${cells} cell(s). ${detail}`, true);
  } catch (err) {
    setStatus("replaceStatus", err.message, false);
  }
}

function collectReplacementUpdates({ sheetName, values, columns, re, replaceText, updates, details }) {
  if (!sheetName || !values || values.length < 2) return;
  const headers = values[0].map(String);
  for (const wanted of columns) {
    const col = findHeader(headers, [wanted]);
    if (col < 0) continue;
    let count = 0;
    for (let r = 1; r < values.length; r += 1) {
      const before = values[r][col] == null ? "" : String(values[r][col]);
      re.lastIndex = 0;
      if (!before || !re.test(before)) continue;
      re.lastIndex = 0;
      const after = before.replace(re, replaceText);
      if (after === before) continue;
      count += 1;
      updates.push({ range: `${quoteSheet(sheetName)}!${colName(col)}${r + 1}`, values: [[after]] });
    }
    if (count) details.push({ sheet: sheetName, column: wanted, cells: count });
  }
}

async function connectStoryCanon() {
  try {
    const tab = await activeTab();
    if (!tab?.id || !String(tab.url || "").includes("canon.pocketfm.ai")) {
      throw new Error("Open the Story Canon show tab first.");
    }
    const canon = await chrome.tabs.sendMessage(tab.id, { type: "LSV_CAPTURE_CANON" });
    if (!canon || !canon.wiki) throw new Error("Story Canon data not found on this page.");
    const result = await backendFetch("/update-canon-session", {
      secret: (await getSettings()).proxySecret || "",
      slug: canon.slug,
      url: canon.url,
      wiki: canon.wiki,
      show: canon.show,
    });
    setStatus("canonStatus", `${result.message || "Story Canon connected."} ${result.slug || ""}`, true);
  } catch (err) {
    setStatus("canonStatus", err.message, false);
  }
}

function setStatus(id, text, ok) {
  const el = $(id);
  el.textContent = text || "";
  el.classList.toggle("ok", ok === true);
  el.classList.toggle("error", ok === false);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
