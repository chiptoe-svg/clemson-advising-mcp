"""A second department pack, proving the format is not GC-shaped.

Marketing's Support Course Requirement derived from the catalog with 15
required credits, no courses and no wildcards for 2024-25..2026-27 — nothing
could ever satisfy it. Its footnote offers a minor/certificate OR a course
set, but says "choose ONE" where requirement_rules.py's heuristic needs
"select one", so satisfy_one_of was never set either.

The subject list here is the REGISTRAR'S, read from four DegreeWorks What-If
audits (docs/degreeworks/freshman_marketing_*.md, gitignored): 18 subjects,
identical across 2024-25..2026-27, and it is PSYC — the catalog footnote's
PYSC is a typo. Known limitation, documented in docs/known-data-gaps.md: the
registrar splits the 15 credits into 12 at 3000:4999 plus 3 at a lower level,
which no wildcard type can express, so this pack over-admits low-level
credits; the audit flags rather than hides that.
"""
from pathlib import Path
import pytest
from gc_advisor.audit.engine import rule_evaluator
from gc_advisor.ingest.packs import load_pack
from registrar_rules import subjects

PACK = Path(__file__).parent.parent / "packs" / "marketing"
DB = Path(__file__).parent.parent / "db" / "gc_advisor.db"

# Parsed from the committed registrar rule line rather than hardcoded here, so
# pack<->registrar drift is detectable on a fresh checkout (the DegreeWorks
# audits themselves are gitignored). See tests/fixtures/registrar/.
REGISTRAR = "marketing-support-area"


def test_marketing_pack_declares_its_program():
    assert load_pack(PACK).programs == ["Marketing, BS"]


def test_support_area_declares_the_minor_or_course_set_evaluator():
    rule = load_pack(PACK).rules["Support Course Requirement"]
    assert rule_evaluator(rule) == "minor_or_course_set"


def test_support_area_allows_exactly_the_registrar_subjects():
    """The pack's dept_any set must equal the registrar's subject list —
    18 subjects, PSYC (the catalog footnote's PYSC is a typo). Level is not
    compared: the registrar's 3000:4999 split is not expressible as a
    wildcard, a documented over-admission."""
    rule = load_pack(PACK).rules["Support Course Requirement"]
    depts = {w["dept"] for w in rule["wildcards"] if w["type"] == "dept_any"}
    expected = subjects(REGISTRAR)
    assert len(expected) == 18, f"registrar fixture parsed to {expected}"
    assert depts == expected


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_support_area_counts_real_coursework_after_the_pack_is_applied():
    """15 credits of registrar-listed 3000-level coursework satisfies the
    support area for 2026-2027 (previously: nothing could)."""
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    passed = [{"code": c, "credits": 3} for c in
              ["ANTH 3010", "PHIL 3020", "SOC 3510", "PSYC 3090", "STAT 4110"]]
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2026-2027",
        "program": "Marketing, BS", "passed": passed, "in_progress": [],
        "minor": None, "grade_checks": {}, "warnings": []}))
    support = [i for i in out["items"]
               if i.get("slot_type") == "Support Course Requirement"]
    assert support, "no Support Course Requirement slot in the audit"
    assert any((i.get("credits_earned") or 0) > 0 for i in support), \
        "listed-subject coursework counted zero credits toward the support area"


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_support_area_minor_path_routes_after_the_pack_is_applied():
    """The registrar's Option 1 (declare a minor/certificate) must route
    through the minor path, not the credit-set path."""
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2026-2027",
        "program": "Marketing, BS", "passed": [], "in_progress": [],
        "minor": {"name": "Accounting Minor", "complete": True},
        "grade_checks": {}, "warnings": []}))
    support = [i for i in out["items"]
               if i.get("slot_type") == "Support Course Requirement"]
    assert any(i.get("via") == "minor" and i.get("status") == "met"
               for i in support), \
        "a completed minor did not satisfy the support area via the minor path"
