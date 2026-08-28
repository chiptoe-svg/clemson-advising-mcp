"""Gen-ed categories are named in the plural ("Social Sciences"); some programs
name their slots in the singular ("Social Science Requirement"). Substring
matching missed those, sending the slot to "verify manually"."""
from gc_advisor.audit.engine import _match_gen_ed

CATS = [
    {"name": "Social Sciences", "min_credits": 6},
    {"name": "Natural Sciences with Lab", "min_credits": 4},
    {"name": "Arts and Humanities", "min_credits": 6},
]


def test_singular_slot_matches_plural_category():
    assert _match_gen_ed("Social Science Requirement", CATS)["name"] == "Social Sciences"


def test_singular_slot_matches_plural_category_with_suffix():
    got = _match_gen_ed("Natural Science Requirement", CATS)
    assert got["name"] == "Natural Sciences with Lab"


def test_exact_plural_still_matches():
    assert _match_gen_ed("Social Sciences Requirement", CATS)["name"] == "Social Sciences"


def test_unrelated_slot_does_not_match():
    assert _match_gen_ed("South Carolina REACH Act Requirement", CATS) is None
