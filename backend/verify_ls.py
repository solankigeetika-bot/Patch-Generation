#!/usr/bin/env python3
"""
Localization-sheet verifier (the 3-4h -> 30min tool).

Reads an LSV3 workbook. `Mention Mappings` is required and is the primary tab;
`Localization Details` is optional dictionary/context when present. Then:

  Layer 1 — deterministic, instant, free:
    * MISSING        localized value blank
    * SOURCE_LEAK    localized == original when it should have changed
    * INCONSISTENT   the same character localized two different ways
    * VERIFIED       mention is exactly the character's name-parts (+ standard
                     title) -> safe to auto-confirm, marked 100%

  Layer 2 — LLM (Madeye), one batched call per CHARACTER:
    Uses the character's own Description column as the story canon (family tree,
    aliases, married names, known script errors, register) to decide the correct
    localized mention + a confidence score + a one-line reason. Only the high-
    confidence rows are treated as auto-correct; the rest are left for the human.

Output: a copy of the workbook with these columns added to Mention Mappings:
    Suggested Localized Mention | Confidence Score | Status | Reason

The human then reviews only the rows that are NOT already VERIFIED/100%.

Usage:
    pip install openpyxl openai python-dotenv
    # Layer 1 only (no key needed):
    python verify_ls.py input.xlsx -o output.xlsx
    # Layer 1 + 2 (set MADEYE_API_KEY in env or .env):
    python verify_ls.py input.xlsx -o output.xlsx --llm

Env (for --llm):
    MADEYE_API_KEY     required   Madeye API key (sent as Bearer token)
    MADEYE_BASE_URL    required   Madeye OpenAI-compatible base URL
    MADEYE_MODEL       optional   model alias (default claude-opus-4-7)
    MADEYE_USER_EMAIL  required   your @pocketfm.com email (Madeye needs metadata.user_email)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from collections import defaultdict

import openpyxl

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ─── normalisation + small dictionaries ───────────────────────────────────────
def norm(s) -> str:
    if s is None:
        return ""
    s = str(s).strip().lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("œ", "oe").replace("æ", "ae")
    s = re.sub(r"[^\w\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()

# Only UNAMBIGUOUS titles are safe for deterministic auto-verify.
# "ms" (Mme vs Mlle) and honorifics like Maitre/Docteur depend on context -> LLM.
SAFE_TITLES = {"mr": "Monsieur", "mister": "Monsieur", "mrs": "Madame",
               "miss": "Mademoiselle", "herr": "Monsieur", "frau": "Madame"}
CONNECTORS = {"de", "du", "des", "von", "der", "die", "das", "the", "of", "and",
              "et", "und", "le", "la", "les", "d", "l", "zu", "im", "den", "dem", "van"}


# ─── flexible column lookup ────────────────────────────────────────────────────
def header_index(ws):
    idx = {}
    for c, cell in enumerate(ws[1], start=1):
        if cell.value is not None:
            idx[norm(cell.value)] = c
    return idx

def pick(idx, *aliases):
    for a in aliases:
        if norm(a) in idx:
            return idx[norm(a)]
    return None


# ─── load workbook into structured form ────────────────────────────────────────
def sheet_by_keyword(wb, *keywords):
    for name in wb.sheetnames:
        low = name.lower()
        if any(k in low for k in keywords):
            return wb[name]
    return None

def load(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    mm = sheet_by_keyword(wb, "mention mapping", "mention")
    if mm is None:
        sys.exit("Workbook must contain a 'Mention Mappings' tab.")

    ld = sheet_by_keyword(wb, "localization detail", "localisation detail", "detail")
    mi = header_index(mm)

    chars = {}
    if ld is not None:
        li = header_index(ld)
        c_id   = pick(li, "ID", "id")
        c_type = pick(li, "Type", "type")
        c_orig = pick(li, "Original Name", "original_name", "original name")
        c_loc  = pick(li, "Localized Name", "localised_name", "localized name", "localised name")
        c_fno  = pick(li, "First Name (Original)")
        c_lno  = pick(li, "Last Name (Original)")
        c_fnl  = pick(li, "First Name (Localized)", "First Name (Localised)")
        c_lnl  = pick(li, "Last Name (Localized)", "Last Name (Localised)")
        c_desc = pick(li, "Description", "description")

        for r in range(2, ld.max_row + 1):
            cid = ld.cell(r, c_id).value if c_id else None
            if not cid:
                continue
            chars[cid] = {
                "type": ld.cell(r, c_type).value if c_type else "",
                "orig": ld.cell(r, c_orig).value if c_orig else "",
                "loc":  ld.cell(r, c_loc).value if c_loc else "",
                "of":   norm(ld.cell(r, c_fno).value) if c_fno else "",
                "ol":   norm(ld.cell(r, c_lno).value) if c_lno else "",
                "lf":   (ld.cell(r, c_fnl).value or "").strip() if c_fnl else "",
                "ll":   (ld.cell(r, c_lnl).value or "").strip() if c_lnl else "",
                "desc": (ld.cell(r, c_desc).value or "") if c_desc else "",
            }

    m_id   = pick(mi, "ID", "id")
    m_orig = pick(mi, "Original Mention", "original_name", "original mention")
    m_loc  = pick(mi, "Localized Mention", "localised_name", "localized mention", "localised mention")
    if not m_orig:
        sys.exit("Mention Mappings must contain an 'Original Mention' column.")

    mentions = []
    for r in range(2, mm.max_row + 1):
        orig = mm.cell(r, m_orig).value if m_orig else None
        if not orig:
            continue
        mentions.append({
            "row": r,
            "cid": mm.cell(r, m_id).value if m_id else None,
            "orig": orig,
            "loc":  mm.cell(r, m_loc).value if m_loc else "",
        })
    return wb, mm, chars, mentions


# ─── Layer 1: deterministic ────────────────────────────────────────────────────
def deterministic(cid, orig, loc, chars):
    """Return (status, suggestion, confidence, reason)."""
    c = chars.get(cid)
    if not loc:
        # try to build a safe suggestion from name parts
        sug, ok = _name_parts(c, orig)
        return ("MISSING", sug if ok else "", 100 if ok else 0,
                "blank localized mention")
    if c and norm(orig) == norm(loc):
        sug, ok = _name_parts(c, orig)
        if ok and norm(sug) != norm(orig):
            return ("SOURCE_LEAK", sug, 100, "unchanged from source")
    # safe auto-verify: mention is exactly this character's name-parts + std title
    sug, ok = _name_parts(c, orig)
    if ok:
        if norm(sug) == norm(loc):
            return ("VERIFIED", loc, 100, "matches character name parts")
        return ("MISMATCH", sug, 90, "differs from character name parts")
    return ("NEEDS_REVIEW", "", 0, "not resolvable deterministically")


def _de(name):
    """French possessive prefix: 'd'' before vowel sound, 'de ' before consonant."""
    return "d'" + name if name and name[0].lower() in "aeiou" else "de " + name

def _name_parts(c, orig):
    """Resolve a mention using ONLY this character's own name parts + safe titles.
    Returns (suggestion, resolved_fully)."""
    if not c:
        return ("", False)
    out, unresolved, named = [], 0, False
    for tk in norm(orig).split():
        if c["of"] and tk == c["of"] and c["lf"]:
            out.append(c["lf"]); named = True
        elif c["ol"] and tk == c["ol"] and c["ll"]:
            out.append(c["ll"]); named = True
        # German genitive -s: "Jakobs" -> base "jakob" matches first name -> "de Hugo"
        elif tk.endswith("s") and len(tk) > 2:
            base = tk[:-1]
            if c["of"] and base == c["of"] and c["lf"]:
                out.append(_de(c["lf"])); named = True
            elif c["ol"] and base == c["ol"] and c["ll"]:
                out.append(_de(c["ll"])); named = True
            else:
                unresolved += 1
        elif tk in SAFE_TITLES:
            out.append(SAFE_TITLES[tk])
        elif tk in CONNECTORS:
            out.append(tk)
        else:
            unresolved += 1
    if unresolved or not named:
        return (" ".join(out), False)
    return (" ".join(out), True)


# ─── Layer 2: LLM per character (uses Description as canon) ────────────────────
def _madeye_client():
    from openai import OpenAI
    key = os.environ.get("MADEYE_API_KEY", "")
    if not key:
        sys.exit("MADEYE_API_KEY not set (needed for --llm). Put it in env or .env.")
    base = os.environ.get("MADEYE_BASE_URL", "")
    if not base:
        sys.exit("MADEYE_BASE_URL not set (needed for --llm). Put it in env or .env.")
    return OpenAI(api_key=key, base_url=base, max_retries=2, timeout=60.0)

MADEYE_MODEL = os.environ.get("MADEYE_MODEL", "claude-opus-4-7")
# Madeye rejects requests without metadata.user_email (400 MADEYE_MISSING_USER).
MADEYE_USER_EMAIL = os.environ.get("MADEYE_USER_EMAIL", "")

def llm_character(client, c, items, src, tgt):
    """One call resolving all unresolved mentions for a single character."""
    listing = "\n".join(f'  {i}. "{m["orig"]}"  (current: "{m["loc"]}")'
                        for i, m in enumerate(items))
    system = (
        f"You are a senior localization QA expert. Source {src} -> target {tgt}.\n"
        "You verify how a character's name is rendered in each MENTION, using the\n"
        "character's canonical localized name and the STORY DESCRIPTION (which is\n"
        "the source of truth for relationships, married names, aliases, nicknames,\n"
        "register/affection, and known errors in the script).\n"
        "Rules:\n"
        "- Keep the SAME family/surname decisions already made in the canonical name.\n"
        "- Resolve married names, aliases, diminutives and script errors via the description.\n"
        "- Choose natural French register (e.g. affectionate 'Tata'/'Tonton', "
        "honorifics like 'Maitre' for lawyers) when the description supports it.\n"
        "- confidence: 100 only if certain; lower if the description is silent.\n"
        'Respond ONLY as JSON: {"results":[{"i":0,"suggestion":"...","confidence":95,"reason":"..."}]}'
    )
    user = (
        f'CHARACTER canonical: "{c["orig"]}" -> "{c["loc"]}" '
        f'(first="{c["lf"]}", last="{c["ll"]}")\n\n'
        f'STORY DESCRIPTION:\n{c["desc"][:4000]}\n\n'
        f'MENTIONS to verify:\n{listing}\n'
    )
    request = {
        "model": MADEYE_MODEL,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "max_tokens": 2000,
        "extra_body": {"metadata": {"user_email": MADEYE_USER_EMAIL}},
    }
    if "opus-4-7" not in MADEYE_MODEL:
        request["temperature"] = 0.1
    resp = client.chat.completions.create(**request)
    raw = resp.choices[0].message.content or ""
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return {}
    return {r["i"]: r for r in data.get("results", []) if "i" in r}


# ─── write back ────────────────────────────────────────────────────────────────
def ensure_col(ws, label):
    for c, cell in enumerate(ws[1], start=1):
        if norm(cell.value) == norm(label):
            return c
    col = ws.max_column + 1
    ws.cell(1, col, label)
    return col

from openpyxl.styles import PatternFill, Font
FILLS = {"VERIFIED": "C6EFCE", "MISSING": "FFC7CE", "SOURCE_LEAK": "FFC7CE",
         "MISMATCH": "FCE4D6", "INCONSISTENT": "FFEB9C", "NEEDS_REVIEW": "FFFFFF",
         "LLM_FIX": "FCE4D6", "LLM_OK": "C6EFCE"}

def write_back(mm, results):
    c_sug  = ensure_col(mm, "Suggested Localized Mention")
    c_conf = ensure_col(mm, "Confidence Score")
    c_stat = ensure_col(mm, "Status")
    c_rea  = ensure_col(mm, "Reason")
    for r in results:
        mm.cell(r["row"], c_sug, r["suggestion"])
        mm.cell(r["row"], c_conf, f'{r["confidence"]}%' if r["confidence"] else "")
        mm.cell(r["row"], c_stat, r["status"])
        mm.cell(r["row"], c_rea, r["reason"])
        fill = FILLS.get(r["status"], "FFFFFF")
        for col in (c_sug, c_conf, c_stat):
            mm.cell(r["row"], col).fill = PatternFill("solid", fgColor=fill)
        if r["confidence"] and r["confidence"] < 70:
            mm.cell(r["row"], c_conf).font = Font(bold=True)


# ─── main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--llm", action="store_true", help="run the LLM layer (needs MADEYE_API_KEY)")
    ap.add_argument("--src", default="de/en")
    ap.add_argument("--tgt", default="fr")
    args = ap.parse_args()

    wb, mm, chars, mentions = load(args.input)
    print(f"Loaded {len(chars)} characters, {len(mentions)} mentions.", flush=True)

    # Layer 1
    results = []
    cross = defaultdict(set)
    for m in mentions:
        st, sug, conf, rea = deterministic(m["cid"], m["orig"], m["loc"], chars)
        results.append({"row": m["row"], "cid": m["cid"], "orig": m["orig"],
                        "loc": m["loc"], "status": st, "suggestion": sug,
                        "confidence": conf, "reason": rea})
        if m["loc"]:
            cross[m["cid"]].add(norm(m["loc"]))

    counts = defaultdict(int)
    for r in results:
        counts[r["status"]] += 1
    print("\nLayer 1 (deterministic):", flush=True)
    for k, v in sorted(counts.items()):
        print(f"  {k:14s}: {v}", flush=True)

    # Layer 2 — only for rows Layer 1 couldn't safely resolve
    if args.llm:
        if not MADEYE_USER_EMAIL:
            sys.exit("MADEYE_USER_EMAIL not set — Madeye rejects requests without "
                     "metadata.user_email (400 MADEYE_MISSING_USER).")
        client = _madeye_client()
        todo = defaultdict(list)
        for r in results:
            if r["status"] in ("NEEDS_REVIEW", "MISSING", "MISMATCH"):
                todo[r["cid"]].append(r)
        print(f"\nLayer 2 (LLM): {sum(len(v) for v in todo.values())} mentions "
              f"across {len(todo)} characters...", flush=True)
        done = 0
        for cid, items in todo.items():
            c = chars.get(cid)
            if not c or not c.get("desc"):
                continue
            try:
                res = llm_character(client, c, items, args.src, args.tgt)
            except Exception as e:
                print(f"  ! {cid}: {e}", flush=True)
                continue
            for i, r in enumerate(items):
                rr = res.get(i)
                if not rr:
                    continue
                r["suggestion"] = rr.get("suggestion", r["suggestion"])
                r["confidence"] = int(rr.get("confidence", 0) or 0)
                r["reason"] = rr.get("reason", "")[:200]
                same = norm(r["suggestion"]) == norm(r["loc"])
                r["status"] = "LLM_OK" if same else "LLM_FIX"
            done += 1
            if done % 20 == 0:
                print(f"  ...{done}/{len(todo)} characters", flush=True)

    write_back(mm, results)
    wb.save(args.output)

    review = sum(1 for r in results
                 if not (r["status"] in ("VERIFIED", "LLM_OK") and r["confidence"] >= 100
                         or r["status"] == "LLM_OK"))
    total = len(results)
    print(f"\nSaved -> {args.output}", flush=True)
    print(f"Human needs to review ~{review}/{total} rows "
          f"({100*review/total:.0f}%); the rest are auto-verified.", flush=True)


if __name__ == "__main__":
    main()
