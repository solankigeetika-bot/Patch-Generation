// ─── Localization Verifier — Google Apps Script ───────────────────────────────
// Bound to your Google Sheet.
// Setup:
//   1. Extensions → Apps Script → paste this file
//   2. Paste Sidebar.html as a new HTML file named "Sidebar"
//   3. In Project Settings → Script Properties, set:
//        PROXY_URL      = https://your-internal-proxy.pocketfm.com
//        PROXY_SECRET   = (same value as PROXY_SECRET in backend .env)
//        SHOW_SLUG      = e.g. twists-of-love-revenge  (from canon.pocketfm.ai URL)
//   4. Reload the sheet → you'll see "Localization Verifier" in the menu

var PROXY_URL_PROP    = "PROXY_URL";      // your deployed backend URL
var PROXY_SECRET_PROP = "PROXY_SECRET";   // shared secret
var SHOW_SLUG_PROP    = "SHOW_SLUG";      // canon.pocketfm.ai show slug

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

// ─── sheet meta (used by sidebar for auto-detection) ─────────────────────────
function getSheetMeta() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return { sheetName: ss.getName() };
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

// ─── chatbot — calls internal MADEYE proxy ────────────────────────────────────
function askQuestion(question, sourceLang, targetLang) {
  var props   = PropertiesService.getScriptProperties();
  var baseUrl = props.getProperty(PROXY_URL_PROP);
  var secret  = props.getProperty(PROXY_SECRET_PROP) || "";
  var slug    = props.getProperty(SHOW_SLUG_PROP)    || "";

  if (!baseUrl) return { error: "Set PROXY_URL in Script Properties (your internal backend URL)." };

  var data = getSheetData();
  if (data.error) return { error: data.error };

  // build compact sheet context
  var context = buildSheetContext(data.ld, sourceLang, targetLang);

  var payload = {
    question:     question,
    sheet_context: context,
    source_lang:  sourceLang,
    target_lang:  targetLang,
    show_slug:    slug
  };

  var options = {
    method: "post",
    contentType: "application/json",
    headers: { "X-Proxy-Secret": secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(baseUrl + "/chat", options);
    var json = JSON.parse(response.getContentText());
    if (json.detail) return { error: json.detail };
    return { answer: json.answer || JSON.stringify(json) };
  } catch(e) {
    return { error: "Proxy unreachable: " + e.message };
  }
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
