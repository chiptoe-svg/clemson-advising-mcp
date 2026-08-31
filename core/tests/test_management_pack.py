"""Sixth department pack — the last COB major. Its Support Area is the
broadest in the college: any subject at 3000+ (`@ 3000:4999`, the new
level_min wildcard) plus nine modern languages at 2000+, or a minor of at
least 15 hours. Stable across all four catalog years."""
from pathlib import Path
import pytest
from gc_advisor.audit.engine import rule_evaluator
from gc_advisor.ingest.packs import load_pack
from registrar_rules import subject_ranges

# Parsed from the committed registrar rule line — see tests/fixtures/registrar/.
REGISTRAR = "management-support-area"

PACK = Path(__file__).parent.parent / "packs" / "management"
DB = Path(__file__).parent.parent / "db" / "catalog.db"


def test_management_pack_declares_its_program():
    assert load_pack(PACK).programs == ["Management, BS"]


def test_support_area_declares_the_minor_or_course_set_evaluator():
    rule = load_pack(PACK).rules["Support Area Requirement"]
    assert rule_evaluator(rule) == "minor_or_course_set"


def test_support_area_covers_any_subject_at_3000_plus_languages_at_2000():
    """DegreeWorks' `@ 3000:4999` maps onto the level_min wildcard; each named
    language range maps onto a dept_level_min. Both sides are read from the
    registrar fixture so a pack edit that drops a language is caught."""
    wc = load_pack(PACK).rules["Support Area Requirement"]["wildcards"]
    ranges = subject_ranges(REGISTRAR)
    assert ("@", 3000) in ranges, f"registrar fixture parsed to {ranges}"
    assert {"type": "level_min", "min": 3000} in wc
    expected_langs = {s: lo for s, lo in ranges if s != "@"}
    assert len(expected_langs) == 9, f"registrar fixture parsed to {ranges}"
    got = {w["dept"]: w["min"] for w in wc if w["type"] == "dept_level_min"}
    assert got == expected_langs


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_support_area_counts_cross_college_coursework():
    """15 credits from five different subjects at 3000+ satisfies it —
    the any-subject breadth is the point."""
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    passed = [{"code": c, "credits": 3} for c in
              ["PHIL 3010", "HIST 3300", "WFB 4130", "SPAN 2010", "PSYC 3520"]]
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2026-2027",
        "program": "Management, BS", "passed": passed, "in_progress": [],
        "minor": None, "grade_checks": {}, "warnings": []}))
    sup = [i for i in out["items"] if i.get("slot_type") == "Support Area Requirement"]
    assert sup
    assert max((i.get("credits_earned") or 0) for i in sup) == 15, \
        f"cross-college 3000+ plus SPAN 2010 did not total 15: {[(i['status'], i.get('credits_earned')) for i in sup]}"


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_support_area_excludes_low_level_non_language():
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2026-2027",
        "program": "Management, BS",
        "passed": [{"code": "HIST 1010", "credits": 3}],
        "in_progress": [], "minor": None, "grade_checks": {}, "warnings": []}))
    sup = [i for i in out["items"] if i.get("slot_type") == "Support Area Requirement"]
    assert all((i.get("credits_earned") or 0) == 0 for i in sup), \
        "a 1000-level non-language course counted toward Support Area"
