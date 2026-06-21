#!/usr/bin/env python3
"""
LS Verifier — Madeye proxy backend.

Holds ONE Madeye credential and serves every localizer's sheet, so nobody
pastes tokens. Madeye is PocketFM's OpenAI-compatible LLM gateway (routes to
Claude/Gemini/etc., enforces per-user budget via metadata.user_email).
Reaches:
  - Madeye at MADEYE_BASE_URL          (LLM, OpenAI-compatible)
  - canon.pocketfm.ai                  (show canon)

Apps Script calls this proxy; the proxy forwards to Madeye.

Environment variables (put in .env or export):
  MADEYE_API_KEY      required   Madeye API key (sent as Bearer token)
  MADEYE_BASE_URL     required   Madeye base URL from the AWS secret
  MADEYE_MODEL        optional   model alias (default: claude-opus-4-7)
  MADEYE_USER_EMAIL   required   @pocketfm.com email (Madeye needs metadata.user_email)
  PROXY_SECRET        required   shared secret Apps Script sends as X-Proxy-Secret
  CANON_SESSION       optional   canon.pocketfm.ai __session cookie (for canon fetch)
  PORT                optional   port to listen on (default: 8000)

Run:
  pip install fastapi uvicorn openai requests python-dotenv
  uvicorn backend.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Optional

import requests
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from openai import OpenAI
from pydantic import BaseModel

load_dotenv()

# ─── config ───────────────────────────────────────────────────────────────────
MADEYE_API_KEY    = os.environ.get("MADEYE_API_KEY", "")
MADEYE_BASE_URL   = os.environ.get("MADEYE_BASE_URL", "")
MADEYE_MODEL      = os.environ.get("MADEYE_MODEL", "claude-opus-4-7")
MADEYE_USER_EMAIL = os.environ.get("MADEYE_USER_EMAIL", "")
PROXY_SECRET      = os.environ.get("PROXY_SECRET", "")
CANON_SESSION     = os.environ.get("CANON_SESSION", "")
CANON_HOST        = "https://canon.pocketfm.ai"

app = FastAPI(title="LS Verifier Proxy", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://script.google.com", "https://script.googleusercontent.com"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


# ─── auth ─────────────────────────────────────────────────────────────────────
def _check_auth(secret: str):
    if PROXY_SECRET and secret != PROXY_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ─── Madeye client ────────────────────────────────────────────────────────────
def _madeye_client() -> OpenAI:
    if not MADEYE_API_KEY:
        raise HTTPException(status_code=503, detail="MADEYE_API_KEY not configured.")
    if not MADEYE_BASE_URL:
        raise HTTPException(status_code=503, detail="MADEYE_BASE_URL not configured.")
    return OpenAI(api_key=MADEYE_API_KEY, base_url=MADEYE_BASE_URL, max_retries=1, timeout=60.0)


def _ask_madeye(system: str, user: str, max_tokens: int = 1024,
                user_email: str = "") -> str:
    if not (user_email or MADEYE_USER_EMAIL):
        raise HTTPException(
            status_code=503,
            detail="MADEYE_USER_EMAIL not configured (Madeye requires metadata.user_email).")
    client = _madeye_client()
    request = {
        "model": MADEYE_MODEL,
        "messages": [{"role": "system", "content": system},
                     {"role": "user",   "content": user}],
        "max_tokens": max_tokens,
        "extra_body": {"metadata": {"user_email": user_email or MADEYE_USER_EMAIL}},
    }
    if "opus-4-7" not in MADEYE_MODEL:
        request["temperature"] = 0.2
    resp = client.chat.completions.create(**request)
    return resp.choices[0].message.content or ""


# ─── canon fetcher ────────────────────────────────────────────────────────────
_canon_cache: dict[str, dict] = {}   # slug → {wiki, show}

def _fetch_canon(slug: str) -> dict:
    if slug in _canon_cache:
        return _canon_cache[slug]
    session = CANON_SESSION
    if not session:
        return {}
    url = f"{CANON_HOST}/{slug}/"
    headers = {"Cookie": f"__session={session}"}
    try:
        r = requests.get(url, headers=headers, timeout=20)
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
    return _extract_js_object(big, "WIKI_DATA") or {}, \
           _extract_js_object(big, "SHOW_DATA")


def _canon_context(slug: str) -> str:
    """Return a compact text summary of the canon for use as LLM context."""
    if not slug:
        return ""
    data = _fetch_canon(slug)
    wiki = data.get("wiki", {})
    if not wiki:
        return ""

    lines = [f"Show: {wiki.get('show_title', slug)}"]

    # characters
    chars = wiki.get("characters", {})
    char_list = []
    if isinstance(chars, list):
        char_list = chars
    elif isinstance(chars, dict):
        for group in chars.values():
            if isinstance(group, list):
                char_list.extend(group)

    for c in char_list[:40]:
        name = c.get("name", "")
        aliases = c.get("aliases", [])
        role = c.get("role", "")
        family = c.get("family", "")
        desc = c.get("description", "")[:120]
        line = f"  {name}"
        if aliases:
            line += f" (aka {', '.join(aliases[:3])})"
        if role:
            line += f" [{role}]"
        if family:
            line += f" — {family} family"
        if desc:
            line += f": {desc}"
        char_list_line = line
        lines.append(char_list_line)

    # dynasty
    dyn = wiki.get("dynasty_hierarchy", "")
    if dyn:
        lines.append(f"Families: {dyn[:300]}")

    return "\n".join(lines)


# ─── request models ───────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    question: str
    sheet_context: str          # compact sheet summary built by Apps Script
    source_lang: str = "en"
    target_lang: str = "fr"
    show_slug: str = ""         # e.g. "twists-of-love-revenge"
    user_email: str = ""        # active user's email (Apps Script Session.getActiveUser)


class LLMVerifyRequest(BaseModel):
    findings: list[dict]        # deterministic findings from Apps Script
    sheet_context: str
    source_lang: str = "en"
    target_lang: str = "fr"
    show_slug: str = ""
    user_email: str = ""        # active user's email (Apps Script Session.getActiveUser)


class CanonRequest(BaseModel):
    slug: str


# ─── endpoints ────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "madeye": bool(MADEYE_API_KEY and MADEYE_BASE_URL),
            "user_email": bool(MADEYE_USER_EMAIL),
            "canon_session": bool(CANON_SESSION)}


@app.get("/madeye-ping")
def madeye_ping(user_email: str = ""):
    """One cheap end-to-end call: proves key + base URL + budget + user_email work.

    Returns {"ok": true, "model": ..., "reply": ...} on success, or
    {"ok": false, "error": ...} with the exact Madeye failure (e.g. 401 bad key,
    400 MADEYE_MISSING_USER, budget exceeded). Hit this once after deploy.
    """
    missing = [name for name, val in (
        ("MADEYE_API_KEY", MADEYE_API_KEY),
        ("MADEYE_BASE_URL", MADEYE_BASE_URL),
        ("MADEYE_USER_EMAIL", user_email or MADEYE_USER_EMAIL),
    ) if not val]
    if missing:
        return {"ok": False, "error": f"not configured: {', '.join(missing)}"}
    try:
        reply = _ask_madeye(
            "Reply with the single word: pong.",
            "ping",
            max_tokens=8,
            user_email=user_email,
        )
        return {"ok": True, "model": MADEYE_MODEL, "reply": reply.strip()}
    except HTTPException as e:
        return {"ok": False, "error": e.detail}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/chat")
def chat(req: ChatRequest,
         x_proxy_secret: str = Header(default="")):
    _check_auth(x_proxy_secret)

    canon_ctx = _canon_context(req.show_slug)

    system = f"""You are a localization expert assistant for PocketFM audiobook production.
Source language: {req.source_lang}. Target language: {req.target_lang}.

You have access to two sources of truth:
1. THE SHOW CANON (character names, families, aliases, relationships)
2. THE LOCALIZATION SHEET (current source→target name decisions)

Always ground your answers in these. Be concise and specific.

--- CANON ---
{canon_ctx or '(not available)'}

--- LOCALIZATION SHEET ---
{req.sheet_context}
"""
    try:
        answer = _ask_madeye(system, req.question, max_tokens=512,
                             user_email=req.user_email)
        return {"answer": answer}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/verify-llm")
def verify_llm(req: LLMVerifyRequest,
               x_proxy_secret: str = Header(default="")):
    _check_auth(x_proxy_secret)

    canon_ctx = _canon_context(req.show_slug)

    # Pass deterministic findings + sheet to Madeye for Bucket D judgment.
    findings_text = "\n".join(
        f"- [{f.get('kind','?')}] Row {f.get('row','?')}: {f.get('detail','')}"
        for f in req.findings[:50]
    )

    system = f"""You are a localization QA expert for PocketFM.
Source: {req.source_lang} → Target: {req.target_lang}.

A deterministic verifier already flagged the issues below.
Your job:
1. For each issue, confirm if it is a real problem or a false positive.
2. For CULTURAL / REGISTER issues the verifier can't judge, add your own findings.
3. For each real issue, suggest the corrected localized name.

Respond as JSON: {{"findings": [{{"row": ..., "kind": ..., "confirmed": true/false, "suggestion": "..."}}]}}

--- CANON ---
{canon_ctx or '(not available)'}

--- SHEET ---
{req.sheet_context}

--- DETERMINISTIC FINDINGS ---
{findings_text}
"""
    try:
        raw = _ask_madeye(system, "Review the findings above.", max_tokens=2048,
                          user_email=req.user_email)
        # try to parse JSON out of the response
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            return json.loads(m.group(0))
        return {"raw": raw}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/canon")
def get_canon(req: CanonRequest,
              x_proxy_secret: str = Header(default="")):
    _check_auth(x_proxy_secret)
    data = _fetch_canon(req.slug)
    if "error" in data:
        raise HTTPException(status_code=502, detail=data["error"])
    # return a compact character list safe to send to Apps Script
    wiki = data.get("wiki", {})
    chars = wiki.get("characters", {})
    char_list = []
    if isinstance(chars, list):
        char_list = chars
    elif isinstance(chars, dict):
        for group in chars.values():
            if isinstance(group, list):
                char_list.extend(group)
    return {
        "show": wiki.get("show_title", req.slug),
        "lang": (data.get("show") or {}).get("lang", ""),
        "dynasty": wiki.get("dynasty_hierarchy", ""),
        "characters": [
            {"name": c.get("name",""), "aliases": c.get("aliases",[]),
             "role": c.get("role",""), "family": c.get("family","")}
            for c in char_list
        ]
    }


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
