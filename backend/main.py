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
  MADEYE_MODEL        optional  default claude-opus-4-8
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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

import requests
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pydantic import BaseModel

load_dotenv()

# ─── config ───────────────────────────────────────────────────────────────────
MADEYE_API_KEY    = os.environ.get("MADEYE_API_KEY", "")
MADEYE_BASE_URL   = os.environ.get("MADEYE_BASE_URL", "")
MADEYE_MODEL      = os.environ.get("MADEYE_MODEL", "claude-opus-4-8")
MADEYE_USER_EMAIL = os.environ.get("MADEYE_USER_EMAIL", "")
PROXY_SECRET      = os.environ.get("PROXY_SECRET", "")
CANON_HOST        = "https://canon.pocketfm.ai"

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
    return OpenAI(api_key=MADEYE_API_KEY, base_url=MADEYE_BASE_URL, max_retries=1)


def _ask_madeye(system: str, user: str, max_tokens: int = 1024, user_email: str = "") -> str:
    email = user_email or MADEYE_USER_EMAIL
    if not email:
        raise HTTPException(503, "MADEYE_USER_EMAIL not configured.")
    client = _madeye_client()
    resp = client.chat.completions.create(
        model=MADEYE_MODEL,
        messages=[{"role": "system", "content": system},
                  {"role": "user",   "content": user}],
        max_tokens=max_tokens,
        temperature=0.2,
        extra_body={"metadata": {"user_email": email}},
    )
    return resp.choices[0].message.content or ""


# ─── canon fetcher ────────────────────────────────────────────────────────────
_canon_cache: dict[str, dict] = {}


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


def _canon_context(slug: str) -> str:
    if not slug:
        return ""
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


class CanonRequest(BaseModel):
    slug: str


class CanonSessionUpdate(BaseModel):
    secret: str
    canon: str


# ─── endpoints ────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status": "ok",
        "madeye": bool(MADEYE_API_KEY and MADEYE_BASE_URL),
        "user_email": bool(MADEYE_USER_EMAIL),
        "canon_session": bool(CANON_SESSION),
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

    # results list: make cid a string for JSON safety
    safe_results = [
        {**r, "cid": str(r["cid"]) if r["cid"] is not None else None}
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


@app.post("/canon")
def get_canon(req: CanonRequest, x_proxy_secret: str = Header(default="")):
    _check_auth(x_proxy_secret)
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
_FRONTEND = Path(__file__).parent.parent / "frontend"
if _FRONTEND.exists():
    app.mount("/", StaticFiles(directory=str(_FRONTEND), html=True), name="frontend")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
