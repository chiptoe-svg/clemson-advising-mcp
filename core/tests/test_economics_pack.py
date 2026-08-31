"""Fifth department pack. Two registrar rules the catalog cannot derive
(docs/degreeworks/freshman_economics_bs_*.md, blank What-Ifs):

- Major Requirement II: `12 Credits in ECON 3160:4999 Except ECON 3990` —
  a range with an exclusion, expressible as dept_level_min + a deny
  subject_pattern (denies are checked before allows in wildcards.counts).
- Support Area (2025-26+): minor OR 15 credits at 3000+ within a SINGLE
  course prefix. The minor path routes via the evaluator; the single-prefix
  course path is a vocabulary gap (no wildcard can say "any one prefix"),
  documented in known-data-gaps — it under-allows to "see advisor".

2023-24/2024-25 instead REQUIRE a minor as a top-level degree block (no
Support Area slot exists those years, so the pack rule matches nothing there
— correct, and the requirement itself is advising-skill material)."""
from pathlib import Path
import pytest
from gc_advisor.audit.engine import rule_evaluator
from gc_advisor.ingest.packs import load_pack
from registrar_rules import excluded_courses, subject_ranges

# Parsed from the committed registrar rule line — see tests/fixtures/registrar/.
REGISTRAR = "economics-major-requirement"

PACK = Path(__file__).parent.parent / "packs" / "economics"
DB = Path(__file__).parent.parent / "db" / "catalog.db"


def test_economics_pack_covers_both_degrees():
    """One DEPARTMENT pack, two programs — the BA shares the BS's Major
    Requirement structure (names swapped: the BA's 15cr range slot is
    MAJOR REQUIREMENT I), so the same rules apply to both."""
    assert load_pack(PACK).programs == ["Economics, BS", "Economics, BA"]


def test_major_requirement_covers_the_range_and_excludes_3990():
    """`12 Credits in ECON 3160:4999 Except ECON 3990` — the range becomes a
    dept_level_min and the exclusion a deny subject_pattern (denies are checked
    before allows). Both read from the registrar fixture."""
    wc = load_pack(PACK).rules["Major Requirement"]["wildcards"]
    assert subject_ranges(REGISTRAR) == {("ECON", 3160)}
    assert excluded_courses(REGISTRAR) == {"ECON 3990"}
    for dept, low in subject_ranges(REGISTRAR):
        assert {"type": "dept_level_min", "dept": dept, "min": low} in wc
    for code in excluded_courses(REGISTRAR):
        dept, num = code.split()
        assert {"type": "subject_pattern", "subject": dept,
                "number_glob": num, "allow": False} in wc


def test_support_area_declares_the_minor_or_course_set_evaluator():
    rule = load_pack(PACK).rules["Support Area Requirement"]
    assert rule_evaluator(rule) == "minor_or_course_set"


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_major_requirement_counts_range_courses_but_never_econ_3990():
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit

    def counted(codes):
        out = run_audit(str(DB), Progress.from_dict({
            "version": "gc-progress-v1", "catalog_year": "2026-2027",
            "program": "Economics, BS",
            "passed": [{"code": c, "credits": 3} for c in codes],
            "in_progress": [], "minor": None, "grade_checks": {}, "warnings": []}))
        # same-named slots each report the shared rule's earned total until
        # credits are consumed on met — take the max, not the sum
        return max((i.get("credits_earned") or 0 for i in out["items"]
                    if i.get("slot_type") == "Major Requirement"), default=0)

    assert counted(["ECON 3200", "ECON 4700"]) == 6, \
        "in-range ECON courses did not count toward Major Requirement"
    assert counted(["ECON 3990"]) == 0, \
        "registrar-excluded ECON 3990 counted toward Major Requirement"


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_ba_major_requirement_counts_range_and_denies_3990():
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit

    def counted(codes):
        out = run_audit(str(DB), Progress.from_dict({
            "version": "gc-progress-v1", "catalog_year": "2026-2027",
            "program": "Economics, BA",
            "passed": [{"code": c, "credits": 3} for c in codes],
            "in_progress": [], "minor": None, "grade_checks": {}, "warnings": []}))
        return max((i.get("credits_earned") or 0 for i in out["items"]
                    if i.get("slot_type") == "Major Requirement"), default=0)

    assert counted(["ECON 3200", "ECON 4700"]) == 6
    assert counted(["ECON 3990"]) == 0


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_support_area_minor_path_routes():
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2026-2027",
        "program": "Economics, BS", "passed": [], "in_progress": [],
        "minor": {"name": "Accounting Minor", "complete": True},
        "grade_checks": {}, "warnings": []}))
    slots = [i for i in out["items"] if i.get("slot_type") == "Support Area Requirement"]
    assert any(i.get("via") == "minor" and i.get("status") == "met" for i in slots)


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_ba_minor_requirement_is_satisfied_by_a_declared_minor():
    """The BA requires a declared minor (all four years). With one declared
    and complete, the Minor Requirement slots must route via the minor path
    instead of falling to manual."""
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2026-2027",
        "program": "Economics, BA", "passed": [], "in_progress": [],
        "minor": {"name": "Accounting Minor", "complete": True},
        "grade_checks": {}, "warnings": []}))
    slots = [i for i in out["items"] if i.get("slot_type") == "Minor Requirement"]
    assert slots
    assert any(i.get("via") == "minor" and i.get("status") == "met" for i in slots), \
        f"declared minor did not satisfy Minor Requirement: {[(i['status'], i.get('via')) for i in slots]}"
