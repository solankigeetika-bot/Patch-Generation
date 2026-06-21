#!/usr/bin/env python3
"""
LS Verifier — backend + web app.

Serves the static frontend at / and all API endpoints:
  POST /verify                — upload .xlsx + options → run engine
  POST /correction            — save a human correction to the shared dictionary
  POST /finalize/{job_id}     — apply accepted decisions → return corrected .xlsx
  GET  /download/{job_id}     — download the annotated .xlsx (engine output)
  POST /update-canon-session  — bookmarklet endpoint: store canon __session cookie
  GET  /health                — service health
  GET  /madeye-ping           — end-to-end Madeye connectivity check
  POST /chat                  — story Q&A (canon + sheet context)
  POST /canon                 — raw canon data

Environment:
  MADEYE_API_KEY      required
  MADEYE_BASE_URL     required
  MADEYE_MODEL        optional  default claude-opus-4-7
  MADEYE_USER_EMAIL   required
  PROXY_SECRET        required  (bookmarklet + Apps Script auth)
  CANON_SESSION       optional  canon.pocketfm.ai __session cookie
  CORRECTIONS_DB      optional  path to corrections.db (default ./corrections.db)
  PORT                optional  default 8000
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Ensure sibling modules (verify_ls, corrections_store) import regardless of
# whether uvicorn is launched as `main:app` (from backend/) or `backend.main:app`
# (from the repo root) or inside a container.
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from typing import Any, Optional
from uuid import uuid4

import requests
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pydantic import BaseModel, Field

try:
    from canon_client import CanonGraph
except Exception:  # pragma: no cover - backend should still boot without canon.
    CanonGraph = None

load_dotenv()

# ─── config ───────────────────────────────────────────────────────────────────
MADEYE_API_KEY    = os.environ.get("MADEYE_API_KEY", "")
MADEYE_BASE_URL   = os.environ.get("MADEYE_BASE_URL", "")
MADEYE_MODEL      = os.environ.get("MADEYE_MODEL", "claude-opus-4-7")
MADEYE_USER_EMAIL = os.environ.get("MADEYE_USER_EMAIL", "")
PROXY_SECRET      = os.environ.get("PROXY_SECRET", "")
CANON_HOST        = os.environ.get("CANON_HOST", "https://canon.pocketfm.ai").rstrip("/")
LLM_VERIFY_LIMIT  = int(os.environ.get("LLM_VERIFY_LIMIT", "80"))

# CANON_SESSION: env var, then persisted file (bookmarklet writes this)
_CANON_SESSION_FILE = Path("canon_session.txt")
CANON_SESSION = os.environ.get("CANON_SESSION", "")
if not CANON_SESSION and _CANON_SESSION_FILE.exists():
    CANON_SESSION = _CANON_SESSION_FILE.read_text().strip()


# ─── app ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="LS Verifier", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── auth ─────────────────────────────────────────────────────────────────────
def _check_auth(secret: str):
    if PROXY_SECRET and secret != PROXY_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ─── Madeye client ────────────────────────────────────────────────────────────
def _madeye_client() -> OpenAI:
    if not MADEYE_API_KEY:
        raise HTTPException(503, "MADEYE_API_KEY not configured.")
    if not MADEYE_BASE_URL:
        raise HTTPException(503, "MADEYE_BASE_URL not configured.")
    return OpenAI(api_key=MADEYE_API_KEY, base_url=MADEYE_BASE_URL, max_retries=1, timeout=60.0)


def _ask_madeye(system: str, user: str, max_tokens: int = 1024, user_email: str = "") -> str:
    email = user_email or MADEYE_USER_EMAIL
    if not email:
        raise HTTPException(503, "MADEYE_USER_EMAIL not configured.")
    client = _madeye_client()
    req_body: dict = {
        "model":      MADEYE_MODEL,
        "messages":   [{"role": "system", "content": system},
                       {"role": "user",   "content": user}],
        "max_tokens": max_tokens,
        "extra_body": {"metadata": {"user_email": email}},
    }
    if "opus-4-7" not in MADEYE_MODEL:
        req_body["temperature"] = 0.2
    resp = client.chat.completions.create(**req_body)
    return resp.choices[0].message.content or ""


# ─── canon fetcher ────────────────────────────────────────────────────────────
_canon_cache: dict[str, dict] = {}
_canon_graph_cache: dict[str, Any] = {}


def _fetch_canon(slug: str) -> dict:
    if slug in _canon_cache:
        return _canon_cache[slug]
    if not CANON_SESSION:
        return {}
    url = f"{CANON_HOST}/{slug}/"
    try:
        r = requests.get(url, headers={"Cookie": f"__session={CANON_SESSION}"}, timeout=20)
        r.raise_for_status()
    except Exception as e:
        return {"error": str(e)}
    wiki, show = _extract_from_html(r.text)
    result = {"wiki": wiki, "show": show, "slug": slug}
    _canon_cache[slug] = result
    return result


def _canon_graph(slug: str):
    """Return the structured Story Canon graph for a show slug, if configured."""
    if not slug or not CANON_SESSION or CanonGraph is None:
        return None
    key = f"{CANON_HOST}|{slug}"
    if key in _canon_graph_cache:
        return _canon_graph_cache[key]
    try:
        graph = CanonGraph.from_web(slug, session_cookie=CANON_SESSION, host=CANON_HOST)
    except Exception:
        return None
    _canon_graph_cache[key] = graph
    return graph


def _extract_js_object(js: str, varname: str) -> Optional[dict]:
    m = re.search(r"(?:const|let|var)\s+" + re.escape(varname) + r"\s*=\s*(\{)", js)
    if not m:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(js, m.start(1))
        return obj
    except json.JSONDecodeError:
        return None


def _extract_from_html(html: str):
    scripts = re.findall(r"<script[^>]*>(.*?)</script>", html, re.DOTALL)
    if not scripts:
        return {}, None
    big = max(scripts, key=len)
    return _extract_js_object(big, "WIKI_DATA") or {}, _extract_js_object(big, "SHOW_DATA")


def _canon_context(slug: str, focus_names: Optional[list[str]] = None) -> str:
    if not slug:
        return ""
    graph = _canon_graph(slug)
    if graph:
        return _canon_graph_context(graph, focus_names or [])

    data = _fetch_canon(slug)
    wiki = data.get("wiki", {})
    if not wiki:
        return ""
    lines = [f"Show: {wiki.get('show_title', slug)}"]
    chars = wiki.get("characters", {})
    char_list: list = chars if isinstance(chars, list) else []
    if isinstance(chars, dict):
        for grp in chars.values():
            if isinstance(grp, list):
                char_list.extend(grp)
    for c in char_list[:40]:
        line = f"  {c.get('name','')}"
        if c.get("aliases"):
            line += f" (aka {', '.join(c['aliases'][:3])})"
        if c.get("role"):
            line += f" [{c['role']}]"
        if c.get("family"):
            line += f" — {c['family']} family"
        if c.get("description"):
            line += f": {c['description'][:120]}"
        lines.append(line)
    dyn = wiki.get("dynasty_hierarchy", "")
    if dyn:
        lines.append(f"Families: {dyn[:300]}")
    return "\n".join(lines)


def _canon_graph_context(graph, focus_names: list[str]) -> str:
    """Compact graph dump for the LLM: focus cards first, then family atlas."""
    lines = [
        f"Show: {graph.show_title or '(unknown)'}",
        f"Source language: {graph.source_lang}",
    ]
    if graph.families:
        fam_bits = []
        for family, members in sorted(graph.families.items())[:30]:
            fam_bits.append(f"{family}: {', '.join(members[:8])}")
        lines.append("Families: " + " | ".join(fam_bits))

    seen = set()
    focus_cards = []
    for name in focus_names:
        card = graph.card(name)
        if not card or card["name"] in seen:
            continue
        seen.add(card["name"])
        focus_cards.append(card)

    if focus_cards:
        lines.append("Relevant characters:")
        for card in focus_cards[:40]:
            lines.append(_format_canon_card(card))

    remaining = [c for c in graph.characters.values() if c.name not in seen]
    if remaining:
        lines.append("Other characters:")
        for c in remaining[:50]:
            lines.append(_format_canon_card({
                "name": c.name,
                "aliases": c.aliases,
                "role": c.role,
                "status": c.status,
                "family": c.family,
                "relationships": c.relationships,
                "episodes": [c.ep_start, c.ep_end],
                "description": c.description,
            }))
    return "\n".join(lines)


def _format_canon_card(card: dict) -> str:
    line = f"  {card.get('name', '')}"
    aliases = card.get("aliases") or []
    if aliases:
        line += f" (aka {', '.join(aliases[:4])})"
    if card.get("role"):
        line += f" [{card['role']}]"
    if card.get("family"):
        line += f" - {card['family']} family"
    rels = card.get("relationships") or []
    if rels:
        bits = []
        for rel in rels[:5]:
            if isinstance(rel, dict):
                bits.append(f"{rel.get('type') or 'related'}:{rel.get('name')}")
        if bits:
            line += f"; relationships: {', '.join(bits)}"
    desc = (card.get("description") or "")[:180]
    if desc:
        line += f": {desc}"
    return line


# ─── job store (in-memory, 2h TTL) ────────────────────────────────────────────
_jobs: dict[str, dict] = {}


def _cleanup_jobs():
    cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
    expired = [jid for jid, j in _jobs.items() if j["created_at"] < cutoff]
    for jid in expired:
        for key in ("output_path",):
            try:
                Path(_jobs[jid][key]).unlink(missing_ok=True)
            except Exception:
                pass
        del _jobs[jid]


# ─── pydantic models ──────────────────────────────────────────────────────────
class CorrectionRequest(BaseModel):
    job_id: str
    cid: str
    original_mention: str
    value: str
    user_email: str = ""


class FinalizeDecision(BaseModel):
    row: int
    value: str


class FinalizeRequest(BaseModel):
    decisions: list[FinalizeDecision]


class ChatRequest(BaseModel):
    question: str
    sheet_context: str = ""
    source_lang: str = "en"
    target_lang: str = "fr"
    show_slug: str = ""
    user_email: str = ""


class LLMVerifyRequest(BaseModel):
    findings: list[dict]
    sheet_context: str
    source_lang: str = "en"
    target_lang: str = "fr"
    show_slug: str = ""
    user_email: str = ""


class MentionVerifyRequest(BaseModel):
    ld: list[dict[str, Any]] = Field(default_factory=list)
    mm: list[dict[str, Any]] = Field(default_factory=list)
    source_lang: str = "en"
    target_lang: str = "fr"
    show_slug: str = ""
    user_email: str = ""
    run_llm: bool = True


class CanonRequest(BaseModel):
    slug: str


class CanonSessionUpdate(BaseModel):
    secret: str
    canon: str


# ─── mention verification engine for Apps Script ──────────────────────────────
def _norm_text(s: Any) -> str:
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def _cell(row: dict, aliases: list[str]) -> str:
    keys = list((row or {}).keys())
    for alias in aliases:
        wanted = alias.lower()
        for key in keys:
            if key.lower() == wanted:
                return str(row.get(key) or "").strip()
    return ""


def _escape_re(s: str) -> str:
    return re.escape(s or "")


def _last_token(s: str) -> str:
    parts = re.findall(r"[\wÀ-ÿ'-]+", s or "")
    return parts[-1] if parts else ""


def _replace_last_token(text: str, old: str, new: str) -> str:
    if not text or not old or not new:
        return text
    return re.sub(r"(?i)\b" + _escape_re(old) + r"\b(?!.*\b" + _escape_re(old) + r"\b)",
                  new, text, count=1)


def _dictionary_pairs(ld_rows: list[dict]) -> list[tuple[str, str]]:
    pairs = []
    for row in ld_rows:
        orig = _cell(row, ["Original Name", "original name", "original_name"])
        loc = _cell(row, [
            "Localized Name", "Localised Name", "localized name",
            "localised name", "localized_name",
        ])
        if orig and loc and _norm_text(orig) != _norm_text(loc):
            pairs.append((orig, loc))
    pairs.sort(key=lambda p: len(p[0]), reverse=True)
    return pairs


def _expected_localized(orig_mention: str, pairs: list[tuple[str, str]]) -> str:
    out = orig_mention or ""
    for orig, loc in pairs:
        out = re.sub(r"\b" + _escape_re(orig) + r"\b", loc, out, flags=re.I)
    return out


def _ld_indexes(ld_rows: list[dict], graph) -> dict:
    id_to_orig: dict[str, str] = {}
    orig_names: list[str] = []
    family_surnames: dict[str, Counter] = defaultdict(Counter)
    row_family: dict[str, str] = {}

    for row in ld_rows:
        rid = _cell(row, ["ID", "id"])
        orig = _cell(row, ["Original Name", "original name", "original_name"])
        loc = _cell(row, [
            "Localized Name", "Localised Name", "localized name",
            "localised name", "localized_name",
        ])
        if rid:
            id_to_orig[_norm_text(rid)] = orig
        if orig:
            orig_names.append(orig)

        if not graph or not orig:
            continue
        family = graph.family_of(orig) or ""
        if not family:
            continue
        loc_surname = _last_token(loc)
        if loc_surname and len(loc_surname) > 1:
            family_surnames[family][loc_surname] += 1
        row_family[_norm_text(orig)] = family
        if rid:
            row_family[_norm_text(rid)] = family

    expected_family_surname = {
        fam: counts.most_common(1)[0][0]
        for fam, counts in family_surnames.items()
        if counts
    }
    return {
        "id_to_orig": id_to_orig,
        "orig_names": sorted(orig_names, key=len, reverse=True),
        "row_family": row_family,
        "expected_family_surname": expected_family_surname,
        "known_family_surnames": set(expected_family_surname.values()),
    }


def _source_identity(row: dict, idx: dict, graph) -> tuple[str, str]:
    rid = _cell(row, ["ID", "id"])
    orig_mention = _cell(row, [
        "Original Mention", "original mention", "original_mention",
        "Original Name", "original name",
    ])
    if rid and _norm_text(rid) in idx["id_to_orig"]:
        orig = idx["id_to_orig"][_norm_text(rid)]
        family = idx["row_family"].get(_norm_text(rid), "")
        return orig, family
    if graph:
        resolved = graph.resolve_alias(orig_mention)
        if resolved:
            return resolved, graph.family_of(resolved) or ""
    low = _norm_text(orig_mention)
    for orig in idx["orig_names"]:
        if _norm_text(orig) and _norm_text(orig) in low:
            return orig, idx["row_family"].get(_norm_text(orig), "")
    return orig_mention, ""


def _base_mention_findings(ld_rows: list[dict], mm_rows: list[dict], graph) -> list[dict]:
    pairs = _dictionary_pairs(ld_rows)
    idx = _ld_indexes(ld_rows, graph)
    findings: list[dict] = []
    seen: dict[str, str] = {}

    for i, row in enumerate(mm_rows):
        row_num = i + 2
        orig = _cell(row, ["Original Mention", "original mention", "original_mention"])
        loc = _cell(row, [
            "Localized Mention", "Localised Mention", "localized mention",
            "localised mention", "localized_mention",
        ])
        if not orig:
            continue

        expected = _expected_localized(orig, pairs)
        if not loc:
            findings.append({
                "tab": "Mention Mappings", "row": row_num,
                "kind": "MISSING_LOCALISATION",
                "detail": f"'{orig}' has no localized mention.",
                "suggestion": expected, "confidence": 0, "source": "deterministic",
            })
            continue

        if _norm_text(orig) == _norm_text(loc) and _norm_text(expected) != _norm_text(orig):
            findings.append({
                "tab": "Mention Mappings", "row": row_num,
                "kind": "SOURCE_NAME_NOT_LOCALIZED",
                "detail": f"'{loc}' is unchanged from source.",
                "suggestion": expected, "confidence": 0, "source": "deterministic",
            })
        elif _norm_text(expected) != _norm_text(orig) and _norm_text(loc) != _norm_text(expected):
            findings.append({
                "tab": "Mention Mappings", "row": row_num,
                "kind": "MENTION_MASTER_MISMATCH",
                "detail": f"'{loc}' does not match the Localization Details dictionary.",
                "suggestion": expected, "confidence": 70, "source": "deterministic",
            })

        key = _norm_text(orig)
        if key not in seen:
            seen[key] = loc
        elif _norm_text(seen[key]) != _norm_text(loc):
            findings.append({
                "tab": "Mention Mappings", "row": row_num,
                "kind": "CROSS_MENTION_INCONSISTENCY",
                "detail": f"'{orig}' is localized as '{loc}' here but '{seen[key]}' elsewhere.",
                "suggestion": seen[key], "confidence": 60, "source": "deterministic",
            })

        _add_canon_family_finding(findings, row_num, row, loc, idx, graph)

    return _dedupe_findings(findings)


def _add_canon_family_finding(findings: list[dict], row_num: int, row: dict,
                              loc: str, idx: dict, graph) -> None:
    if not graph or not loc:
        return
    source_name, family = _source_identity(row, idx, graph)
    expected_surname = idx["expected_family_surname"].get(family or "")
    loc_surname = _last_token(loc)
    if not expected_surname or not loc_surname:
        return
    if _norm_text(loc_surname) == _norm_text(expected_surname):
        return
    known = {_norm_text(s) for s in idx["known_family_surnames"]}
    if _norm_text(loc_surname) not in known:
        return
    findings.append({
        "tab": "Mention Mappings",
        "row": row_num,
        "kind": "FAMILY_SURNAME_MISMATCH",
        "detail": (
            f"Story Canon maps '{source_name}' to the {family} family, whose "
            f"localized surname is '{expected_surname}', but this row uses '{loc_surname}'."
        ),
        "suggestion": _replace_last_token(loc, loc_surname, expected_surname),
        "confidence": 75,
        "source": "story_canon",
    })


def _dedupe_findings(findings: list[dict]) -> list[dict]:
    out = []
    seen = set()
    for f in findings:
        key = (str(f.get("row", "")), str(f.get("kind", "")),
               _norm_text(f.get("suggestion", "")))
        if key in seen:
            continue
        seen.add(key)
        out.append(f)
    return out


def _candidate_rows_for_llm(mm_rows: list[dict], findings: list[dict], limit: int) -> list[dict]:
    finding_rows = {f.get("row") for f in findings if isinstance(f.get("row"), int)}
    candidates = []
    used = set()

    def add(i: int, row: dict, reason: str):
        row_num = i + 2
        if row_num in used or len(candidates) >= limit:
            return
        used.add(row_num)
        candidates.append({
            "row": row_num,
            "orig": _cell(row, ["Original Mention", "original mention", "original_mention"]),
            "loc": _cell(row, [
                "Localized Mention", "Localised Mention", "localized mention",
                "localised mention", "localized_mention",
            ]),
            "reason": reason,
        })

    for i, row in enumerate(mm_rows):
        if i + 2 in finding_rows:
            add(i, row, "deterministic finding")
    context_markers = re.compile(
        r"\b(mr|mrs|miss|herr|frau|dr|doctor|professor|captain|oma|opa|schatz|"
        r"liebling|mother|father|sister|brother|uncle|aunt|grandfather|grandmother|"
        r"university|institute|company|hotel|city|family)\b",
        re.I,
    )
    for i, row in enumerate(mm_rows):
        orig = _cell(row, ["Original Mention", "original mention", "original_mention"])
        loc = _cell(row, ["Localized Mention", "localized mention", "localised mention"])
        if context_markers.search(f"{orig} {loc}"):
            add(i, row, "context marker")
    for i, row in enumerate(mm_rows):
        add(i, row, "coverage sample")
    return candidates


def _llm_mention_findings(req: MentionVerifyRequest, base_findings: list[dict],
                          canon_ctx: str) -> tuple[list[dict], str]:
    if not req.run_llm:
        return [], ""
    if not (MADEYE_API_KEY and MADEYE_BASE_URL and (req.user_email or MADEYE_USER_EMAIL)):
        return [], "LLM skipped: Madeye key/base URL/user_email is not configured."

    candidates = _candidate_rows_for_llm(req.mm, base_findings, LLM_VERIFY_LIMIT)
    if not candidates:
        return [], ""

    dictionary = "\n".join(f"- {orig} -> {loc}" for orig, loc in _dictionary_pairs(req.ld)[:160])
    deterministic = "\n".join(
        f"- row {f.get('row')}: [{f.get('kind')}] {f.get('detail')} "
        f"suggestion={f.get('suggestion') or ''}"
        for f in base_findings[:160]
    )
    rows = "\n".join(
        f'- row {r["row"]}: original="{r["orig"]}" localized="{r["loc"]}" '
        f'candidate_reason="{r["reason"]}"'
        for r in candidates
    )

    system = f"""You are a senior localization verifier for PocketFM audio.
Source language: {req.source_lang}. Target language: {req.target_lang}.

Use Story Canon as the source of truth for character identity, family trees,
aliases, relationships, titles, institutions, and source-world context.

Check:
A. Internal consistency.
B. Cross-entity integrity.
C. Source fidelity.
D. Target appropriateness.

Do not invent rows. Return issues only when there is a concrete correction.
Respond STRICTLY as JSON:
{{"findings":[{{"row":31,"kind":"FAMILY_SURNAME_MISMATCH","detail":"one sentence","suggestion":"correct localized mention","confidence":88}}]}}

--- STORY CANON ---
{canon_ctx or "(not available)"}

--- LOCALIZATION DETAILS DICTIONARY ---
{dictionary or "(not available)"}

--- DETERMINISTIC FINDINGS ---
{deterministic or "(none)"}
"""
    try:
        raw = _ask_madeye(system, f"Review these Mention Mapping rows:\n{rows}",
                          max_tokens=4000, user_email=req.user_email)
    except Exception as e:
        return [], f"LLM skipped: {type(e).__name__}: {str(e)[:180]}"

    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return [], "LLM returned non-JSON output."
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        return [], f"LLM JSON parse failed: {str(e)[:120]}"

    out = []
    for item in data.get("findings", []):
        try:
            row_num = int(item.get("row"))
        except (TypeError, ValueError):
            continue
        detail = str(item.get("detail") or "").strip()
        suggestion = str(item.get("suggestion") or "").strip()
        if not detail and not suggestion:
            continue
        try:
            confidence = max(0, min(100, int(item.get("confidence", 60))))
        except (TypeError, ValueError):
            confidence = 60
        out.append({
            "tab": "Mention Mappings",
            "row": row_num,
            "kind": str(item.get("kind") or "CHARACTER_CONTEXT_MISMATCH").strip(),
            "detail": detail or "Needs review.",
            "suggestion": suggestion,
            "confidence": confidence,
            "source": "llm_story_canon",
        })
    return _dedupe_findings(out), ""


# ─── endpoints ────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status": "ok",
        "madeye": bool(MADEYE_API_KEY and MADEYE_BASE_URL),
        "user_email": bool(MADEYE_USER_EMAIL),
        "canon_session": bool(CANON_SESSION),
        "canon_host": CANON_HOST,
        "llm_verify_limit": LLM_VERIFY_LIMIT,
    }


@app.get("/madeye-ping")
def madeye_ping(user_email: str = ""):
    missing = [n for n, v in (
        ("MADEYE_API_KEY", MADEYE_API_KEY),
        ("MADEYE_BASE_URL", MADEYE_BASE_URL),
        ("MADEYE_USER_EMAIL", user_email or MADEYE_USER_EMAIL),
    ) if not v]
    if missing:
        return {"ok": False, "error": f"not configured: {', '.join(missing)}"}
    try:
        reply = _ask_madeye("Reply with the single word: pong.", "ping",
                            max_tokens=8, user_email=user_email)
        return {"ok": True, "model": MADEYE_MODEL, "reply": reply.strip()}
    except HTTPException as e:
        return {"ok": False, "error": e.detail}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/update-canon-session")
def update_canon_session(req: CanonSessionUpdate):
    """Bookmarklet endpoint: push canon __session cookie to the backend."""
    if PROXY_SECRET and req.secret != PROXY_SECRET:
        raise HTTPException(401, "Invalid secret")
    global CANON_SESSION
    CANON_SESSION = req.canon.strip()
    try:
        _CANON_SESSION_FILE.write_text(CANON_SESSION)
    except Exception:
        pass
    _canon_cache.clear()  # invalidate stale canon cache
    _canon_graph_cache.clear()
    return {"status": "ok", "message": "Canon session updated ✓"}


@app.post("/verify")
async def verify_upload(
    file: UploadFile = File(...),
    use_llm: bool = Form(False),
    show_slug: str = Form(""),
    user_email: str = Form(""),
    src: str = Form("de/en"),
    tgt: str = Form("fr"),
):
    _cleanup_jobs()
    import corrections_store
    from verify_ls import run_verification

    # Save upload to temp file
    suffix = ".xlsx"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
        f.write(await file.read())
        input_path = f.name

    output_path = input_path.replace(suffix, "_annotated" + suffix)

    canon_ctx = _canon_context(show_slug) if show_slug else ""
    corrections_lookup = corrections_store.get_all()

    try:
        result = run_verification(
            input_path, output_path,
            use_llm=use_llm,
            src=src,
            tgt=tgt,
            corrections_lookup=corrections_lookup,
            canon_ctx=canon_ctx,
            user_email=user_email or MADEYE_USER_EMAIL,
        )
    except RuntimeError as e:
        Path(input_path).unlink(missing_ok=True)
        raise HTTPException(503, str(e))
    finally:
        Path(input_path).unlink(missing_ok=True)

    job_id = str(uuid4())
    _jobs[job_id] = {
        "output_path":  output_path,
        "results":      result["results"],
        "summary":      result["summary"],
        "name_tokens":  result["name_tokens"],
        "created_at":   datetime.now(timezone.utc),
    }

    # results list: stringify cid for JSON safety and expose the
    # frontend's vocabulary (original / current) alongside the engine's.
    safe_results = [
        {
            **r,
            "cid":      str(r["cid"]) if r["cid"] is not None else None,
            "original": r.get("orig", ""),
            "current":  r.get("loc", ""),
        }
        for r in result["results"]
    ]

    return {
        "job_id":       job_id,
        "summary":      result["summary"],
        "results":      safe_results,
        "canon_loaded": bool(canon_ctx),
    }


@app.post("/correction")
def add_correction(req: CorrectionRequest):
    """Save a human correction to the shared learning dictionary."""
    import corrections_store
    from verify_ls import norm
    job = _jobs.get(req.job_id)
    name_tokens: set = job["name_tokens"] if job else set()
    status_tag = corrections_store.add(
        req.cid,
        norm(req.original_mention),
        req.original_mention,
        req.value,
        name_tokens,
    )
    return {"status_tag": status_tag}


@app.post("/finalize/{job_id}")
async def finalize(job_id: str, req: FinalizeRequest):
    """Apply accepted/edited decisions to Localized Mention column, return corrected xlsx."""
    import openpyxl
    from verify_ls import apply_decisions, header_index, pick

    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found or expired (2h TTL).")

    wb = openpyxl.load_workbook(job["output_path"])
    mm = wb["Mention Mappings"]
    apply_decisions(mm, [{"row": d.row, "value": d.value} for d in req.decisions])

    final_path = job["output_path"].replace("_annotated", "_final")
    wb.save(final_path)
    return FileResponse(
        final_path,
        filename="verified_final.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.get("/download/{job_id}")
def download_annotated(job_id: str):
    """Download the annotated workbook (suggestions columns, original values unchanged)."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found or expired.")
    return FileResponse(
        job["output_path"],
        filename="verified_annotated.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.post("/chat")
def chat(req: ChatRequest, x_proxy_secret: str = Header(default="")):
    canon_ctx = _canon_context(req.show_slug)
    system = f"""You are a localization expert for PocketFM audiobooks.
Source: {req.source_lang} → {req.target_lang}.

Use the STORY CANON as the authoritative source for family trees, relationships,
and aliases. The localization sheet provides additional context.

--- STORY CANON ---
{canon_ctx or '(not connected — paste a show slug to enable)'}

--- LOCALIZATION SHEET ---
{req.sheet_context or '(not provided)'}
"""
    try:
        answer = _ask_madeye(system, req.question, max_tokens=512,
                             user_email=req.user_email)
        return {"answer": answer}
    except Exception as e:
        raise HTTPException(502, str(e))


@app.post("/verify-llm")
def verify_llm(req: LLMVerifyRequest, x_proxy_secret: str = Header(default="")):
    _check_auth(x_proxy_secret)
    canon_ctx = _canon_context(req.show_slug)
    findings_text = "\n".join(
        f"- [{f.get('kind','?')}] Row {f.get('row','?')}: {f.get('detail','')}"
        for f in req.findings[:50]
    )
    system = f"""You are a localization QA expert for PocketFM.
Source: {req.source_lang} → {req.target_lang}. Canon is authoritative.

--- CANON ---
{canon_ctx or '(not available)'}
--- SHEET ---
{req.sheet_context}
--- DETERMINISTIC FINDINGS ---
{findings_text}

For each finding: confirm real/false-positive, suggest correction.
Respond as JSON: {{"findings": [{{"row": ..., "kind": ..., "confirmed": true, "suggestion": "..."}}]}}
"""
    try:
        raw = _ask_madeye(system, "Review the findings above.", max_tokens=2048,
                          user_email=req.user_email)
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        return json.loads(m.group(0)) if m else {"raw": raw}
    except Exception as e:
        raise HTTPException(502, str(e))


@app.post("/verify-mentions")
def verify_mentions(req: MentionVerifyRequest, x_proxy_secret: str = Header(default="")):
    """Apps Script sheet-agent path.

    Mention Mappings are primary. Localization Details are optional dictionary
    context. Story Canon is used when show_slug + CANON_SESSION are configured;
    Madeye adds the context-sensitive pass.
    """
    _check_auth(x_proxy_secret)

    graph = _canon_graph(req.show_slug)
    focus = []
    for row in req.ld[:120]:
        orig = _cell(row, ["Original Name", "original name", "original_name"])
        if orig:
            focus.append(orig)
    for row in req.mm[:120]:
        orig = _cell(row, ["Original Mention", "original mention", "original_mention"])
        if orig:
            focus.append(orig)
    canon_ctx = _canon_context(req.show_slug, focus)

    base_findings = _base_mention_findings(req.ld, req.mm, graph)
    llm_findings, warning = _llm_mention_findings(req, base_findings, canon_ctx)
    findings = _dedupe_findings(base_findings + llm_findings)
    llm_ran = bool(
        req.run_llm and req.mm and MADEYE_API_KEY and MADEYE_BASE_URL
        and (req.user_email or MADEYE_USER_EMAIL) and not warning
    )

    return {
        "findings": findings,
        "rowCount": len(req.mm),
        "mmCount": len(req.mm),
        "sourceTab": "Mention Mappings",
        "canon": {
            "configured": bool(CANON_SESSION),
            "available": bool(canon_ctx),
            "slug": req.show_slug,
            "characters": len(graph.characters) if graph else 0,
            "families": len(graph.families) if graph else 0,
        },
        "llm": {"ran": llm_ran, "limit": LLM_VERIFY_LIMIT},
        "warning": warning,
    }


@app.post("/canon")
def get_canon(req: CanonRequest, x_proxy_secret: str = Header(default="")):
    _check_auth(x_proxy_secret)
    graph = _canon_graph(req.slug)
    if graph:
        return {
            "show": graph.show_title or req.slug,
            "lang": graph.source_lang,
            "families": graph.families,
            "characters": [
                {
                    "name": c.name,
                    "aliases": c.aliases,
                    "role": c.role,
                    "family": c.family,
                    "relationships": c.relationships,
                }
                for c in graph.characters.values()
            ],
        }
    data = _fetch_canon(req.slug)
    if "error" in data:
        raise HTTPException(502, data["error"])
    wiki = data.get("wiki", {})
    chars = wiki.get("characters", {})
    char_list: list = chars if isinstance(chars, list) else []
    if isinstance(chars, dict):
        for grp in chars.values():
            if isinstance(grp, list):
                char_list.extend(grp)
    return {
        "show":       wiki.get("show_title", req.slug),
        "dynasty":    wiki.get("dynasty_hierarchy", ""),
        "characters": [{"name": c.get("name",""), "aliases": c.get("aliases",[]),
                        "role": c.get("role",""), "family": c.get("family","")}
                       for c in char_list],
    }


# ─── static frontend (must be last — catches everything else) ─────────────────
_HERE = Path(__file__).resolve().parent
for _cand in (_HERE.parent / "frontend", _HERE / "frontend"):
    if _cand.exists():
        app.mount("/", StaticFiles(directory=str(_cand), html=True), name="frontend")
        break


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
