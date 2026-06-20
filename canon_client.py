#!/usr/bin/env python3
"""
Canon client — turns a show's canon.pocketfm.ai page into a structured,
source-language character graph the verifier and chatbot can query.

SOURCE-FIRST PRINCIPLE
----------------------
The canon is the upstream source of truth. Its language IS the source language
of the show (the `lang` field). Every rule — family atlas, alias table,
relationship pairs — is built in that source language and is matched against the
LS `Original Name` column (same language). The target/localized column is only
ever *checked*, never used to build rules or joins.

TWO WAYS TO LOAD
----------------
1. Live fetch (run from a host that can reach canon.pocketfm.ai):
       g = CanonGraph.from_web("twists-of-love-revenge", session_cookie=os.environ["CANON_SESSION"])
   The canon host is RFC-walled / egress-gated, so this only works from inside
   the PocketFM network or an allowlisted environment.

2. From an already-extracted WIKI_DATA json (works anywhere):
       g = CanonGraph.from_wiki_json("tolr_wiki.json")
   The page embeds the data as `const WIKI_DATA = {...}` and
   `const SHOW_DATA = {...}` inside its largest <script> block; extract_from_html()
   pulls those out so you can save them once and reuse offline.

The graph exposes:
    g.source_lang                      -> "English" | "German" | ...
    g.characters                       -> {canonical_name: Character}
    g.family_of(name)                  -> family key or None
    g.families                         -> {family: [member names]}
    g.resolve_alias(any_name)          -> canonical character name or None
    g.surname_atlas()                  -> {canonical_name: expected_surname}
    g.are_related(name_a, name_b)      -> relationship type or None (marriage etc.)
    g.card(name)                       -> compact dict for chatbot / decision queue
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from typing import Optional


CANON_HOST = "https://canon.pocketfm.ai"


# ─── data model ────────────────────────────────────────────────────────────────
@dataclass
class Character:
    name: str                              # canonical name as written in canon
    aliases: list[str] = field(default_factory=list)
    role: str = ""                         # protagonist | antagonist | supporting...
    status: str = ""                       # alive | deceased | ...
    family: str = ""                       # family/dynasty key (source-language)
    relationships: list[dict] = field(default_factory=list)  # [{name, type}]
    description: str = ""
    ep_start: Optional[int] = None
    ep_end: Optional[int] = None

    def all_forms(self) -> list[str]:
        """Every string that should resolve to this character."""
        return [self.name] + list(self.aliases)


# ─── helpers ───────────────────────────────────────────────────────────────────
def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


def _last_token(name: str) -> str:
    parts = [p for p in re.split(r"[\s]+", name.strip()) if p]
    return parts[-1] if parts else ""


def _split_compound_name(name: str) -> str:
    """A canon name may be 'Eliza Robbins / Charity Neeson' — take the first form
    as the primary, the rest become aliases."""
    return re.split(r"\s*/\s*", name.strip())[0]


# ─── the graph ─────────────────────────────────────────────────────────────────
class CanonGraph:
    def __init__(self, wiki: dict, show: Optional[dict] = None):
        self._wiki = wiki or {}
        self._show = show or {}
        self.show_title: str = (
            self._wiki.get("show_title")
            or (self._show.get("show", {}) or {}).get("title", "")
            or ""
        )
        self.source_lang: str = self._detect_lang()
        self.characters: dict[str, Character] = {}
        self.families: dict[str, list[str]] = {}
        self._alias_index: dict[str, str] = {}   # normalized form -> canonical name
        self._build()

    # ---- construction --------------------------------------------------------
    def _detect_lang(self) -> str:
        for src in (self._show.get("show", {}), self._show, self._wiki):
            if isinstance(src, dict) and src.get("lang"):
                return src["lang"]
        return "English"

    def _iter_raw_characters(self):
        """The WIKI_DATA character block can be a flat list or grouped under
        primary/secondary/antagonists/etc. Yield (raw_dict, group_role)."""
        chars = self._wiki.get("characters")
        if isinstance(chars, list):
            for c in chars:
                yield c, ""
        elif isinstance(chars, dict):
            for group, items in chars.items():
                if isinstance(items, list):
                    for c in items:
                        yield c, group
        # supporting_cast / character_deep_dives sometimes carry extra people
        for extra_key in ("supporting_cast", "character_deep_dives"):
            extra = self._wiki.get(extra_key)
            if isinstance(extra, list):
                for c in extra:
                    yield c, "supporting"

    def _build(self):
        # dynasty/family hierarchy text → {family: [members]} if present structurally
        for raw, group in self._iter_raw_characters():
            if not isinstance(raw, dict):
                continue
            full = str(raw.get("name", "")).strip()
            if not full:
                continue
            primary = _split_compound_name(full)
            aliases = list(raw.get("aliases", []) or [])
            # any extra slash-forms become aliases
            extra_forms = re.split(r"\s*/\s*", full)[1:]
            aliases.extend(extra_forms)

            role = str(raw.get("role", "") or group or "").strip()
            status = str(raw.get("status", "") or "").strip()
            family = str(raw.get("family", "") or raw.get("faction", "") or "").strip()
            rels = raw.get("relationships", []) or []
            norm_rels = []
            for r in rels:
                if isinstance(r, dict) and r.get("name"):
                    norm_rels.append({"name": str(r["name"]).strip(),
                                      "type": str(r.get("type", "")).strip().lower()})
                elif isinstance(r, str):
                    norm_rels.append({"name": r.strip(), "type": ""})

            ch = Character(
                name=primary,
                aliases=[a for a in dict.fromkeys(aliases) if a and a != primary],
                role=role,
                status=status,
                family=family,
                relationships=norm_rels,
                description=str(raw.get("description", "") or "")[:600],
                ep_start=raw.get("start") or raw.get("ep_start"),
                ep_end=raw.get("end") or raw.get("ep_end"),
            )
            # merge if the canonical name already exists
            if _norm(primary) in self._alias_index:
                existing = self.characters[self._alias_index[_norm(primary)]]
                self._merge(existing, ch)
            else:
                self.characters[primary] = ch
                for form in ch.all_forms():
                    self._alias_index.setdefault(_norm(form), primary)

        # families from explicit field
        for name, ch in self.characters.items():
            if ch.family:
                self.families.setdefault(ch.family, []).append(name)

        # families from dynasty_hierarchy free-text (fallback / enrichment)
        self._parse_dynasty_text()

    def _merge(self, target: Character, other: Character):
        for a in other.all_forms():
            if a != target.name and a not in target.aliases:
                target.aliases.append(a)
                self._alias_index.setdefault(_norm(a), target.name)
        target.relationships.extend(
            r for r in other.relationships if r not in target.relationships)
        if not target.family and other.family:
            target.family = other.family
        if not target.description and other.description:
            target.description = other.description

    def _parse_dynasty_text(self):
        """Parse a free-text dynasty hierarchy like:
        'Archer family (global Tier 1), Williams/Snow/Jewell (national Tier 2)...'
        and attach family membership by scanning each character's surname."""
        blob = ""
        for key in ("dynasty_hierarchy", "world_building", "factions"):
            v = self._wiki.get(key)
            if isinstance(v, str):
                blob += " " + v
            elif isinstance(v, dict):
                blob += " " + json.dumps(v)
        if not blob.strip():
            return
        # family tokens are Capitalised words appearing before 'family' or in slash groups
        fam_tokens = set()
        for m in re.finditer(r"([A-Z][\wÀ-ÿ]+)\s+family", blob):
            fam_tokens.add(m.group(1))
        for m in re.finditer(r"\b([A-Z][\wÀ-ÿ]+(?:/[A-Z][\wÀ-ÿ]+)+)\b", blob):
            for tok in m.group(1).split("/"):
                fam_tokens.add(tok)
        # assign characters whose surname matches a family token
        for name, ch in self.characters.items():
            if ch.family:
                continue
            sur = _last_token(ch.name)
            if sur in fam_tokens:
                ch.family = sur
                self.families.setdefault(sur, []).append(name)

    # ---- queries -------------------------------------------------------------
    def resolve_alias(self, any_name: str) -> Optional[str]:
        """Map any name/alias form to the canonical character name."""
        if not any_name:
            return None
        key = _norm(any_name)
        if key in self._alias_index:
            return self._alias_index[key]
        # surname-only or first-name-only fallback
        toks = key.split()
        for cn, ch in self.characters.items():
            forms = {_norm(f) for f in ch.all_forms()}
            for f in forms:
                ftoks = f.split()
                if toks and ftoks and (toks[0] == ftoks[0] or toks[-1] == ftoks[-1]):
                    if len(toks) > 1 and toks == ftoks:
                        return cn
        return None

    def family_of(self, name: str) -> Optional[str]:
        cn = self.resolve_alias(name)
        if not cn:
            return None
        fam = self.characters[cn].family
        return fam or None

    def surname_atlas(self) -> dict[str, str]:
        """{canonical_name: expected source-language surname} — the reference the
        family-consistency check enforces on the localized side."""
        out: dict[str, str] = {}
        for name, ch in self.characters.items():
            sur = _last_token(ch.name)
            if sur:
                out[name] = sur
        return out

    def are_related(self, a: str, b: str) -> Optional[str]:
        """Return the relationship type between two characters if the canon
        records one (e.g. 'spouse', 'parent') — used to exempt legitimate
        married-name surname sharing from collision flags."""
        ca, cb = self.resolve_alias(a), self.resolve_alias(b)
        if not ca or not cb:
            return None
        for r in self.characters[ca].relationships:
            if self.resolve_alias(r["name"]) == cb:
                return r["type"] or "related"
        for r in self.characters[cb].relationships:
            if self.resolve_alias(r["name"]) == ca:
                return r["type"] or "related"
        if ca != cb and self.characters[ca].family and \
           self.characters[ca].family == self.characters[cb].family:
            return "family"
        return None

    def card(self, name: str) -> Optional[dict]:
        """Compact character card for the chatbot and decision queue."""
        cn = self.resolve_alias(name)
        if not cn:
            return None
        ch = self.characters[cn]
        return {
            "name": ch.name,
            "aliases": ch.aliases,
            "role": ch.role,
            "status": ch.status,
            "family": ch.family,
            "relationships": ch.relationships,
            "episodes": [ch.ep_start, ch.ep_end],
            "description": ch.description,
        }

    def summary(self) -> dict:
        return {
            "show": self.show_title,
            "source_lang": self.source_lang,
            "characters": len(self.characters),
            "families": {f: len(m) for f, m in self.families.items()},
        }

    # ---- loaders -------------------------------------------------------------
    @classmethod
    def from_wiki_json(cls, wiki_path: str, show_path: Optional[str] = None) -> "CanonGraph":
        with open(wiki_path, encoding="utf-8") as f:
            wiki = json.load(f)
        show = None
        if show_path:
            with open(show_path, encoding="utf-8") as f:
                show = json.load(f)
        return cls(wiki, show)

    @classmethod
    def from_html(cls, html_path: str) -> "CanonGraph":
        with open(html_path, encoding="utf-8") as f:
            html = f.read()
        wiki, show = extract_from_html(html)
        return cls(wiki, show)

    @classmethod
    def from_web(cls, slug: str, session_cookie: str,
                 host: str = CANON_HOST) -> "CanonGraph":
        """Fetch + parse live. Only works from a host that can reach the canon."""
        import urllib.request
        url = f"{host}/{slug}/"
        req = urllib.request.Request(url, headers={"Cookie": f"__session={session_cookie}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            html = r.read().decode("utf-8", "replace")
        wiki, show = extract_from_html(html)
        if not wiki:
            raise RuntimeError(f"No WIKI_DATA found at {url} — check auth/slug.")
        return cls(wiki, show)


# ─── HTML extraction ───────────────────────────────────────────────────────────
def _extract_js_object(js: str, varname: str) -> Optional[dict]:
    m = re.search(r"(?:const|let|var)\s+" + re.escape(varname) + r"\s*=\s*(\{)", js)
    if not m:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(js, m.start(1))
        return obj
    except json.JSONDecodeError:
        return None


def extract_from_html(html: str) -> tuple[dict, Optional[dict]]:
    """Pull WIKI_DATA and SHOW_DATA out of the canon page's largest <script>."""
    scripts = re.findall(r"<script[^>]*>(.*?)</script>", html, re.DOTALL)
    if not scripts:
        return {}, None
    big = max(scripts, key=len)
    wiki = _extract_js_object(big, "WIKI_DATA") or {}
    show = _extract_js_object(big, "SHOW_DATA")
    return wiki, show


# ─── CLI: inspect / save canon ─────────────────────────────────────────────────
def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Inspect a show's canon graph")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--wiki-json", help="path to extracted WIKI_DATA json")
    src.add_argument("--html", help="path to a saved canon page .html")
    src.add_argument("--slug", help="fetch live (needs CANON_SESSION env)")
    ap.add_argument("--show-json", help="optional SHOW_DATA json")
    ap.add_argument("--who", help="print the character card for this name")
    ap.add_argument("--family-of", help="print the family of this name")
    args = ap.parse_args()

    if args.wiki_json:
        g = CanonGraph.from_wiki_json(args.wiki_json, args.show_json)
    elif args.html:
        g = CanonGraph.from_html(args.html)
    else:
        import os
        cookie = os.environ.get("CANON_SESSION", "")
        if not cookie:
            print("ERROR: set CANON_SESSION env to fetch live.", file=sys.stderr)
            return 2
        g = CanonGraph.from_web(args.slug, cookie)

    print(json.dumps(g.summary(), indent=2, ensure_ascii=False))
    if args.who:
        print("\n--- card ---")
        print(json.dumps(g.card(args.who), indent=2, ensure_ascii=False))
    if args.family_of:
        print(f"\nfamily_of({args.family_of!r}) = {g.family_of(args.family_of)!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
