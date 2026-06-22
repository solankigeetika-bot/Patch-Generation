"use strict";

const BUNDLED_PROXY_SECRET = String(globalThis.LS_VERIFIER_PROXY_SECRET || "").trim();

const DEFAULTS = {
  backendUrl: "http://127.0.0.1:8000",
  proxySecret: BUNDLED_PROXY_SECRET,
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
  const proxySecret = BUNDLED_PROXY_SECRET || settings.proxySecret || "";
  if (settings.proxySecret !== proxySecret) {
    await setSettings({ ...settings, backendUrl, proxySecret });
  }
  $("backendUrl").value = backendUrl;
  $("proxySecret").value = proxySecret;

  $("saveSettings").addEventListener("click", saveSettingsFromUi);
  $("healthBtn").addEventListener("click", checkHealth);
  $("refreshBtn").addEventListener("click", loadActiveSheet);
  $("loadSheetBtn").addEventListener("click", loadActiveSheet);
  $("authGoogleBtn").addEventListener("click", authorizeGoogleSheets);
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
    const timer = setTimeout(() => {
      reject(new Error("Google auth did not finish. Reload the extension, click Authorize Google, and approve the Google access prompt."));
    }, 120000);
    chrome.identity.getAuthToken({ interactive }, (token) => {
      clearTimeout(timer);
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

async function clearCachedTokens() {
  if (!chrome.identity.clearAllCachedAuthTokens) return;
  return new Promise((resolve) => {
    chrome.identity.clearAllCachedAuthTokens(resolve);
  });
}

async function activeTab() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = activeTabs[0];
  if (spreadsheetIdFromUrl(active?.url)) return active;

  const sheetTabs = await chrome.tabs.query({ url: "https://docs.google.com/spreadsheets/*" });
  if (!sheetTabs.length) return active;
  const activeSheet = sheetTabs.find((tab) => tab.active);
  return activeSheet || sheetTabs[0];
}

async function activeCanonTab() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = activeTabs[0];
  if (isCanonUrl(active?.url)) return active;

  const canonTabs = await chrome.tabs.query({ url: "https://canon.pocketfm.ai/*" });
  if (!canonTabs.length) return active;
  const activeCanon = canonTabs.find((tab) => tab.active);
  return activeCanon || canonTabs[0];
}

function spreadsheetIdFromUrl(url) {
  const match = String(url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : "";
}

function isCanonUrl(url) {
  return String(url || "").includes("canon.pocketfm.ai");
}

function gidFromUrl(url) {
  const match = String(url || "").match(/[?#&]gid=([0-9]+)/);
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

async function loadActiveSheet(options = {}) {
  const forceApi = options.forceApi === true;
  try {
    const tab = await activeTab();
    state.spreadsheetId = spreadsheetIdFromUrl(tab && tab.url);
    if (!state.spreadsheetId) {
      setStatus("sheetStatus", "Open a Google Sheet tab first.", false);
      return;
    }

    setStatus("sheetStatus", "Loading sheet...");
    try {
      await loadSheetViaApi();
    } catch (err) {
      if (forceApi) throw err;
      setStatus("sheetStatus", "Google auth unavailable; reading sheet directly...");
      await loadSheetViaCsvExport(tab);
    }
  } catch (err) {
    setStatus("sheetStatus", err.message, false);
  }
}

async function authorizeGoogleSheets() {
  try {
    setStatus("sheetStatus", "Opening Google authorization...");
    await clearCachedTokens();
    await getToken(true);
    setStatus("sheetStatus", "Google authorized. Loading sheet with write access...", true);
    await loadActiveSheet({ forceApi: true });
  } catch (err) {
    setStatus(
      "sheetStatus",
      `Google authorization failed: ${err.message}`,
      false,
    );
  }
}

async function loadSheetViaApi() {
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
}

async function loadSheetViaCsvExport(tab) {
  const currentGid = gidFromUrl(tab?.url);
  let mmValues = [];
  let mmName = "Mention Mappings";
  try {
    mmValues = await fetchCsvSheet("Mention Mappings");
  } catch (_err) {
    if (!currentGid) throw new Error("Google auth failed and no sheet gid is visible in the URL.");
    mmValues = await fetchCsvSheet("", currentGid);
    mmName = "Mention Mappings";
  }
  if (!looksLikeMentionMappings(mmValues)) {
    throw new Error("Could not read Mention Mappings. Click the Mention Mappings tab, then click Load Sheet again.");
  }

  let ldValues = [];
  try {
    ldValues = await fetchCsvSheet("Localization Details");
  } catch (_err) {
    ldValues = [];
  }
  state.spreadsheetTitle = "Active Google Sheet";
  state.sheets = {
    mmName,
    ldName: ldValues.length ? "Localization Details" : "",
    mmValues,
    ldValues,
    readOnly: true,
  };
  state.mm = objectsFromValues(mmValues);
  state.ld = objectsFromValues(ldValues);
  setStatus(
    "sheetStatus",
    `Loaded ${state.mm.length} mention rows. Direct-read mode: writing back still needs Google auth.`,
    true,
  );
}

function looksLikeMentionMappings(values) {
  const headers = normalizedHeaders(values);
  return (
    headers.includes("original mention")
    && (headers.includes("localized mention") || headers.includes("localised mention"))
  );
}

async function fetchCsvSheet(sheetName, gid = "") {
  const urls = csvExportUrls(sheetName, gid);
  const failures = [];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { credentials: "include" });
      const text = await resp.text();
      if (!resp.ok || /<html|<!doctype/i.test(text)) {
        failures.push(`${resp.status} ${resp.statusText}`.trim());
        continue;
      }
      const rows = parseCsv(text);
      if (rows.length) return rows;
      failures.push("empty csv");
    } catch (err) {
      failures.push(err.message);
    }
  }
  throw new Error(`Could not export ${sheetName || gid}: ${failures.filter(Boolean).join("; ")}`);
}

function csvExportUrls(sheetName, gid = "") {
  const urls = [];
  if (gid) {
    const exportParams = new URLSearchParams({ format: "csv", gid, single: "true" });
    urls.push(`https://docs.google.com/spreadsheets/d/${state.spreadsheetId}/export?${exportParams}`);

    const gvizParams = new URLSearchParams({ tqx: "out:csv", gid });
    urls.push(`https://docs.google.com/spreadsheets/d/${state.spreadsheetId}/gviz/tq?${gvizParams}`);
  }
  if (sheetName) {
    const gvizParams = new URLSearchParams({ tqx: "out:csv", sheet: sheetName });
    urls.push(`https://docs.google.com/spreadsheets/d/${state.spreadsheetId}/gviz/tq?${gvizParams}`);

    const exportParams = new URLSearchParams({ format: "csv", sheet: sheetName, single: "true" });
    urls.push(`https://docs.google.com/spreadsheets/d/${state.spreadsheetId}/export?${exportParams}`);
  }
  return urls;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((value) => value)) rows.push(row);
  return rows;
}

function normalizedHeaders(values) {
  return (values?.[0] || [])
    .map((h) => String(h || "").trim().toLowerCase().replace(/\s+/g, " "));
}

async function jsonOrThrow(resp) {
  const text = await resp.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (/<html|<!doctype/i.test(text)) {
        throw new Error("Backend returned a tunnel warning page. Reload the extension and try again, or use a deployed HTTPS backend.");
      }
      json = { error: text };
    }
  }
  if (!resp.ok) {
    throw new Error(json.error?.message || json.detail || json.error || resp.statusText);
  }
  return json;
}

async function backendFetch(path, body) {
  const settings = await getSettings();
  const base = cleanBaseUrl(settings.backendUrl);
  const secret = BUNDLED_PROXY_SECRET || settings.proxySecret || "";
  if (!base) throw new Error("Set Backend URL first.");
  const headers = {
    "X-Proxy-Secret": secret,
    "bypass-tunnel-reminder": "ls-verifier-agent",
  };
  if (body) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers,
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
    setStatus("runStatus", verifierStatus(result, state.findings.length), !result.warning);
  } catch (err) {
    setStatus("runStatus", err.message, false);
  }
}

function verifierStatus(result, issueCount) {
  const llm = result.llm || {};
  const parts = [`${issueCount} issue(s) found.`];
  if (llm.ran) {
    parts.push(`Opus ran on up to ${llm.limit || "configured"} candidate rows.`);
  } else if (result.warning) {
    parts.push(result.warning);
  }
  return parts.join(" ");
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
    const tab = await activeCanonTab();
    if (!tab?.id || !isCanonUrl(tab.url)) {
      throw new Error("Open the Story Canon show tab first.");
    }
    const canon = await captureCanonFromTab(tab.id);
    if (!canon || !canon.wiki) throw new Error("Story Canon data not found on this page.");
    const result = await backendFetch("/update-canon-session", {
      secret: BUNDLED_PROXY_SECRET || (await getSettings()).proxySecret || "",
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

async function captureCanonFromTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "LSV_CAPTURE_CANON" });
  } catch (_err) {
    if (chrome.scripting?.executeScript) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content_canon.js"],
      });
      return chrome.tabs.sendMessage(tabId, { type: "LSV_CAPTURE_CANON" });
    }
    throw new Error("Reload the Story Canon tab, then click Connect Story Canon again.");
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
