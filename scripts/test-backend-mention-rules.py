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

common_noun_rows = [
    {
        "Canonical Name": "emily kaiser",
        "Original Mention": "doctor",
        "Localized Mention": "docteur",
        "English Translated Mention": "doctor",
    },
    {
        "Canonical Name": "emily kaiser",
        "Original Mention": "doctor",
        "Localized Mention": "medecin",
        "English Translated Mention": "doctor",
    },
]
common_findings = main._base_mention_findings(
    ld, common_noun_rows, None, target_lang="fr", include_mechanical=True, include_culture=False
)
assert "CROSS_MENTION_INCONSISTENCY" not in kinds(common_findings), common_findings

low_value_candidates = common_noun_rows[:1] + [
    {
        "Canonical Name": "emily kaiser",
        "Original Mention": "emilys",
        "Localized Mention": "d'Émilie",
        "English Translated Mention": "Emily's",
    },
    bad_married_title[0],
]
candidates = main._candidate_rows_for_llm(low_value_candidates, [], 10)
assert [c["row"] for c in candidates] == [4], candidates

source_leak_common = [{
    "Canonical Name": "emily kaiser",
    "Original Mention": "oma",
    "Localized Mention": "Oma",
    "English Translated Mention": "Grandmother",
}]
source_leak_findings = main._base_mention_findings(
    ld, source_leak_common, None, target_lang="fr", include_mechanical=False, include_culture=True
)
assert "TARGET_CULTURE_MISMATCH" in kinds(source_leak_findings), source_leak_findings
source_leak_candidates = main._candidate_rows_for_llm(source_leak_common, source_leak_findings, 10)
assert [c["row"] for c in source_leak_candidates] == [2], source_leak_candidates

place_object_rows = [
    {
        "Canonical Name": "aaketi's castle",
        "Original Mention": "the castle",
        "Localized Mention": "le château",
        "English Translated Mention": "the castle",
    },
    {
        "Canonical Name": "aaketi's castle",
        "Original Mention": "this castle",
        "Localized Mention": "ce château",
        "English Translated Mention": "this castle",
    },
    {
        "Canonical Name": "aaketi's castle moat",
        "Original Mention": "an expansive moat",
        "Localized Mention": "des douves étendues",
        "English Translated Mention": "an expansive moat",
    },
    {
        "Canonical Name": "aaketi's castle throne room",
        "Original Mention": "an ornately decorated throne room",
        "Localized Mention": "une salle du trône richement décorée",
        "English Translated Mention": "an ornately decorated throne room",
    },
    {
        "Canonical Name": "aaketi's golden throne",
        "Original Mention": "his throne",
        "Localized Mention": "son trône",
        "English Translated Mention": "his throne",
    },
    {
        "Canonical Name": "aaketi's castle dining room",
        "Original Mention": "the dining room",
        "Localized Mention": "la salle à manger",
        "English Translated Mention": "the dining room",
    },
]
assert not main._candidate_rows_for_llm(place_object_rows, [], 10), place_object_rows

assert main._extract_json_object('prefix {"findings": []} suffix') == {"findings": []}

print("backend mention rules ok")
