// ─── Localization Verifier — Google Apps Script ───────────────────────────────
// Bound to your Google Sheet.
// Setup:
//   1. Extensions → Apps Script → paste this file
//   2. Paste Sidebar.html as a new HTML file named "Sidebar"
//   3. In Project Settings → Script Properties, set:
//        ARGUS_API_KEY = sk-...               (Argus / Open WebUI API key)
//        CANON_SESSION = eyJ...               (canon.pocketfm.ai __session cookie)
//        SHOW_SLUG     = twists-of-love-revenge  (from the canon URL)
//      Optional overrides:
//        ARGUS_BASE_URL = https://argus.pocketfm.org/api   (default)
//        ARGUS_MODEL    = claude-opus-4.8                  (default)
//   4. Reload the sheet → you'll see "Localization Verifier" in the menu
//
// NOTE: The chatbot talks to Argus (PocketFM's Open WebUI), which is
// OpenAI-compatible, so we use the /chat/completions endpoint. Canon is fetched
// directly from canon.pocketfm.ai (publicly reachable). The deterministic
// verifier needs no API key at all.

// ── Scalable path (recommended): route through the internal proxy ─────────────
var PROXY_URL_PROP      = "PROXY_URL";          // e.g. https://loc-proxy.pocketfm.org
var PROXY_SECRET_PROP   = "PROXY_SECRET";       // shared secret (matches proxy's PROXY_SECRET)
// ── Direct-to-Argus path (fallback if no proxy is deployed) ───────────────────
var ARGUS_API_KEY_PROP  = "ARGUS_API_KEY";      // optional — Argus may allow open access
var ARGUS_BASE_URL_PROP = "ARGUS_BASE_URL";     // optional override
var ARGUS_MODEL_PROP    = "ARGUS_MODEL";        // optional override
var CANON_SESSION_PROP  = "CANON_SESSION";      // canon.pocketfm.ai __session cookie
var SHOW_SLUG_PROP      = "SHOW_SLUG";          // canon.pocketfm.ai show slug
var REFRESH_SECRET_PROP = "REFRESH_SECRET";     // shared secret for the token-sync web app
var CANON_HOST          = "https://canon.pocketfm.ai";
var ARGUS_BASE_URL_DEFAULT = "https://argus.pocketfm.org/api";
// Model id as it appears in Argus's /api/models list.
// "as" is the browser UI shorthand; check via listArgusModels() if unsure.
var ARGUS_MODEL_DEFAULT    = "claude-opus-4.8";

// ─── menu ─────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Localization Verifier")
    .addItem("Open Assistant", "openSidebar")
    .addToUi();
}

function openSidebar() {
  var html = HtmlService.createHtmlOutputFromFile("Sidebar")
    .setTitle("Localization Verifier")
    .setWidth(380);
  SpreadsheetApp.getUi().showSidebar(html);
}

// ─── token-sync web app ───────────────────────────────────────────────────────
// Deploy this script as a Web App (Deploy → New deployment → Web app,
// Execute as: Me, Who has access: Anyone). The userscript on argus.pocketfm.org
// POSTs the fresh 24h token here so ARGUS_API_KEY is always current.
// Body (text/plain JSON): {"secret": "...", "token": "eyJ...", "canon": "eyJ..."}
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  try {
    var body = JSON.parse(e.postData.contents);
    var expected = props.getProperty(REFRESH_SECRET_PROP);
    if (!expected || body.secret !== expected) {
      return _json({ ok: false, error: "unauthorized" });
    }
    var updated = [];
    if (body.token) { props.setProperty(ARGUS_API_KEY_PROP, body.token); updated.push("token"); }
    if (body.canon) { props.setProperty(CANON_SESSION_PROP, body.canon); updated.push("canon"); }
    return _json({ ok: true, updated: updated });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function doGet() {
  // health check so you can confirm the web app is live in a browser
  return _json({ ok: true, service: "argus-token-sync" });
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── sheet meta (used by sidebar for auto-detection) ─────────────────────────
function getSheetMeta() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return { sheetName: ss.getName() };
}

// ─── token status / save (called directly from the sidebar, no web app) ───────
// Lets you paste the Argus token straight into the sidebar once a day.
function getTokenStatus() {
  var props = PropertiesService.getScriptProperties();
  var tok = props.getProperty(ARGUS_API_KEY_PROP) || "";
  var info = { hasToken: !!tok, expiresLabel: "" };
  if (tok) {
    var exp = _jwtExp(tok);
    if (exp) {
      var mins = Math.round((exp * 1000 - Date.now()) / 60000);
      info.expiresLabel = mins > 0
        ? ("valid ~" + (mins >= 60 ? Math.round(mins / 60) + "h" : mins + "m"))
        : "expired";
    }
  }
  return info;
}

function saveArgusToken(token) {
  token = (token || "").trim().replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, error: "Empty token." };
  PropertiesService.getScriptProperties().setProperty(ARGUS_API_KEY_PROP, token);
  return getTokenStatus();
}

// Decode a JWT's exp claim without verifying the signature.
function _jwtExp(jwt) {
  try {
    var parts = jwt.split(".");
    if (parts.length < 2) return 0;
    var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var json = Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString();
    return JSON.parse(json).exp || 0;
  } catch (e) { return 0; }
}

// ─── read sheet data ──────────────────────────────────────────────────────────
function getSheetData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ldSheet = findSheet(ss, ["localization details", "localization detail", "ld"]);
  var mmSheet = findSheet(ss, ["mention mappings", "mention mapping", "mm"]);
  if (!ldSheet) return { error: "Cannot find 'Localization Details' tab." };

  var ldData = sheetToObjects(ldSheet);
  var mmData = mmSheet ? sheetToObjects(mmSheet) : [];
  return { ld: ldData, mm: mmData };
}

function findSheet(ss, keywords) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var n = sheets[i].getName().toLowerCase();
    for (var k = 0; k < keywords.length; k++) {
      if (n.indexOf(keywords[k]) !== -1) return sheets[i];
    }
  }
  return null;
}

function sheetToObjects(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(function(h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = {};
    var empty = true;
    for (var j = 0; j < headers.length; j++) {
      var v = values[i][j] !== undefined && values[i][j] !== null
              ? String(values[i][j]).trim() : "";
      row[headers[j]] = v;
      if (v) empty = false;
    }
    if (!empty) rows.push(row);
  }
  return rows;
}

// ─── run verifier ─────────────────────────────────────────────────────────────
// Runs deterministic checks in JS, then LLM layer via Claude API.
// Returns array of findings: [{row, id, type, detail, suggestion}]
function runVerifier(sourceLang, targetLang) {
  var data = getSheetData();
  if (data.error) return { error: data.error };

  var ld = data.ld;
  var mm = data.mm;

  var findings = [];

  // ── helpers ────────────────────────────────────────────────────────────────
  function norm(s) { return (s || "").trim().toLowerCase().replace(/\s+/g, " "); }
  function col(row, names) {
    var keys = Object.keys(row);
    for (var ni = 0; ni < names.length; ni++) {
      var target = names[ni].toLowerCase();
      for (var ki = 0; ki < keys.length; ki++) {
        if (keys[ki].toLowerCase() === target) return row[keys[ki]] || "";
      }
    }
    return "";
  }
  function origName(row) {
    return col(row, ["Original Name","original name","original_name","original mention"]);
  }
  function locName(row) {
    return col(row, ["Localized Name","localized name","localised name","localized_name"]);
  }
  function rowType(row) {
    return col(row, ["Type","type"]);
  }
  function rowId(row) {
    return col(row, ["ID","id"]) || "";
  }
  function firstName(row) {
    return col(row, ["First Name (Localized)","first name (localized)","first name (localised)"]);
  }
  function lastName(row) {
    return col(row, ["Last Name (Localized)","last name (localized)","last name (localised)"]);
  }
  function firstToken(s) {
    var t = (s || "").trim().split(/\s+/);
    return t[0] || "";
  }
  function lastToken(s) {
    var t = (s || "").trim().split(/\s+/);
    return t[t.length - 1] || "";
  }

  var KINSHIP = ["mama","maman","papa","schwester","bruder","tante","onkel",
                 "großvater","großmutter","oma","opa","schatz","liebling",
                 "belle-soeur","belle-mere","beau-pere","grand-pere","grand-mere"];

  // ── A1: missing localization ───────────────────────────────────────────────
  ld.forEach(function(row, i) {
    var orig = origName(row);
    var loc  = locName(row);
    if (!orig) return;
    if (!loc) {
      findings.push({ row: i + 2, id: rowId(row), kind: "MISSING_LOCALISATION",
        detail: "'" + orig + "' has no localized name.", suggestion: "" });
    }
    // source leak: localized = original (case-insensitive)
    else if (norm(orig) === norm(loc)) {
      findings.push({ row: i + 2, id: rowId(row), kind: "SOURCE_NAME_NOT_LOCALIZED",
        detail: "'" + loc + "' appears unchanged from source.", suggestion: "" });
    }
  });

  // ── A2: kinship / cultural terms surviving in target ──────────────────────
  ld.forEach(function(row, i) {
    var loc = norm(locName(row));
    KINSHIP.forEach(function(k) {
      if (loc.indexOf(k) !== -1) {
        findings.push({ row: i + 2, id: rowId(row), kind: "CULTURAL_CONTEXT_INAPPROPRIATE",
          detail: "Source kinship term '" + k + "' found in localized output.",
          suggestion: "Replace with target-language equivalent." });
      }
    });
  });

  // ── B1: first-name collisions across character rows ───────────────────────
  var fnMap = {};  // normalized first token → [{id, orig, loc}]
  ld.forEach(function(row) {
    var t = norm(rowType(row));
    if (t !== "character" && t !== "personnage") return;
    var loc = locName(row);
    if (!loc) return;
    var fn = norm(firstToken(loc));
    if (fn.length < 2) return;
    if (!fnMap[fn]) fnMap[fn] = [];
    fnMap[fn].push({ id: rowId(row), orig: origName(row), loc: loc });
  });
  Object.keys(fnMap).forEach(function(fn) {
    var group = fnMap[fn];
    if (group.length < 2) return;
    var origSet = {};
    group.forEach(function(g) { origSet[norm(g.orig)] = true; });
    if (Object.keys(origSet).length < 2) return;
    var names = group.map(function(g) { return g.loc; }).join(", ");
    findings.push({ row: "—", id: "—", kind: "SAME_FIRST_NAME_COLLISION",
      detail: "Multiple unrelated characters share first name '" + fn + "': " + names,
      suggestion: "" });
  });

  // ── B2: last-name collisions ───────────────────────────────────────────────
  var lnMap = {};
  ld.forEach(function(row) {
    var t = norm(rowType(row));
    if (t !== "character" && t !== "personnage") return;
    var loc = locName(row);
    if (!loc) return;
    var ln = norm(lastToken(loc));
    if (ln.length < 2) return;
    if (!lnMap[ln]) lnMap[ln] = [];
    lnMap[ln].push({ id: rowId(row), orig: origName(row), loc: loc });
  });
  Object.keys(lnMap).forEach(function(ln) {
    var group = lnMap[ln];
    if (group.length < 2) return;
    var origLastNames = {};
    group.forEach(function(g) {
      origLastNames[norm(lastToken(g.orig))] = true;
    });
    if (Object.keys(origLastNames).length < 2) return;
    var names = group.map(function(g) { return g.loc; }).join(", ");
    findings.push({ row: "—", id: "—", kind: "SAME_LAST_NAME_COLLISION",
      detail: "Unrelated characters share last name '" + ln + "': " + names,
      suggestion: "" });
  });

  // ── B3: uniformly-flat (majority localized form) ──────────────────────────
  var origToLocs = {};
  ld.forEach(function(row) {
    var orig = norm(origName(row));
    var loc  = locName(row);
    if (!orig || !loc) return;
    if (!origToLocs[orig]) origToLocs[orig] = {};
    origToLocs[orig][loc] = (origToLocs[orig][loc] || 0) + 1;
  });
  ld.forEach(function(row, i) {
    var orig = norm(origName(row));
    var loc  = locName(row);
    if (!orig || !loc) return;
    var counts = origToLocs[orig];
    var majority = Object.keys(counts).sort(function(a,b){ return counts[b]-counts[a]; })[0];
    if (loc !== majority) {
      findings.push({ row: i + 2, id: rowId(row), kind: "CROSS_CHARACTER_INCONSISTENCY",
        detail: "'" + origName(row) + "' localized as '" + loc + "' but majority form is '" + majority + "'.",
        suggestion: majority });
    }
  });

  return { findings: findings, rowCount: ld.length, mmCount: mm.length };
}

// ─── write findings back to sheet ─────────────────────────────────────────────
function writeFindingsToSheet(findings) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ldSheet = findSheet(ss, ["localization details", "localization detail", "ld"]);
  if (!ldSheet) return { error: "Sheet not found." };

  // find or create "Localization Issues" column
  var headers = ldSheet.getRange(1, 1, 1, ldSheet.getLastColumn()).getValues()[0];
  var issueColIdx = -1;
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).toLowerCase().indexOf("localization issues") !== -1 ||
        String(headers[i]).toLowerCase().indexOf("localisation issues") !== -1) {
      issueColIdx = i + 1;
      break;
    }
  }
  if (issueColIdx === -1) {
    issueColIdx = ldSheet.getLastColumn() + 1;
    ldSheet.getRange(1, issueColIdx).setValue("Localization Issues");
  }

  // group findings by row
  var byRow = {};
  findings.forEach(function(f) {
    if (typeof f.row === "number") {
      if (!byRow[f.row]) byRow[f.row] = [];
      byRow[f.row].push(f);
    }
  });

  // write
  var written = 0;
  Object.keys(byRow).forEach(function(rowNum) {
    var cell = ldSheet.getRange(parseInt(rowNum), issueColIdx);
    var parts = byRow[rowNum].map(function(f) {
      var text = f.kind + ": " + f.detail;
      if (f.suggestion) text += " Suggested: '" + f.suggestion + "'.";
      return text;
    });
    cell.setValue(parts.join(" | "));
    cell.setBackground("#fff2cc");
    written++;
  });
  return { written: written };
}

// ─── canon fetch (canon.pocketfm.ai is publicly reachable) ────────────────────
// Cached per-show for 6 hours so we don't refetch on every question.
function getCanonContext() {
  var props = PropertiesService.getScriptProperties();
  var session = props.getProperty(CANON_SESSION_PROP);
  var slug    = props.getProperty(SHOW_SLUG_PROP);
  if (!session || !slug) return "";   // canon optional

  var cache = CacheService.getScriptCache();
  var cacheKey = "canon_" + slug;
  var cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    var resp = UrlFetchApp.fetch(CANON_HOST + "/" + slug + "/", {
      headers: { "Cookie": "__session=" + session },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return "";
    var html = resp.getContentText();
    var ctx = extractCanonContext(html);
    if (ctx) cache.put(cacheKey, ctx, 21600);  // 6 hours
    return ctx;
  } catch(e) {
    return "";
  }
}

// Pull WIKI_DATA out of the canon page and build a compact character summary.
function extractCanonContext(html) {
  // find the largest <script> block
  var scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
  var big = "";
  scripts.forEach(function(s) { if (s.length > big.length) big = s; });

  var idx = big.indexOf("WIKI_DATA");
  if (idx === -1) return "";
  var braceStart = big.indexOf("{", idx);
  if (braceStart === -1) return "";

  // brace-match to extract the JSON object
  var depth = 0, end = -1, inStr = false, esc = false;
  for (var i = braceStart; i < big.length; i++) {
    var c = big[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return "";

  var wiki;
  try { wiki = JSON.parse(big.substring(braceStart, end)); }
  catch(e) { return ""; }

  var lines = ["Show: " + (wiki.show_title || "")];

  // flatten characters (list or grouped)
  var chars = wiki.characters;
  var list = [];
  if (Array.isArray(chars)) list = chars;
  else if (chars && typeof chars === "object") {
    Object.keys(chars).forEach(function(g) {
      if (Array.isArray(chars[g])) list = list.concat(chars[g]);
    });
  }
  list.slice(0, 50).forEach(function(c) {
    var line = "  " + (c.name || "");
    if (c.aliases && c.aliases.length) line += " (aka " + c.aliases.slice(0,3).join(", ") + ")";
    if (c.role) line += " [" + c.role + "]";
    if (c.family) line += " — " + c.family + " family";
    if (c.description) line += ": " + String(c.description).substring(0, 120);
    lines.push(line);
  });

  if (wiki.dynasty_hierarchy) lines.push("Families: " + String(wiki.dynasty_hierarchy).substring(0, 300));
  return lines.join("\n");
}

// ─── chatbot ──────────────────────────────────────────────────────────────────
// Two paths, chosen automatically:
//   1. If PROXY_URL is set → call the internal/Cloud-Run proxy (scalable; the
//      proxy holds the Argus credential and fetches canon server-side).
//   2. Otherwise → call Argus directly (fallback; needs ARGUS_API_KEY here).
function askQuestion(question, sourceLang, targetLang) {
  var props = PropertiesService.getScriptProperties();

  var data = getSheetData();
  if (data.error) return { error: data.error };
  var sheetCtx = buildSheetContext(data.ld, sourceLang, targetLang);

  var proxyUrl = props.getProperty(PROXY_URL_PROP);
  if (proxyUrl) {
    return _askViaProxy(proxyUrl, props, question, sourceLang, targetLang, sheetCtx);
  }

  // ── direct-to-Argus fallback ───────────────────────────────────────────────
  var apiKey  = props.getProperty(ARGUS_API_KEY_PROP);  // may be null
  var baseUrl = (props.getProperty(ARGUS_BASE_URL_PROP) || ARGUS_BASE_URL_DEFAULT).replace(/\/+$/, "");
  var model   = props.getProperty(ARGUS_MODEL_PROP)    || ARGUS_MODEL_DEFAULT;

  var canonCtx = getCanonContext();

  var system =
    "You are a localization expert assistant for PocketFM audiobook production.\n" +
    "Source language: " + sourceLang + ". Target language: " + targetLang + ".\n" +
    "Answer questions about characters, families, entities, and localization " +
    "decisions concisely. Always ground answers in the CANON and SHEET below.\n\n" +
    "--- CANON ---\n" + (canonCtx || "(not available)") + "\n\n" +
    "--- LOCALIZATION SHEET ---\n" + sheetCtx;

  var headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  var payload = {
    model: model,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: question }
    ],
    max_tokens: 1024,
    temperature: 0.2
  };

  var options = {
    method: "post",
    contentType: "application/json",
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(baseUrl + "/chat/completions", options);
    var code = response.getResponseCode();
    var json = JSON.parse(response.getContentText());
    if (code !== 200 || json.error) {
      var msg = (json.error && (json.error.message || json.error)) || ("HTTP " + code);
      return { error: "Argus API error: " + msg };
    }
    return { answer: json.choices[0].message.content };
  } catch(e) {
    return { error: "Argus API error: " + e.message };
  }
}

// ─── chatbot via proxy (scalable path) ────────────────────────────────────────
// The proxy holds the Argus credential and fetches canon server-side, so the
// sheet only sends the question + a compact sheet summary + the show slug.
function _askViaProxy(proxyUrl, props, question, sourceLang, targetLang, sheetCtx) {
  var secret = props.getProperty(PROXY_SECRET_PROP) || "";
  var slug   = props.getProperty(SHOW_SLUG_PROP) || "";
  var url    = proxyUrl.replace(/\/+$/, "") + "/chat";

  var options = {
    method: "post",
    contentType: "application/json",
    headers: { "X-Proxy-Secret": secret },
    payload: JSON.stringify({
      question: question,
      sheet_context: sheetCtx,
      source_lang: sourceLang,
      target_lang: targetLang,
      show_slug: slug
    }),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(url, options);
    var code = response.getResponseCode();
    var json = JSON.parse(response.getContentText());
    if (code !== 200) {
      return { error: "Proxy error (" + code + "): " + (json.detail || json.error || "") };
    }
    return { answer: json.answer };
  } catch(e) {
    return { error: "Proxy error: " + e.message };
  }
}

// ─── helper — fetch Argus model list (run from Apps Script editor to find IDs) ─
// Call this once from the Apps Script editor (Run → listArgusModels) to see
// the exact model ids available in your Argus instance, then set ARGUS_MODEL.
function listArgusModels() {
  var props   = PropertiesService.getScriptProperties();
  var apiKey  = props.getProperty(ARGUS_API_KEY_PROP);
  var baseUrl = (props.getProperty(ARGUS_BASE_URL_PROP) || ARGUS_BASE_URL_DEFAULT).replace(/\/+$/, "");
  var headers = {};
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
  var resp = UrlFetchApp.fetch(baseUrl + "/models", { headers: headers, muteHttpExceptions: true });
  Logger.log(resp.getContentText());
}

// ─── build sheet context string ───────────────────────────────────────────────
function buildSheetContext(ld, sourceLang, targetLang) {
  var context = "Localization sheet: " + sourceLang + " → " + targetLang + ".\n";
  context += "Rows (Original Name → Localized Name [Type]):\n";
  var sample = ld.slice(0, 100);
  sample.forEach(function(row) {
    var orig = row["Original Name"] || row["original name"] || row["original_name"] || "";
    var loc  = row["Localized Name"] || row["localized name"] || row["localised name"] || "";
    var type = row["Type"] || row["type"] || "";
    if (orig) context += "  " + orig + " → " + loc + " [" + type + "]\n";
  });
  return context;
}
