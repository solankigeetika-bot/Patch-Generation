#!/usr/bin/env python3
"""
LLM-powered localization verifier for PocketFM character/entity sheets.

Combines deterministic rule checks (C0-C3) with an LLM pass (via the OpenAI
SDK pointed at PocketFM's internal MADEYE gateway) that judges localization
quality the way a human reviewer would: cultural fit, mistranslation, source
language leaking into the target, gender/name consistency, register, etc.

The MADEYE gateway is OpenAI-compatible, so we use the official `openai` SDK
and just override `base_url`.

Configuration (environment variables — never hardcode the key):
    MADEYE_API_KEY     required   API key for the gateway
    MADEYE_BASE_URL    required   e.g. https://madeye.internal.pocketfm.org
    MADEYE_MODEL       optional   model name served by the gateway (default below)

Usage:
    pip install openai
    export MADEYE_API_KEY=sk-...
    export MADEYE_BASE_URL=https://madeye.internal.pocketfm.org
    export MADEYE_MODEL=gpt-4o            # whatever your gateway serves

    python localisation_verifier_llm.py \
        --input TOLR_1-100_source.csv \
        --output TOLR_1-100_verified.csv \
        --source-lang de --target-lang fr

    # validate wiring without spending tokens / needing the network:
    python localisation_verifier_llm.py --input TOLR_1-100_source.csv \
        --output /tmp/out.csv --dry-run

NOTE: MADEYE lives on a private (RFC-1918) IP, so this script must be run from
a host with access to the PocketFM internal network. It cannot reach MADEYE
from the public cloud sandbox.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Optional

# ── Language metadata ─────────────────────────────────────────────────────────
LANGS = {
    "de": "German", "fr": "French", "en": "English", "it": "Italian",
    "tr": "Turkish", "es": "Spanish", "pt": "Portuguese",
    "de-DE": "German", "fr-FR": "French", "en-US": "English",
    "it-IT": "Italian", "tr-TR": "Turkish",
}


def lang_name(code: str) -> str:
    return LANGS.get(code, LANGS.get(code.split("-")[0], code))


# ── Deterministic helpers (the C0-C3 rule layer) ──────────────────────────────
EMPTY = {"", "none", "null", "n/a", "-", "undefined", "na", "#n/a", "tbd", "tbc"}


def is_empty(v: Optional[str]) -> bool:
    return (v or "").strip().lower() in EMPTY


CHAPTER_RE = re.compile(r"^\d+(\s*,\s*\d+)*$")
LOWER_START = re.compile(r"^[a-zà-öø-ÿ]")
VALID_CULTURAL = {
    "LOCALIZED", "KEPT", "ADAPTED", "TRANSLATED", "REMOVED", "ADDED",
    "MODIFIED", "ORIGINAL", "MIXED", "UNIVERSAL",
}

# A small, extensible set of source-language stopwords/markers used to catch
# obvious source-language leakage into the target column. The LLM pass is the
# real check; this just flags the blatant cases deterministically.
SOURCE_LEAK_WORDS = {
    "de": re.compile(
        r"\b(der|die|das|und|von|für|ist|bei|mit|auf|des|dem|den|ein|eine|einer|"
        r"einen|einem|eines|nicht|schwester|schwägerin|schatz|bruder|vater|mutter|"
        r"großvater|großmutter|herr|frau|kaiser|konzern|büro|gesellschaft|firma)\b",
        re.IGNORECASE,
    ),
}


def is_alias_row(row: dict) -> bool:
    """Mention/nickname rows store chapter numbers in the localized-first-name
    field and 'Yes' in the localized-last-name field rather than real names."""
    return bool(
        CHAPTER_RE.match((row.get("First Name (Localized)") or "").strip())
        or (row.get("Last Name (Localized)") or "").strip() == "Yes"
    )


@dataclass
class Finding:
    engine: str          # C0/C1/C2/C3 (rules) or "LLM"
    severity: str        # critical|high|medium|low|info
    kind: str
    detail: str
    fix: str = ""


SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
STATUS_LABEL = {
    "critical": "CRITICAL", "high": "HIGH", "medium": "WARN",
    "low": "LOW", "info": "INFO",
}


def rule_checks(row: dict, src: str, tgt: str) -> list[Finding]:
    """Deterministic C0-C3 checks. Cheap, run on every row before the LLM."""
    out: list[Finding] = []
    orig = (row.get("Original Name") or "").strip()
    loc = (row.get("Localized Name") or "").strip()
    fn_l = (row.get("First Name (Localized)") or "").strip()
    ln_l = (row.get("Last Name (Localized)") or "").strip()
    status = (row.get("Cultural Status") or "").strip()
    reason = (row.get("Localization Reason") or "").strip()
    alias = is_alias_row(row)

    leak_re = SOURCE_LEAK_WORDS.get(src.split("-")[0])

    # source-language leakage (applies to all rows)
    if leak_re and not is_empty(loc):
        m = leak_re.search(loc)
        if m:
            out.append(Finding("C2", "high", "source_lang_leak",
                               f"{lang_name(src)} word '{m.group()}' in localized name '{loc}'.",
                               f"Replace with {lang_name(tgt)} equivalent."))

    # casing
    if not is_empty(loc) and LOWER_START.match(loc):
        out.append(Finding("C3", "low", "casing",
                           f"Localized name '{loc}' starts lowercase.",
                           "Capitalise the first letter."))

    if alias:
        return out

    # main-row-only checks
    if is_empty(loc):
        out.append(Finding("C0", "critical", "missing_localised",
                           f"'{orig}' has no {lang_name(tgt)} localized name.",
                           "Add a localized name."))
    if is_empty(status):
        out.append(Finding("C0", "high", "missing_cultural_status",
                           "Cultural Status is empty.", "Set a cultural status."))
    elif status.upper() not in VALID_CULTURAL:
        out.append(Finding("C0", "medium", "invalid_cultural_status",
                           f"Cultural Status '{status[:40]}' is not recognised.",
                           f"Use one of: {', '.join(sorted(VALID_CULTURAL))}"))
    if is_empty(reason):
        out.append(Finding("C0", "high", "missing_localisation_reason",
                           "Localization Reason is empty.", "Explain the decision."))

    if not is_empty(fn_l) and not is_empty(ln_l) and not is_empty(loc):
        if f"{fn_l} {ln_l}".lower() != loc.lower():
            out.append(Finding("C1", "medium", "name_inconsistency",
                               f"First '{fn_l}' + Last '{ln_l}' != '{loc}'.",
                               "Align name parts with the full localized name."))

    if not is_empty(loc) and not is_empty(orig) and loc.lower() == orig.lower():
        if status.upper() not in {"KEPT", "ORIGINAL", "UNIVERSAL", ""}:
            out.append(Finding("C2", "high", "source_name_not_localised",
                               f"Localized '{loc}' == source '{orig}' but status is '{status}'.",
                               "Localize, or set status to KEPT/ORIGINAL."))
    if status.upper() in {"KEPT", "ORIGINAL"} and not is_empty(loc) and not is_empty(orig):
        if loc.lower() != orig.lower():
            out.append(Finding("C2", "high", "status_mismatch",
                               f"Status '{status}' but name changed: '{orig}' -> '{loc}'.",
                               "Fix status or revert the name."))
    return out


# ── LLM layer ─────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are an expert localization quality reviewer for fiction \
audiobooks. You verify that character and entity names have been correctly \
localized from {src} into {tgt}. You are precise, conservative, and only flag \
genuine problems. You never invent issues for correct localizations."""

USER_PROMPT = """Review ONE localization entry from a {src}->{tgt} character sheet.

Original ({src}) name : {orig}
Localized ({tgt}) name: {loc}
English gloss         : {eng}
Gender                : {gender}
Cultural status       : {status}
Stated reason         : {reason}
Context/description   : {desc}

Check for, in {tgt}:
1. mistranslation or wrong meaning of the localized name
2. {src} (or other non-{tgt}) words/morphology leaking into the localized name
3. cultural inappropriateness or a name that does not read naturally in {tgt}
4. gender mismatch between the name and the stated gender
5. the cultural status not matching what was actually done to the name
6. register/formality problems (titles, honorifics)

Respond with STRICT JSON only, no prose:
{{"verdict":"pass|warn|fail",
  "issues":[{{"severity":"high|medium|low","kind":"short_snake_case_tag","detail":"one sentence","fix":"one sentence"}}],
  "comment":"<=20 word overall note"}}
If the localization is good, return verdict "pass" and an empty issues list."""


@dataclass
class LLMConfig:
    api_key: str
    base_url: str
    model: str
    temperature: float = 0.0
    max_retries: int = 4


def build_client(cfg: LLMConfig):
    from openai import OpenAI
    return OpenAI(api_key=cfg.api_key, base_url=cfg.base_url, max_retries=0)


def llm_verify_row(client, cfg: LLMConfig, row: dict, src: str, tgt: str) -> list[Finding]:
    """One LLM call per main row. Returns Findings tagged engine='LLM'."""
    prompt = USER_PROMPT.format(
        src=lang_name(src), tgt=lang_name(tgt),
        orig=(row.get("Original Name") or "").strip() or "(none)",
        loc=(row.get("Localized Name") or "").strip() or "(none)",
        eng=(row.get("English Translated Name") or "").strip() or "(none)",
        gender=(row.get("Gender") or "").strip() or "(unspecified)",
        status=(row.get("Cultural Status") or "").strip() or "(none)",
        reason=((row.get("Localization Reason") or "").strip()[:600]) or "(none)",
        desc=((row.get("Description") or "").strip()[:600]) or "(none)",
    )
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT.format(src=lang_name(src), tgt=lang_name(tgt))},
        {"role": "user", "content": prompt},
    ]

    last_err = None
    for attempt in range(cfg.max_retries):
        try:
            resp = client.chat.completions.create(
                model=cfg.model,
                messages=messages,
                temperature=cfg.temperature,
                response_format={"type": "json_object"},
            )
            content = resp.choices[0].message.content or "{}"
            data = json.loads(content)
            findings: list[Finding] = []
            for it in data.get("issues", []) or []:
                findings.append(Finding(
                    engine="LLM",
                    severity=(it.get("severity") or "medium").lower(),
                    kind=it.get("kind") or "llm_issue",
                    detail=it.get("detail") or "",
                    fix=it.get("fix") or "",
                ))
            return findings
        except json.JSONDecodeError as e:
            last_err = e  # bad JSON -> retry
        except Exception as e:  # network / rate-limit / server
            last_err = e
            time.sleep(2 ** attempt)
    return [Finding("LLM", "info", "llm_error",
                    f"LLM verification failed: {type(last_err).__name__}: {str(last_err)[:120]}",
                    "Re-run; check MADEYE connectivity / model name.")]


# ── Orchestration ─────────────────────────────────────────────────────────────
def worst_status(findings: list[Finding]) -> str:
    non_casing = [f for f in findings if f.kind != "casing"]
    if not non_casing:
        return "PASS"
    sev = min(non_casing, key=lambda f: SEV_ORDER.get(f.severity, 9)).severity
    return STATUS_LABEL.get(sev, sev.upper())


def fmt(findings: list[Finding], engine_prefix: str) -> str:
    return " | ".join(
        f"[{f.kind}] {f.detail}" for f in findings if f.engine.startswith(engine_prefix)
    )


def run(args) -> int:
    src, tgt = args.source_lang, args.target_lang

    with open(args.input, newline="") as f:
        rows = list(csv.DictReader(f))
    print(f"Loaded {len(rows)} rows from {args.input}", file=sys.stderr)

    client = cfg = None
    if not args.dry_run:
        api_key = os.environ.get("MADEYE_API_KEY")
        base_url = os.environ.get("MADEYE_BASE_URL")
        model = args.model or os.environ.get("MADEYE_MODEL", "gpt-4o")
        if not api_key or not base_url:
            print("ERROR: set MADEYE_API_KEY and MADEYE_BASE_URL (or use --dry-run).",
                  file=sys.stderr)
            return 2
        cfg = LLMConfig(api_key=api_key, base_url=base_url, model=model)
        client = build_client(cfg)
        print(f"MADEYE: {base_url}  model={model}", file=sys.stderr)

    # rule checks for every row (cheap)
    rule_results: list[list[Finding]] = [rule_checks(r, src, tgt) for r in rows]

    # LLM checks for main rows only (alias rows have no real localized name)
    llm_results: list[list[Finding]] = [[] for _ in rows]
    main_idx = [i for i, r in enumerate(rows) if not is_alias_row(r)]
    if args.limit:
        main_idx = main_idx[: args.limit]
    print(f"Main rows to LLM-verify: {len(main_idx)} "
          f"(alias rows skipped, dry_run={args.dry_run})", file=sys.stderr)

    if not args.dry_run:
        done = 0
        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            fut = {ex.submit(llm_verify_row, client, cfg, rows[i], src, tgt): i
                   for i in main_idx}
            for f in as_completed(fut):
                i = fut[f]
                llm_results[i] = f.result()
                done += 1
                if done % 10 == 0 or done == len(main_idx):
                    print(f"  ...{done}/{len(main_idx)} LLM-verified", file=sys.stderr)

    # write output
    src_cols = list(rows[0].keys()) if rows else []
    verif_cols = ["ROW_TYPE", "VERIF_STATUS", "ISSUE_COUNT",
                  "RULE_FINDINGS", "LLM_FINDINGS", "SUGGESTED_FIXES"]
    with open(args.output, "w", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(src_cols + verif_cols)
        for i, row in enumerate(rows):
            findings = rule_results[i] + llm_results[i]
            fixes = list({fd.fix for fd in findings if fd.fix and fd.kind != "casing"})
            w.writerow(
                [row.get(c, "") for c in src_cols] + [
                    "ALIAS" if is_alias_row(row) else "MAIN",
                    worst_status(findings),
                    str(len(findings)),
                    " | ".join(f"[{fd.engine}:{fd.kind}] {fd.detail}"
                               for fd in rule_results[i]),
                    " | ".join(f"[{fd.kind}] {fd.detail}" for fd in llm_results[i]),
                    " | ".join(fixes[:4]),
                ]
            )
    total = sum(len(rule_results[i]) + len(llm_results[i]) for i in range(len(rows)))
    print(f"Wrote {args.output}: {len(rows)} rows, {total} findings "
          f"({sum(len(x) for x in llm_results)} from LLM)", file=sys.stderr)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="LLM-powered localization verifier (MADEYE/OpenAI SDK)")
    p.add_argument("--input", required=True, help="source CSV (original sheet export)")
    p.add_argument("--output", required=True, help="verified CSV to write")
    p.add_argument("--source-lang", default="de", help="source language code (default de)")
    p.add_argument("--target-lang", default="fr", help="target language code (default fr)")
    p.add_argument("--model", default=None, help="override MADEYE_MODEL")
    p.add_argument("--concurrency", type=int, default=4, help="parallel LLM calls (default 4)")
    p.add_argument("--limit", type=int, default=0, help="cap number of main rows LLM-verified")
    p.add_argument("--dry-run", action="store_true",
                   help="run rule checks only, skip LLM (no network/key needed)")
    return run(p.parse_args())


if __name__ == "__main__":
    sys.exit(main())
