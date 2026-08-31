"""The catalog's two-column page layout, and the two defects it causes.

Clemson renders the business curriculum grids in two columns. Two things leak
across the column boundary, and both produced wrong-`met` audits:

  1. A neighbouring fixed course is merged into a slot's row, so the slot parses
     as `kind='choice'` whose `one_of` is that unrelated course. `run_audit`
     satisfies a choice straight from `one_of`, so the course wrongly satisfies
     the slot. Two instances, both confirmed against DegreeWorks:
       * `South Carolina REACH Act Requirement` <- `ACCT 2010`
       * `Social Science Requirement` <- `STAT 2300` (registrar puts STAT 2300
         under DEPARTMENTAL MATHEMATICS — "1 Class in MATH 1080 or 2070 or
         STAT 2300" — and Social Sciences #2 under "3 Credits in ANTH 2010 or
         PSYC 2010 or SOC 2010". They are separate requirements; STAT 2300 was
         never an alternative to the social science.)
`parse_program` normalizes the merged cell: an artifact choice becomes a plain
slot. It does NOT collapse repeated cells — a pass that did was tried and
reverted, because on two program-years the repeat is two genuinely distinct
requirements. See the regression guards at the bottom of this file.

The normalization is not free: it drops the merged course, which usually has no
other plan cell to fall back on. That trades a wrong-`met` for an under-allow,
which is the right direction but still a real gap — see the module comment on
CHOICE_LAYOUT_ARTIFACT_SLOTS and docs/known-data-gaps.md.
"""
import pytest

from gc_advisor.ingest.parse_program import (
    CHOICE_LAYOUT_ARTIFACT_SLOTS, parse_program)

DB_PROGRAMS_2526 = ["Accounting, BS", "Economics, BS", "Financial Management, BS",
                    "Management, BS", "Marketing, BS", "Pre-Business"]


def _items(text):
    p = parse_program(text, kind="major", degree=None)
    return [it for g in p.groups for it in g.items]


def test_artifact_markers_are_the_two_confirmed_families():
    """Adding a marker here silently rewrites plans, so the set is pinned.
    Both were verified against DegreeWorks before being added; a third must be
    too. Measured on the live DB when `Social Science` was added: exactly one
    distinct choice-kind slot_type existed (`Social Science Requirement`), so
    the contains-match cannot over-reach onto an unrelated slot."""
    assert CHOICE_LAYOUT_ARTIFACT_SLOTS == ("REACH", "Social Science")


def test_merged_cell_emits_both_requirements():
    """The Accounting/Pre-Business cell: `STAT 2300 or Social Science
    Requirement`. It is ONE printed row holding TWO requirements, so it emits
    both: STAT 2300 as a real course requirement carrying the cell's credits,
    and the Social Science slot at 0 credits. STAT 2300 must NOT remain a way
    to satisfy the slot, and must NOT be discarded either."""
    text = (
        "Program Requirements\n"
        "Pre-Business Freshman Curriculum\n"
        "First Semester\n"
        "STAT 2300 - Statistical Methods I 3 Credits 3*\n\nor\n\n"
        "Social Science Requirement 3 Credits 3*, 4*\n\n"
        "Credit Hours: 3\n"
    )
    items = _items(text)
    ss = next(i for i in items if "Social Science" in (i.slot_type or ""))
    assert ss.kind == "slot", f"still parses as {ss.kind!r}"
    assert not ss.one_of, "STAT 2300 can still satisfy the slot"
    assert ss.credits == 0, "the artifact slot must not own the cell's credits"
    assert set(ss.footnote_refs) == {3, 4}

    stat = next(i for i in items if i.course_code == "STAT 2300")
    assert stat.kind == "fixed_course"
    assert stat.credits == 3, "the merged course owns the cell's credits"

    # the cell's printed arithmetic is preserved
    assert sum(i.credits or 0 for i in items) == 3
    # page order: course, then slot
    assert items.index(stat) < items.index(ss)


# --- end to end, against the live catalog DB --------------------------------

from pathlib import Path  # noqa: E402

DB = Path(__file__).parent.parent / "db" / "catalog.db"


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
@pytest.mark.parametrize("program", DB_PROGRAMS_2526)
def test_stat_2300_alone_never_satisfies_social_science(program):
    """RED against the pre-fixwave DB: STAT 2300 alone audited Social Science
    `met` for all six of these programs — a wrong-`met` on a gen-ed requirement,
    the same class as ACCT 2010 satisfying REACH.

    After normalization the slot resolves through its derived rule where one
    exists (Pre-Business carries the registrar's ANTH 2010 / PSYC 2010 /
    SOC 2010 list) or through gen-ed matching otherwise. Both are acceptable;
    what must never happen again is STAT 2300 satisfying it, since STAT 2300 is
    a DEPARTMENTAL MATHEMATICS course in the registrar's own audit.
    """
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2025-2026",
        "program": program, "passed": [{"code": "STAT 2300", "credits": 3}],
        "in_progress": [], "minor": None, "grade_checks": {}, "warnings": []}))
    ss = [i for i in out["items"] if "Social Science" in (i.get("slot_type") or "")]
    assert ss, f"{program}: no Social Science slot in the audit"
    assert all(i["status"] != "met" for i in ss), \
        f"{program}: STAT 2300 satisfied Social Science: " \
        f"{[(i['kind'], i['status'], i.get('one_of')) for i in ss]}"
    assert all(i["kind"] == "slot" for i in ss), \
        f"{program}: Social Science still parses as a choice: {ss}"


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
@pytest.mark.parametrize("program", DB_PROGRAMS_2526)
def test_registrar_social_science_courses_still_satisfy_it(program):
    """The other direction: normalization must not make the slot unsatisfiable.
    ANTH 2010 / PSYC 2010 are on the registrar's list for these programs and in
    the university-wide Social Sciences category, so they work down either path.

    Two are supplied rather than one because Accounting 2025-2026 legitimately
    carries TWO Social Science cells (footnote 3: students take a social science
    AND STAT 2300, in either order), so its derived rule totals 6 credits. Since
    STAT 2300 is correctly denied, that program needs two social sciences to
    reach `met` — an accepted under-allow of the same family as Financial
    Management 2026-2027's REACH, documented in docs/known-data-gaps.md.
    """
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2025-2026",
        "program": program, "passed": [{"code": "ANTH 2010", "credits": 3},
                                       {"code": "PSYC 2010", "credits": 3}],
        "in_progress": [], "minor": None, "grade_checks": {}, "warnings": []}))
    ss = [i for i in out["items"] if "Social Science" in (i.get("slot_type") or "")]
    assert any(i["status"] == "met" for i in ss), \
        f"{program}: ANTH 2010 did not satisfy Social Science: " \
        f"{[(i['status'], i.get('credits_earned')) for i in ss]}"


# ---------------------------------------------------------------------------
# Regression guard: normalization must never DELETE a plan cell.
#
# A dedupe pass once collapsed "repeated" artifact-family slots to the first
# occurrence, on the theory that a block printed twice was one requirement
# rendered twice. A full-catalog parse disproved it: on exactly two
# program-years the repeated cells are DISTINCT requirements, and collapsing
# them silently deleted graduation requirements.
#
#   Financial Management 2026-2027 — the freshman cell and the standalone
#     Senior/First Semester cell are both real; the page's own per-semester
#     arithmetic needs both (parsed credits fell 120 -> 117 against a declared
#     "Total Credits: 120").
#   Accounting 2025-2026 — footnote 3 says students take BOTH cells, in either
#     order: "Students who took STAT 2300 in their freshman year should select a
#     course that fulfills a general education social science requirement ...
#     Students who fulfilled a general education social science requirement in
#     their freshman year should take STAT 2300." An ordering choice, not a
#     duplicate print (parsed credits fell 114 -> 111).
#
# Deleting a requirement row is the DANGEROUS error direction — a student is
# told they can graduate when they cannot. An over-strict slot is the safe
# direction: it under-allows to "unmet, see advisor". These parse the frozen,
# committed source pages, so they run on a fresh clone with no DB.
# ---------------------------------------------------------------------------

RAW = Path(__file__).parent.parent / "data" / "raw"


def _parse_page(rel: str):
    return parse_program((RAW / rel).read_text(), kind="major", degree=None)


def test_fm_2627_keeps_acct_2010_both_reach_cells_and_its_arithmetic():
    """The full invariant for FM 2026-2027's plan. Three things must hold at
    once, and each has been broken by a different past attempt:

      * ACCT 2010 is a REAL requirement of its own — the What-If states
        "Financial Accounting Concepts (3 Cr) Still needed: 1 Class in
        ACCT 2010". It appears exactly ONCE on the page, inside the merged
        "ACCT 2010 ... or ... REACH" cell, so the first normalization (which
        dropped the merged course) deleted the requirement outright.
      * BOTH REACH cells survive — the freshman one and the standalone
        Senior/First Semester one. The reverted dedupe deleted the senior cell.
      * The page's own arithmetic still balances at its declared 120. This is
        the objective check on the emit-both split: the merged course carries
        the cell's credits and the artifact slot carries 0, so the group sums
        are unchanged. Dropping a cell made this 117.
    """
    prog = _parse_page("2026-2027/16764.txt")
    items = [(g.label, i) for g in prog.groups for i in g.items]

    acct = [(l, i) for l, i in items if i.course_code == "ACCT 2010"]
    assert acct, "FM lost its ACCT 2010 requirement — the merged course was dropped"
    assert all(i.kind == "fixed_course" for _, i in acct), \
        f"ACCT 2010 must be a requirement in its own right: {[i.kind for _, i in acct]}"
    assert sum(i.credits or 0 for _, i in acct) == 3, \
        "ACCT 2010 must carry the merged cell's credits"

    reach = [(l, i) for l, i in items if "REACH" in (i.slot_type or "")]
    assert len(reach) == 2, \
        f"a REACH cell was deleted: {[(l, i.credits) for l, i in reach]}"
    assert any(l.startswith("Senior") for l, _ in reach), \
        f"the standalone senior REACH cell is gone: {[l for l, _ in reach]}"
    # the merged cell's slot carries 0; the standalone block cell carries 3
    assert sorted(i.credits or 0 for _, i in reach) == [0, 3], \
        f"artifact-slot credit split is wrong: {[(l, i.credits) for l, i in reach]}"

    assert sum(i.credits or 0 for _, i in items) == prog.total_credits == 120


def test_accounting_2526_keeps_both_social_science_cells():
    """Both cells are real (footnote 3, above). Credit totals are NOT asserted
    here: this page already parses to 114 against a declared 120, a
    pre-existing gap unrelated to this guard, and pinning it would make the
    test fail for the wrong reason."""
    prog = _parse_page("2025-2026/14953.txt")
    items = [(g.label, i) for g in prog.groups for i in g.items]
    ss = [(l, i) for l, i in items if "Social Science" in (i.slot_type or "")]
    assert len(ss) == 2, f"a Social Science cell was deleted: {[l for l, _ in ss]}"
    assert len({l for l, _ in ss}) == 2, \
        f"both cells collapsed into one term group: {[l for l, _ in ss]}"
    assert all(i.kind == "slot" and not i.one_of for _, i in ss), \
        "cells must remain normalized slots, just not deleted"
    # STAT 2300 is the merged course and a real DEPARTMENTAL MATHEMATICS
    # requirement; emit-both restores it rather than dropping it.
    stat = [i for _, i in items if i.course_code == "STAT 2300"]
    assert stat, "Accounting lost its STAT 2300 requirement"
    assert all(i.kind == "fixed_course" for i in stat)


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
@pytest.mark.parametrize("program", DB_PROGRAMS_2526)
def test_zero_credit_artifact_slot_is_never_met_by_an_empty_transcript(program):
    """A 0-credit artifact slot must still require a course.

    The emit-both split gives the artifact slot 0 credits (the merged course
    owns the cell's credits). The gen-ed branch tested `earned >= slot_need`,
    which for a 0-credit slot is `0 >= 0` — TRUE for a student who has taken
    nothing at all. Three programs audited Social Science `met` on an empty
    transcript. The rule path already had this right (`bool(counted)` when the
    need is falsy); the gen-ed path now matches it.

    This is the wrong-`met` class the whole artifact effort exists to kill, so
    it is pinned for every affected program rather than spot-checked.
    """
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2025-2026",
        "program": program, "passed": [], "in_progress": [],
        "minor": None, "grade_checks": {}, "warnings": []}))
    ss = [i for i in out["items"] if "Social Science" in (i.get("slot_type") or "")]
    assert ss, f"{program}: no Social Science slot in the audit"
    assert all(i["status"] != "met" for i in ss), \
        f"{program}: empty transcript satisfied Social Science: " \
        f"{[(i['status'], i.get('credits_earned'), i.get('gen_ed_category')) for i in ss]}"
