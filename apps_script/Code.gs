// ─── LS Verifier — Google Apps Script (Editor Add-on) ─────────────────────────
// Packaged as a Sheets Editor Add-on: install once on your account and it shows
// up under Extensions → LS Verifier in EVERY spreadsheet you open.
// Nothing is pasted per-sheet. See INSTALL_ADDON.md for the install steps.
// Setup for the published add-on:
//   1. Deploy the backend.
//   2. Fill BACKEND_URL and BAKED_PROXY_SECRET below.
//   3. Publish/install the add-on. Users do not need Script Properties or keys.
//
// NOTE: The chatbot talks to Madeye, which is OpenAI-compatible, so we use the
// /chat/completions endpoint. Canon is fetched
// directly from canon.pocketfm.ai (publicly reachable). The deterministic
// verifier needs no API key at all.

// ── Zero-config backend settings for the published add-on ────────────────────
// Fill these once after Cloud Run is stable. Script Properties with the same
// names can still override them for staging or emergency backend swaps.
var BACKEND_URL = "";             // e.g. https://ls-verifier-abc123-uc.a.run.app
var BAKED_PROXY_SECRET = "";      // shared backend secret, not a user credential

var BACKEND_URL_PROP    = "BACKEND_URL";
var PROXY_URL_PROP      = "PROXY_URL";          // legacy override name
var PROXY_SECRET_PROP   = "PROXY_SECRET";       // shared secret (matches backend)
// ── Direct-to-Madeye path (fallback if no proxy is deployed) ──────────────────
var MADEYE_API_KEY_PROP    = "MADEYE_API_KEY";
var MADEYE_BASE_URL_PROP   = "MADEYE_BASE_URL";
var MADEYE_MODEL_PROP      = "MADEYE_MODEL";
var MADEYE_USER_EMAIL_PROP = "MADEYE_USER_EMAIL";
// Legacy names still read for older copied projects.
var ARGUS_API_KEY_PROP  = "ARGUS_API_KEY";
var ARGUS_BASE_URL_PROP = "ARGUS_BASE_URL";
var ARGUS_MODEL_PROP    = "ARGUS_MODEL";
var CANON_SESSION_PROP  = "CANON_SESSION";      // canon.pocketfm.ai __session cookie
var SHOW_SLUG_PROP      = "SHOW_SLUG";          // canon.pocketfm.ai show slug
var REFRESH_SECRET_PROP = "REFRESH_SECRET";     // shared secret for the token-sync web app
var CANON_HOST          = "https://canon.pocketfm.ai";
var MADEYE_MODEL_DEFAULT = "claude-opus-4-7";

// ─── menu (Editor Add-on) ─────────────────────────────────────────────────────
// As an add-on this lives under Extensions → LS Verifier in EVERY
// spreadsheet you open — nothing is pasted per-sheet. onOpen/onInstall are the
// add-on lifecycle triggers; createAddonMenu() puts items under the Extensions
// menu rather than a sheet-specific top-level menu.
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createAddonMenu()
    .addItem("Run Mention Verifier", "verifyAndWriteMentions")
    .addItem("Open Assistant", "openSidebar")
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function openSidebar() {
  var html = HtmlService.createHtmlOutputFromFile("Sidebar")
    .setTitle("LS Verifier")
    .setWidth(380);
  SpreadsheetApp.getUi().showSidebar(html);
}

// ─── token-sync web app ───────────────────────────────────────────────────────
// Deploy this script as a Web App (Deploy → New deployment → Web app,
// Execute as: Me, Who has access: Anyone). The userscript on argus.pocketfm.org
// Legacy token-sync hook. Proxy mode with a stable Madeye key is preferred.
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
    if (body.token) { props.setProperty(MADEYE_API_KEY_PROP, body.token); updated.push("token"); }
    if (body.canon) { props.setProperty(CANON_SESSION_PROP, body.canon); updated.push("canon"); }
    return _json({ ok: true, updated: updated });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function doGet() {
  // health check so you can confirm the web app is live in a browser
  return _json({ ok: true, service: "madeye-token-sync" });
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
// Lets you paste a direct API key straight into the sidebar.
function getTokenStatus() {
  var props = PropertiesService.getScriptProperties();
  var tok = props.getProperty(MADEYE_API_KEY_PROP) || props.getProperty(ARGUS_API_KEY_PROP) || "";
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

function saveMadeyeKey(token) {
  token = (token || "").trim().replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, error: "Empty token." };
  PropertiesService.getScriptProperties().setProperty(MADEYE_API_KEY_PROP, token);
  return getTokenStatus();
}

// Legacy alias for older copied sidebars/bookmarklets.
function saveArgusToken(token) {
  return saveMadeyeKey(token);
}

function _activeUserEmail(props) {
  var fallback = props.getProperty(MADEYE_USER_EMAIL_PROP) || "";
  try {
    return Session.getActiveUser().getEmail() || fallback;
  } catch (e) {
    return fallback;
  }
}

function _backendUrl(props) {
  return (props.getProperty(BACKEND_URL_PROP) ||
          props.getProperty(PROXY_URL_PROP) ||
          BACKEND_URL || "").trim();
}

function _proxySecret(props) {
  return (props.getProperty(PROXY_SECRET_PROP) ||
          BAKED_PROXY_SECRET || "").trim();
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
  if (!mmSheet) return { error: "Cannot find 'Mention Mappings' tab." };

  var ldData = ldSheet ? sheetToObjects(ldSheet) : [];
  var mmData = sheetToObjects(mmSheet);
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

// ─── run Localization Details verifier ───────────────────────────────────────
// Secondary/admin check. The default localizer workflow is Mention Mappings.
// Returns array of findings: [{row, id, type, detail, suggestion}]
function runDetailsVerifier(sourceLang, targetLang) {
  var data = getSheetData();
  if (data.error) return { error: data.error };
  if (!data.ld || !data.ld.length) {
    return { error: "Cannot find 'Localization Details' rows for details verification." };
  }

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

// Primary localizer workflow: verify Original Mention vs Localized Mention in
// the Mention Mappings tab. Kept as runVerifier() because the sidebar calls it.
function runVerifier(sourceLang, targetLang) {
  return verifyMentionsAgent(sourceLang, targetLang);
}

// Backend agent path: deterministic checks + Story Canon + Madeye reasoning.
// Falls back to local deterministic checks when no backend URL is configured.
function verifyMentionsAgent(sourceLang, targetLang) {
  var props = PropertiesService.getScriptProperties();
  var proxyUrl = _backendUrl(props);
  if (!proxyUrl) return verifyMentions(sourceLang, targetLang);

  var data = getSheetData();
  if (data.error) return { error: data.error };

  var url = proxyUrl.replace(/\/+$/, "") + "/verify-mentions";
  var payload = {
    ld: data.ld || [],
    mm: data.mm || [],
    source_lang: sourceLang || "en",
    target_lang: targetLang || "fr",
    show_slug: props.getProperty(SHOW_SLUG_PROP) || "",
    user_email: _activeUserEmail(props),
    run_llm: true
  };
  var options = {
    method: "post",
    contentType: "application/json",
    headers: { "X-Proxy-Secret": _proxySecret(props) },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(url, options);
    var code = response.getResponseCode();
    var text = response.getContentText();
    var json = {};
    try { json = JSON.parse(text); }
    catch(e) { return { error: "Backend agent returned non-JSON: " + text.substring(0, 200) }; }
    if (code !== 200) {
      return { error: "Backend agent error (" + code + "): " + (json.detail || json.error || text) };
    }
    json.rowCount = json.rowCount || (data.mm || []).length;
    json.mmCount = json.mmCount || (data.mm || []).length;
    json.sourceTab = "Mention Mappings";
    return json;
  } catch(e) {
    return { error: "Backend agent error: " + e.message };
  }
}

// ─── Mention Mappings verifier ────────────────────────────────────────────────
// Checks the "Mention Mappings" tab (Original Mention → Localized Mention)
// against the master dictionary in "Localization Details" when present.
// Deterministic; no token required. Produces a concrete suggested localized
// mention per row.
function verifyMentions(sourceLang, targetLang) {
  var data = getSheetData();
  if (data.error) return { error: data.error };
  var ld = data.ld, mm = data.mm;
  if (!mm || !mm.length) return { findings: [], rowCount: 0, note: "No Mention Mappings rows found." };

  function norm(s) { return (s || "").trim().toLowerCase().replace(/\s+/g, " "); }
  function col(row, names) {
    var keys = Object.keys(row);
    for (var ni = 0; ni < names.length; ni++) {
      var t = names[ni].toLowerCase();
      for (var ki = 0; ki < keys.length; ki++) {
        if (keys[ki].toLowerCase() === t) return row[keys[ki]] || "";
      }
    }
    return "";
  }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // Build master replacement list from optional Localization Details, longest
  // original first so multi-word names are replaced before their parts.
  var pairs = [];
  ld.forEach(function(row) {
    var orig = col(row, ["Original Name","original name","original_name"]);
    var loc  = col(row, ["Localized Name","localized name","localised name","localized_name"]);
    if (orig && loc && norm(orig) !== norm(loc)) pairs.push([orig, loc]);
  });
  pairs.sort(function(a, b) { return b[0].length - a[0].length; });

  // Apply the dictionary to an original mention → expected localized mention.
  function expectedLocalized(origMention) {
    var out = origMention;
    pairs.forEach(function(p) {
      var re = new RegExp("\\b" + escapeRe(p[0]) + "\\b", "gi");
      out = out.replace(re, p[1]);
    });
    return out;
  }

  var findings = [];
  var seen = {};   // norm(original mention) → first localized mention seen

  mm.forEach(function(row, i) {
    var orig = col(row, ["Original Mention","original mention","original_mention"]);
    var loc  = col(row, ["Localized Mention","localized mention","localised mention","localized_mention"]);
    if (!orig) return;
    var rowNum = i + 2;
    var expected = expectedLocalized(orig);

    // 1. missing
    if (!loc) {
      findings.push({ tab: "Mention Mappings", row: rowNum, kind: "MISSING_LOCALISATION",
        detail: "'" + orig + "' has no localized mention.", suggestion: expected });
      return;
    }
    // 2. untranslated (a name that should have changed didn't)
    if (norm(orig) === norm(loc) && norm(expected) !== norm(orig)) {
      findings.push({ tab: "Mention Mappings", row: rowNum, kind: "SOURCE_NAME_NOT_LOCALIZED",
        detail: "'" + loc + "' is unchanged from source.", suggestion: expected });
    }
    // 3. mismatch vs master dictionary
    else if (norm(expected) !== norm(orig) && norm(loc) !== norm(expected)) {
      findings.push({ tab: "Mention Mappings", row: rowNum, kind: "MENTION_MASTER_MISMATCH",
        detail: "'" + loc + "' doesn't match the master dictionary.", suggestion: expected });
    }
    // 4. cross-mention inconsistency
    var key = norm(orig);
    if (seen[key] === undefined) {
      seen[key] = loc;
    } else if (norm(seen[key]) !== norm(loc)) {
      findings.push({ tab: "Mention Mappings", row: rowNum, kind: "CROSS_MENTION_INCONSISTENCY",
        detail: "'" + orig + "' is localized as '" + loc + "' here but '" + seen[key] + "' elsewhere.",
        suggestion: seen[key] });
    }
  });

  return { findings: findings, rowCount: mm.length, mmCount: mm.length, sourceTab: "Mention Mappings" };
}

// ─── write findings + confidence scores back to sheet ─────────────────────────
// Confidence is per-row: 100% = no issues, reduced by severity of each finding.
// Severity weights: MISSING/SOURCE_NOT_LOCALIZED = -100, COLLISION = -40,
//   INCONSISTENCY = -30, CULTURAL = -20, LLM_UNCONFIRMED = -15.
function _confidenceScore(rowFindings) {
  var explicit = null;
  var penalty = 0;
  var WEIGHTS = {
    "MISSING_LOCALISATION": 100,
    "SOURCE_NAME_NOT_LOCALIZED": 100,
    "MENTION_MASTER_MISMATCH": 30,
    "FAMILY_SURNAME_MISMATCH": 45,
    "CHARACTER_CONTEXT_MISMATCH": 35,
    "ENTITY_COMPONENT_INCONSISTENCY": 30,
    "STRUCTURAL_INCONSISTENCY": 25,
    "TARGET_CULTURE_MISMATCH": 25,
    "REGISTER_MISMATCH": 20,
    "SAME_FIRST_NAME_COLLISION": 40,
    "SAME_LAST_NAME_COLLISION": 40,
    "CROSS_CHARACTER_INCONSISTENCY": 30,
    "CROSS_MENTION_INCONSISTENCY": 30,
    "CULTURAL_CONTEXT_INAPPROPRIATE": 20,
    "LLM_UNCONFIRMED": 15
  };
  rowFindings.forEach(function(f) {
    if (typeof f.confidence === "number") {
      explicit = explicit === null ? f.confidence : Math.min(explicit, f.confidence);
    }
    penalty += (WEIGHTS[f.kind] || 20);
  });
  if (explicit !== null) return Math.max(0, Math.min(100, explicit));
  return Math.max(0, 100 - penalty);
}

function _confidenceColor(pct) {
  if (pct === 100) return "#d9ead3";   // green
  if (pct >= 70)  return "#fff2cc";   // yellow
  if (pct >= 40)  return "#fce5cd";   // orange
  return "#f4cccc";                   // red
}

function writeFindingsToSheet(findings) {
  if (findings && findings.length) {
    var mentionFinding = findings.some(function(f) {
      return f.tab === "Mention Mappings" ||
             f.kind === "MENTION_MASTER_MISMATCH" ||
             f.kind === "CROSS_MENTION_INCONSISTENCY";
    });
    if (mentionFinding) return writeMentionFindingsToSheet(findings);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ldSheet = findSheet(ss, ["localization details", "localization detail", "ld"]);
  if (!ldSheet) return { error: "Sheet not found." };

  var lastCol = ldSheet.getLastColumn();
  var headers = ldSheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // find or create "Localization Issues" column
  var issueColIdx = -1;
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).toLowerCase().indexOf("localization issues") !== -1 ||
        String(headers[i]).toLowerCase().indexOf("localisation issues") !== -1) {
      issueColIdx = i + 1; break;
    }
  }
  if (issueColIdx === -1) {
    issueColIdx = lastCol + 1;
    ldSheet.getRange(1, issueColIdx).setValue("Localization Issues");
  }

  // find or create "Confidence Score" column (always right after Issues)
  var confColIdx = -1;
  var updatedHeaders = ldSheet.getRange(1, 1, 1, ldSheet.getLastColumn()).getValues()[0];
  for (var j = 0; j < updatedHeaders.length; j++) {
    if (String(updatedHeaders[j]).toLowerCase().indexOf("confidence score") !== -1) {
      confColIdx = j + 1; break;
    }
  }
  if (confColIdx === -1) {
    confColIdx = issueColIdx + 1;
    ldSheet.getRange(1, confColIdx).setValue("Confidence Score");
  }

  // group findings by row number
  var byRow = {};
  findings.forEach(function(f) {
    if (typeof f.row === "number") {
      if (!byRow[f.row]) byRow[f.row] = [];
      byRow[f.row].push(f);
    }
  });

  // write issues + confidence for every data row (row 2 onward)
  var lastDataRow = ldSheet.getLastRow();
  var written = 0;
  for (var r = 2; r <= lastDataRow; r++) {
    var rowFindings = byRow[r] || [];
    var pct = _confidenceScore(rowFindings);
    var color = _confidenceColor(pct);

    // issues cell
    var issueCell = ldSheet.getRange(r, issueColIdx);
    if (rowFindings.length > 0) {
      var parts = rowFindings.map(function(f) {
        var text = f.kind + ": " + f.detail;
        if (f.suggestion) text += " → '" + f.suggestion + "'";
        return text;
      });
      issueCell.setValue(parts.join(" | "));
      issueCell.setBackground(color);
      written++;
    } else {
      issueCell.setValue("✓ No issues");
      issueCell.setBackground("#d9ead3");
    }

    // confidence cell
    var confCell = ldSheet.getRange(r, confColIdx);
    confCell.setValue(pct + "%");
    confCell.setBackground(color);
    confCell.setFontWeight(pct < 70 ? "bold" : "normal");
  }

  return { written: written, totalRows: lastDataRow - 1 };
}

// ─── write Mention Mappings corrections back to that tab ──────────────────────
// Adds three columns to "Mention Mappings": Mention Issues, Suggested Localized
// Mention, Confidence Score. Findings must be the output of verifyMentions().
function writeMentionFindingsToSheet(findings) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mmSheet = findSheet(ss, ["mention mappings", "mention mapping", "mm"]);
  if (!mmSheet) return { error: "Cannot find 'Mention Mappings' tab." };

  function ensureCol(label) {
    var hdrs = mmSheet.getRange(1, 1, 1, mmSheet.getLastColumn()).getValues()[0];
    for (var i = 0; i < hdrs.length; i++) {
      if (String(hdrs[i]).toLowerCase() === label.toLowerCase()) return i + 1;
    }
    var idx = mmSheet.getLastColumn() + 1;
    mmSheet.getRange(1, idx).setValue(label);
    return idx;
  }
  var issueCol = ensureCol("Mention Issues");
  var sugCol   = ensureCol("Suggested Localized Mention");
  var confCol  = ensureCol("Confidence Score");

  var byRow = {};
  findings.forEach(function(f) {
    if (typeof f.row === "number") {
      if (!byRow[f.row]) byRow[f.row] = [];
      byRow[f.row].push(f);
    }
  });

  var lastDataRow = mmSheet.getLastRow();
  var written = 0;
  for (var r = 2; r <= lastDataRow; r++) {
    var rf = byRow[r] || [];
    var pct = _confidenceScore(rf);
    var color = _confidenceColor(pct);

    var issueCell = mmSheet.getRange(r, issueCol);
    var sugCell   = mmSheet.getRange(r, sugCol);
    if (rf.length > 0) {
      issueCell.setValue(rf.map(function(f) { return f.kind + ": " + f.detail; }).join(" | "));
      issueCell.setBackground(color);
      // first finding with a suggestion drives the suggested correction
      var sug = "";
      rf.forEach(function(f) { if (!sug && f.suggestion) sug = f.suggestion; });
      sugCell.setValue(sug);
      if (sug) sugCell.setBackground(color);
      written++;
    } else {
      issueCell.setValue("✓ No issues");
      issueCell.setBackground("#d9ead3");
      sugCell.setValue("");
    }

    var confCell = mmSheet.getRange(r, confCol);
    confCell.setValue(pct + "%");
    confCell.setBackground(color);
    confCell.setFontWeight(pct < 70 ? "bold" : "normal");
  }

  return { written: written, totalRows: lastDataRow - 1 };
}

// ─── one-click runners (no sidebar, no token needed) ──────────────────────────
// Select one of these in the editor's function dropdown and click Run. The
// deterministic checks + Confidence Score get written straight to the tab.
function verifyAndWriteDetails() {
  var res = runDetailsVerifier("en", "fr");
  if (res.error) { Logger.log("ERROR: " + res.error); return res; }
  var out = writeFindingsToSheet(res.findings);
  Logger.log("Localization Details: " + res.findings.length + " findings across "
    + (out.totalRows || 0) + " rows.");
  return out;
}

function verifyAndWriteMentions() {
  var res = runVerifier("en", "fr");
  if (res.error) { Logger.log("ERROR: " + res.error); return res; }
  var out = writeMentionFindingsToSheet(res.findings);
  Logger.log("Mention Mappings: " + res.findings.length + " findings across "
    + (out.totalRows || 0) + " rows.");
  return out;
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
//   1. If BACKEND_URL is set → call the internal/Cloud-Run proxy (scalable; the
//      proxy holds the Madeye credential and fetches canon server-side).
//   2. Otherwise → call Madeye directly (fallback; needs MADEYE_API_KEY here).
function askQuestion(question, sourceLang, targetLang) {
  var props = PropertiesService.getScriptProperties();

  var data = getSheetData();
  if (data.error) return { error: data.error };
  var sheetCtx = buildSheetContext(data.mm, data.ld, sourceLang, targetLang);

  var proxyUrl = _backendUrl(props);
  if (proxyUrl) {
    return _askViaProxy(proxyUrl, props, question, sourceLang, targetLang, sheetCtx);
  }

  // ── direct-to-Madeye fallback ──────────────────────────────────────────────
  var apiKey  = props.getProperty(MADEYE_API_KEY_PROP) || props.getProperty(ARGUS_API_KEY_PROP);
  var baseUrl = (props.getProperty(MADEYE_BASE_URL_PROP) || props.getProperty(ARGUS_BASE_URL_PROP) || "").replace(/\/+$/, "");
  var model   = props.getProperty(MADEYE_MODEL_PROP) || props.getProperty(ARGUS_MODEL_PROP) || MADEYE_MODEL_DEFAULT;
  var userEmail = _activeUserEmail(props);
  if (!apiKey || !baseUrl) return { error: "Madeye direct mode needs MADEYE_API_KEY and MADEYE_BASE_URL, or set BACKEND_URL." };
  if (!userEmail) return { error: "Madeye needs metadata.user_email. Set MADEYE_USER_EMAIL in Script Properties." };

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
    metadata: { user_email: userEmail },
    max_tokens: 1024
  };
  if (model.indexOf("opus-4-7") === -1) {
    payload.temperature = 0.2;
  }

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
      return { error: "Madeye API error: " + msg };
    }
    return { answer: json.choices[0].message.content };
  } catch(e) {
    return { error: "Madeye API error: " + e.message };
  }
}

// ─── chatbot via proxy (scalable path) ────────────────────────────────────────
// The proxy holds the Madeye credential and fetches canon server-side, so the
// sheet only sends the question + a compact sheet summary + the show slug.
function _askViaProxy(proxyUrl, props, question, sourceLang, targetLang, sheetCtx) {
  var secret = _proxySecret(props);
  var slug   = props.getProperty(SHOW_SLUG_PROP) || "";
  var userEmail = _activeUserEmail(props);
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
      show_slug: slug,
      user_email: userEmail
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

// ─── helper — fetch model list (run from Apps Script editor to find IDs) ─────
// Call this once from the Apps Script editor (Run → listMadeyeModels) to see
// the exact model aliases available, then set MADEYE_MODEL.
function listMadeyeModels() {
  var props   = PropertiesService.getScriptProperties();
  var apiKey  = props.getProperty(MADEYE_API_KEY_PROP) || props.getProperty(ARGUS_API_KEY_PROP);
  var baseUrl = (props.getProperty(MADEYE_BASE_URL_PROP) || props.getProperty(ARGUS_BASE_URL_PROP) || "").replace(/\/+$/, "");
  var headers = {};
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
  var resp = UrlFetchApp.fetch(baseUrl + "/models", { headers: headers, muteHttpExceptions: true });
  Logger.log(resp.getContentText());
}

// Legacy alias for old setup docs.
function listArgusModels() {
  return listMadeyeModels();
}

// ─── build sheet context string ───────────────────────────────────────────────
function buildSheetContext(mm, ld, sourceLang, targetLang) {
  mm = mm || [];
  ld = ld || [];

  function val(row, names) {
    var keys = Object.keys(row || {});
    for (var ni = 0; ni < names.length; ni++) {
      var target = names[ni].toLowerCase();
      for (var ki = 0; ki < keys.length; ki++) {
        if (keys[ki].toLowerCase() === target) return row[keys[ki]] || "";
      }
    }
    return "";
  }

  var context = "Localization sheet: " + sourceLang + " → " + targetLang + ".\n";
  context += "Mention Mappings (Original Mention → Localized Mention):\n";
  mm.slice(0, 120).forEach(function(row) {
    var orig = val(row, ["Original Mention", "original mention", "original_mention"]);
    var loc  = val(row, ["Localized Mention", "localized mention", "localised mention", "localized_mention"]);
    if (orig) context += "  " + orig + " → " + loc + "\n";
  });

  if (ld.length) {
    context += "\nOptional Localization Details dictionary (Original Name → Localized Name [Type]):\n";
    ld.slice(0, 80).forEach(function(row) {
      var orig = val(row, ["Original Name", "original name", "original_name"]);
      var loc  = val(row, ["Localized Name", "localized name", "localised name", "localized_name"]);
      var type = val(row, ["Type", "type"]);
      if (orig) context += "  " + orig + " → " + loc + " [" + type + "]\n";
    });
  }

  return context;
}
