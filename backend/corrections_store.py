"""Shared corrections dictionary — SQLite, stdlib only.

Maps (character_id, norm_orig_mention) → human correction.
Latest write wins (UPSERT). Applied as Layer 0 in run_verification().

Proper-noun guard at write time:
  LEARNED      — original mention contains a known character-name token
  ALIAS_LEARNED — original mention has NO character-name tokens (e.g. 'was', 'a miss')
                  → written yellow in the output with 'verify context' note
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get("CORRECTIONS_DB", "./corrections.db")


def _conn() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        CREATE TABLE IF NOT EXISTS corrections (
            cid               TEXT NOT NULL,
            norm_orig         TEXT NOT NULL,
            original_mention  TEXT,
            human_correction  TEXT NOT NULL,
            status_tag        TEXT NOT NULL DEFAULT 'LEARNED',
            created_at        TEXT NOT NULL,
            PRIMARY KEY (cid, norm_orig)
        )
    """)
    con.commit()
    return con


def get_all() -> dict[tuple, dict]:
    """Return {(cid, norm_orig): {value, status_tag}} for every stored correction."""
    try:
        con = _conn()
        rows = con.execute(
            "SELECT cid, norm_orig, human_correction, status_tag FROM corrections"
        ).fetchall()
        con.close()
    except Exception:
        return {}
    return {(r[0], r[1]): {"value": r[2], "status_tag": r[3]} for r in rows}


def add(cid: str, norm_orig: str, original_mention: str,
        human_correction: str, name_tokens: set[str]) -> str:
    """Store a correction and return the status_tag.

    name_tokens — set of normalized character-name tokens from the current LD;
    passed in by the caller so this module doesn't import verify_ls.
    """
    alias = not any(t in name_tokens for t in norm_orig.split() if len(t) > 2)
    status_tag = "ALIAS_LEARNED" if alias else "LEARNED"
    created_at = datetime.now(timezone.utc).isoformat()
    con = _conn()
    con.execute("""
        INSERT OR REPLACE INTO corrections
          (cid, norm_orig, original_mention, human_correction, status_tag, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (cid, norm_orig, original_mention, human_correction, status_tag, created_at))
    con.commit()
    con.close()
    return status_tag
