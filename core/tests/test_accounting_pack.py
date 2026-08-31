"""Third department pack. Accounting's Business Requirement slots (6 Cr plus
the internship-or-business 3 Cr alternative) are pure subject ranges in the
registrar's rule — ECON/ELE/FIN/LAW/ACCT/MGT/MKT at 3000:4999, per the blank
What-If (docs/degreeworks/freshman_accounting_blank_2627cleaned.md) — which
footnote derivation cannot extract, so they audited as `manual`. The
ACCT 3990 internship alternative is inside ACCT 3000:4999, so one wildcard
set covers both slots."""
from pathlib import Path
import pytest
from gc_advisor.ingest.packs import load_pack
from registrar_rules import subject_ranges

PACK = Path(__file__).parent.parent / "packs" / "accounting"
DB = Path(__file__).parent.parent / "db" / "catalog.db"

# Parsed from the committed 2023-24 registrar rule line, which carries the 6
# subjects shared by every catalog year. 2026-27 adds MKT, which the
# year-unscoped pack deliberately omits (under-allow beats over-allow) — see
# docs/known-data-gaps.md. Reading it from the fixture rather than hardcoding
# makes pack<->registrar drift testable on a fresh checkout.
REGISTRAR = "accounting-business-requirement"


def test_accounting_pack_declares_its_program():
    assert load_pack(PACK).programs == ["Accounting, BS"]


def test_business_requirement_uses_registrar_subject_ranges():
    rule = load_pack(PACK).rules["Business Requirement"]
    got = {(w["dept"], w["min"]) for w in rule["wildcards"]
           if w["type"] == "dept_level_min"}
    expected = subject_ranges(REGISTRAR)
    assert len(expected) == 6, f"registrar fixture parsed to {expected}"
    assert got == expected


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_business_requirement_no_longer_audits_as_manual():
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    passed = [{"code": c, "credits": 3} for c in
              ["ECON 3100", "FIN 3050", "LAW 3400"]]
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2026-2027",
        "program": "Accounting, BS", "passed": passed, "in_progress": [],
        "minor": None, "grade_checks": {}, "warnings": []}))
    biz = [i for i in out["items"] if i.get("slot_type") == "Business Requirement"]
    assert biz, "no Business Requirement slots in the audit"
    assert all(i["status"] != "manual" for i in biz), \
        f"still manual: {[(i['status'], i.get('credits_earned')) for i in biz]}"
    assert sum(i.get("credits_earned") or 0 for i in biz) > 0


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_reach_is_not_satisfied_by_the_misderived_acct_course():
    """Accounting's catalog footnote mis-associates ACCT 4100 with the REACH
    slot, and the page's two-column layout merged ACCT 2010 into the REACH row
    as a bogus `one_of`. The registrar's rule (blank What-If) is HIST 1010 /
    POSC 1010 / POSC 1030.

    This was xfail-pinned while REACH parsed as a course-or-slot choice, since
    choice items read neither rules nor advisor sets and no pack could reach
    them. It now passes for real: parse_program normalizes a REACH choice back
    to a plain slot, requirement_rules.DERIVATION_SKIP refuses to derive the
    mis-associated footnote courses, and packs/reach-act/ supplies the
    registrar's three. Cross-program coverage lives in tests/test_reach_act.py.
    """
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit

    def reach_status(codes):
        out = run_audit(str(DB), Progress.from_dict({
            "version": "gc-progress-v1", "catalog_year": "2026-2027",
            "program": "Accounting, BS",
            "passed": [{"code": c, "credits": 3} for c in codes],
            "in_progress": [], "minor": None, "grade_checks": {}, "warnings": []}))
        slots = [i for i in out["items"] if "REACH" in (i.get("slot_type") or "")]
        assert slots, "no REACH slot in audit"
        return [s["status"] for s in slots]

    assert "met" not in reach_status(["ACCT 4100"]), \
        "mis-derived ACCT 4100 still satisfies REACH"
    assert "met" not in reach_status(["ACCT 2010"]), \
        "the two-column layout artifact ACCT 2010 still satisfies REACH"
    # The REACH courses are also university-wide Social Sciences, and REACH is
    # a degree-level block our waterfall models as a plan slot, so an earlier
    # Social Science slot consumes a lone HIST 1010 before REACH is reached.
    # Satisfy that slot from the catalog's narrow list first — see
    # tests/test_reach_act.py::test_registrar_courses_satisfy_reach.
    assert "met" in reach_status(["ANTH 2010", "PSYC 2010", "HIST 1010"]), \
        "registrar-listed HIST 1010 does not satisfy REACH"
