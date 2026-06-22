#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import main


def kinds(findings):
    return {f["kind"] for f in findings}


ld = [
    {"Original Name": "andrew", "Localized Name": "André"},
    {"Original Name": "emily kaiser", "Localized Name": "Émilie Lempereur"},
]

valid_title = [{
    "Canonical Name": "andrew",
    "Original Mention": "mr. andrew",
    "Localized Mention": "Monsieur André",
    "English Translated Mention": "Mr. Andrew",
    "Gender": "Male",
}]

bad_married_title = [{
    "Canonical Name": "emily kaiser",
    "Original Mention": "mrs. ethan williams",
    "Localized Mention": "Madame Ethan Moreau",
    "English Translated Mention": "Mrs. Ethan Williams",
    "Gender": "Female",
}]

valid_findings = main._base_mention_findings(
    ld, valid_title, None, target_lang="fr", include_mechanical=True, include_culture=True
)
assert "MENTION_MASTER_MISMATCH" not in kinds(valid_findings), valid_findings

bad_findings = main._base_mention_findings(
    ld, bad_married_title, None, target_lang="fr", include_mechanical=False, include_culture=True
)
assert any(
    f["kind"] == "REGISTER_MISMATCH" and f["suggestion"] == "Madame Moreau"
    for f in bad_findings
), bad_findings

bad_all_findings = main._base_mention_findings(
    ld, bad_married_title, None, target_lang="fr", include_mechanical=True, include_culture=True
)
assert "MENTION_MASTER_MISMATCH" not in kinds(bad_all_findings), bad_all_findings

assert main._extract_json_object('prefix {"findings": []} suffix') == {"findings": []}

print("backend mention rules ok")
