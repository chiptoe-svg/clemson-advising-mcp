"""
NOTE: fixtures carry raw_text because is_bogus_rule only judges the
DERIVED/pack rule schema; prose rules (no raw_text) are a different contract
and are never judged (see rule_semantics.is_bogus_rule).
Bogus requirement_rule filtering, at the ACCESS layer.

Two findings from the 2026-08-25 pre-handoff review, fixed together:

  I1  The catalog footnote mis-association that produces UNSATISFIABLE rules
      also produces WRONG-COURSE ones. Management, BS 2025-2026 derived
      `Natural Science Requirement -> explicit_courses: ["MGT 4150"]` and
      `Oral Communication Requirement -> ["MGT 4150"]` (the residency footnote
      sitting beside those rows in the catalog's two-column layout). Those do
      not merely fail to be satisfiable — they ASSERT a false requirement, and
      because `run_audit` gives `slot_type in rules` absolute priority over
      gen-ed matching, they shadow the gen-ed category that would have
      answered correctly. The old `_vacuous` check only caught rules with NO
      courses, so it missed every one of these.

  I2  The filter lived in `engine.run_audit`, but `access.get_requirement_rules`
      — the surface behind `scripts/query.py` and CUassistant's MCP tools —
      returned everything unfiltered. The two entry points disagreed about
      what a program requires. The filter now lives once, in the access layer,
      so every consumer sees the same rule set.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from gc_advisor.audit.rule_semantics import is_bogus_rule

ROOT = Path(__file__).parent.parent
DB = ROOT / "db" / "catalog.db"

CATS = [
    {"name": "Natural Sciences with Lab", "allowed_courses": ["CH 1010", "BIOL 1030"]},
    {"name": "Social Sciences", "allowed_courses": ["ANTH 2010", "PSYC 2010"]},
]


# --- tier 1: vacuous (pre-existing behaviour, moved) ------------------------

def test_vacuous_rule_is_bogus():
    assert is_bogus_rule("Natural Science Requirement",
                         {"total_credits": 4, "explicit_courses": [], "raw_text": "footnote text"}, CATS)


def test_vacuous_rule_is_rescued_by_a_curated_advisor_course():
    """A pack's advisor allow-list is exactly what makes an otherwise-empty
    rule real — which is why the filter runs AFTER the advisor merge."""
    assert not is_bogus_rule(
        "Natural Science Requirement",
        {"total_credits": 4, "explicit_courses": [], "advisor_courses": ["CH 1010"], "raw_text": "footnote text"},
        CATS)


def test_vacuous_rule_is_rescued_by_wildcards():
    assert not is_bogus_rule(
        "Natural Science Requirement",
        {"total_credits": 4, "explicit_courses": [],
         "wildcards": [{"type": "dept_any", "dept": "CH"}]}, CATS)


# --- tier 2: gen-ed shadow (new) -------------------------------------------

def test_gen_ed_slot_whose_courses_are_wholly_disjoint_is_bogus():
    """The motivating case: Management 2025-2026's Natural Science
    Requirement = ["MGT 4150"], a management course."""
    assert is_bogus_rule("Natural Science Requirement",
                         {"total_credits": 4, "explicit_courses": ["MGT 4150"], "raw_text": "footnote text"}, CATS)


def test_gen_ed_slot_that_narrows_its_category_is_kept():
    """A legitimately NARROWER registrar list (Pre-Business's Social Science:
    ANTH 2010 / PSYC 2010 / SOC 2010) intersects the category and must
    survive — this is the discriminator that keeps the filter conservative."""
    assert not is_bogus_rule(
        "Social Science Requirement",
        {"total_credits": 3,
         "explicit_courses": ["ANTH 2010", "PSYC 2010", "SOC 2010"], "raw_text": "footnote text"}, CATS)


def test_non_gen_ed_slot_with_odd_courses_is_kept():
    """Only gen-ed-shadowing is judged here. A major slot's course list may
    look arbitrary and still be right; there is no category to check it
    against, so the filter leaves it alone."""
    assert not is_bogus_rule("Emphasis Area Requirement",
                             {"total_credits": 12, "explicit_courses": ["MGT 4150"], "raw_text": "footnote text"},
                             CATS)


def test_specialty_routed_rule_is_never_bogus():
    """Only credit_set rules are judged; minor_or_course_set rules have their
    own evaluator and an empty course list is normal for them."""
    assert not is_bogus_rule(
        "Support Area Requirement",
        {"total_credits": 15, "explicit_courses": [],
         "evaluator": "minor_or_course_set", "raw_text": "footnote text"}, CATS)


# --- end to end -------------------------------------------------------------

@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_management_natural_science_is_met_via_gen_ed_not_shadowed():
    """RED before the fix: the ["MGT 4150"] rule shadowed the gen-ed category,
    so this student audited Natural Science `unmet` with credits_earned 0
    while holding a real 4-credit lab science. GREEN: the bogus rule is
    dropped and the slot falls through to gen-ed matching."""
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2025-2026",
        "program": "Management, BS",
        "passed": [{"code": "ANTH 2010", "credits": 3},
                   {"code": "CH 1010", "credits": 4}],
        "in_progress": [], "minor": None, "grade_checks": {}, "warnings": []}))
    ns = [i for i in out["items"]
          if i.get("slot_type") == "Natural Science Requirement"]
    assert ns, "no Natural Science Requirement slot in the audit"
    assert any(i["status"] == "met" for i in ns), \
        f"lab science did not satisfy Natural Science: " \
        f"{[(i['status'], i.get('credits_earned'), i.get('gen_ed_category')) for i in ns]}"
    assert any(i.get("gen_ed_category") for i in ns), \
        "slot was not resolved through gen-ed matching"


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_query_cli_no_longer_reports_the_bogus_management_rules():
    """I2: the CLI reads the access layer, so it must agree with the audit.
    Before the fix `req-rules` listed Natural Science and Oral Communication
    as requiring MGT 4150 — a requirement the audit itself refused to honour
    and the registrar never stated."""
    out = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "query.py"), "req-rules",
         "--year", "2025-2026", "--name", "Management, BS"],
        capture_output=True, text=True, check=True,
        env={"PYTHONPATH": str(ROOT / "src"), "PATH": "/usr/bin:/bin"})
    slots = {r["slot_type"] for r in json.loads(out.stdout)}
    assert "Natural Science Requirement" not in slots
    assert "Oral Communication Requirement" not in slots
    # ... while the real, pack-authored rule for the same program survives.
    assert "Support Area Requirement" in slots
