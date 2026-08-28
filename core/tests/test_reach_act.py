"""The SC REACH Act course path, enforced for every program that carries the slot.

Registrar truth (DegreeWorks blank What-If,
docs/degreeworks/freshman_accounting_blank_2627cleaned.md line 27 — mirrored
into tests/fixtures/registrar/reach-act.txt so this is testable off the
machine that holds the gitignored record derivatives):

    SC REACH ACT REQUIREMENT Still needed: 3 Credits in HIST 1010 or POSC 1010 or 1030

Two catalog-page artifacts used to break this in opposite directions, and
both are guarded here:

  * WRONG-MET — the two-column catalog layout merged an adjacent fixed course
    into the REACH row, so business pages parsed REACH as
    `kind='choice', one_of=['ACCT 2010']`. A choice is satisfied by its
    one_of, so a student holding ACCT 2010 audited REACH as MET.
  * WRONG-MET (again) — footnote mis-association derived `explicit_courses`
    for the REACH slot from whatever prose sat beside it (Pre-Business got 15
    business courses including ACCT 2010; Accounting got ACCT 4100).

The fix is threefold: a derivation skip-list for REACH slot types
(ingest/requirement_rules.py), parser normalization of a REACH choice back to
a plain slot (ingest/parse_program.py), and one shared pack (packs/reach-act/)
carrying the registrar's three courses.

NOT covered (documented REACH redesign, docs/known-data-gaps.md): the
exemption path (AP/IB/dual enrollment) and the 3-credit spillover into
Required Electives when exempt. This makes the COURSE path correct.
"""
import json
import sqlite3
from pathlib import Path

import pytest

from registrar_rules import course_options

ROOT = Path(__file__).parent.parent
DB = ROOT / "db" / "gc_advisor.db"

pytestmark = pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")


def _reach_program_years() -> list[tuple[str, str]]:
    """Every (year, program) whose PLAN carries a REACH slot — query-driven so
    a newly ingested program or catalog year is covered automatically rather
    than needing this list edited."""
    if not DB.exists():
        return []
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return [tuple(r) for r in con.execute(
            "SELECT DISTINCT cy.label, p.name FROM plan_item pi "
            "JOIN requirement_group g ON pi.group_id=g.id "
            "JOIN program p ON g.program_id=p.id "
            "JOIN catalog_year cy ON p.catalog_year_id=cy.id "
            "WHERE pi.slot_type LIKE '%REACH%' ORDER BY cy.label, p.name")]
    finally:
        con.close()


CASES = _reach_program_years()


def _reach_items(year: str, program: str, codes: list[str]) -> list[dict]:
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": year, "program": program,
        "passed": [{"code": c, "credits": 3} for c in codes],
        "in_progress": [], "minor": None, "grade_checks": {}, "warnings": []}))
    items = [i for i in out["items"] if "REACH" in (i.get("slot_type") or "")]
    assert items, f"no REACH item in the {year} {program} audit"
    return items


def test_reach_cases_exist():
    """Guard against a vacuous suite: an empty parametrisation would make
    every case below silently pass."""
    assert len(CASES) >= 8, f"expected REACH slots across the college, got {CASES}"


def test_registrar_fixture_names_the_three_courses():
    """The pack must carry exactly the registrar's option set, parsed from the
    committed rule line rather than restated here — so a pack edit that drops
    or invents a course fails on a fresh checkout, where the DegreeWorks
    sources themselves are unavailable."""
    import tomllib
    expected = set(course_options("reach-act"))
    assert expected == {"HIST 1010", "POSC 1010", "POSC 1030"}
    rule = tomllib.loads(
        (ROOT / "packs" / "reach-act" / "rules" / "reach-act.toml").read_text())
    assert set(rule["explicit_courses"]) == expected


@pytest.mark.parametrize("year,program", CASES)
def test_reach_rule_matches_the_registrar(year, program):
    """The most direct assertion, and the waterfall-independent one: every
    program-year whose plan carries the slot must serve a REACH rule listing
    exactly the registrar's three courses. Read through the ACCESS layer, so
    this also proves the rule survives the bogus-rule filter and is what
    `scripts/query.py` and CUassistant's MCP tools see — not merely what the
    audit happens to use internally."""
    from gc_advisor.db.access import CatalogAccess
    rules = {r["slot_type"]: r["rule"]
             for r in CatalogAccess(str(DB)).get_requirement_rules(year, program)}
    reach = [v for k, v in rules.items() if "REACH" in k]
    assert reach, f"{year} {program}: no REACH rule served by the access layer"
    for rule in reach:
        assert set(rule["explicit_courses"]) == {"HIST 1010", "POSC 1010", "POSC 1030"}, \
            f"{year} {program}: REACH rule is {rule['explicit_courses']}"


@pytest.mark.parametrize("year,program", CASES)
def test_registrar_courses_satisfy_reach(year, program):
    """The registrar's courses must actually satisfy REACH in a real audit.

    This student holds the three narrow social sciences the business catalogs
    list (ANTH 2010 / PSYC 2010 / SOC 2010), ECON 2110, and TWO registrar REACH
    courses. Both extras isolate REACH from gaps that are documented in
    docs/known-data-gaps.md and deliberately OUT OF SCOPE here, rather than
    weakening the assertion:

      * HIST 1010, POSC 1010 and POSC 1030 are ALSO in the university-wide
        Social Sciences gen-ed category, in every catalog year. DegreeWorks
        double-counts them because SC REACH ACT REQUIREMENT is a degree-level
        BLOCK beside the major, not a cell inside its allocation; our engine
        allocates by waterfall, so a lone HIST 1010 is eaten by an earlier
        Social Science slot and never reaches REACH. Satisfying those slots
        from the narrow list frees it.
      * Financial Management 2026-2027 prints the same REACH block TWICE (the
        Pre-Business freshman cell and Senior/First Semester), so its plan sums
        to 6 credits for one 3-credit requirement — hence two REACH courses.

    `any`, not `all`, for that same duplicate-slot reason.
    """
    items = _reach_items(year, program,
                         ["ANTH 2010", "PSYC 2010", "SOC 2010", "ECON 2110",
                          "HIST 1010", "POSC 1010"])
    assert any(i["status"] == "met" for i in items), \
        f"{year} {program}: registrar REACH courses did not satisfy REACH: " \
        f"{[(i['status'], i.get('credits_earned')) for i in items]}"


@pytest.mark.parametrize("year,program", CASES)
def test_acct_2010_alone_never_satisfies_reach(year, program):
    """ACCT 2010 is the two-column layout artifact, not a REACH course. It is
    separately a real fixed course on the same pages, so nothing is lost by
    refusing it here."""
    items = _reach_items(year, program, ["ACCT 2010"])
    assert all(i["status"] != "met" for i in items), \
        f"{year} {program}: ACCT 2010 satisfied REACH: " \
        f"{[(i['status'], i.get('one_of'), i.get('counted_courses')) for i in items]}"


def test_no_derived_reach_rule_carries_footnote_courses():
    """The derivation skip-list must leave no REACH rule whose explicit
    courses came from adjacent footnote prose (Pre-Business once carried 15
    business courses; Accounting carried ACCT 4100)."""
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT cy.label, p.name, rr.rule FROM requirement_rule rr "
            "JOIN program p ON rr.program_id=p.id "
            "JOIN catalog_year cy ON p.catalog_year_id=cy.id "
            "WHERE rr.slot_type LIKE '%REACH%'").fetchall()
    finally:
        con.close()
    assert rows, "no REACH rules at all — the shared pack did not apply"
    bad = [(y, n, json.loads(r)["explicit_courses"]) for y, n, r in rows
           if set(json.loads(r)["explicit_courses"]) !=
           {"HIST 1010", "POSC 1010", "POSC 1030"}]
    assert not bad, f"REACH rules with non-registrar courses: {bad}"


def test_financial_management_2627_reach_is_satisfied_by_one_course():
    """FM 2026-2027 exercises the whole artifact design at once.

    Its page prints REACH twice: once merged into a freshman cell with
    ACCT 2010, and once as a standalone Senior/First Semester cell. Both are
    real, so neither may be deleted (an earlier dedupe pass deleted the senior
    one and took the parsed plan to 117 against a declared 120). The merged
    cell splits into ACCT 2010 as a course requirement carrying the cell's 3
    credits plus a REACH slot at 0; the standalone cell keeps its 3. The pack
    rule therefore totals 0 + 3 = 3 — the registrar's figure — so ONE REACH
    course satisfies it.

    Before the emit-both split this rule totalled 6 (both cells' credits, with
    ACCT 2010 discarded) and one REACH course audited `unmet`. That
    under-allow is now closed, and FM's ACCT 2010 requirement is back.
    """
    from gc_advisor.db.access import CatalogAccess
    rules = {r["slot_type"]: r["rule"] for r in
             CatalogAccess(str(DB)).get_requirement_rules(
                 "2026-2027", "Financial Management, BS")}
    reach_rule = next(v for k, v in rules.items() if "REACH" in k)
    assert reach_rule["total_credits"] == 3, \
        "0 (merged cell) + 3 (standalone cell) must equal the registrar's 3"
    assert set(reach_rule["explicit_courses"]) == {"HIST 1010", "POSC 1010",
                                                  "POSC 1030"}

    # the layout artifact must never satisfy it
    assert all(i["status"] != "met" for i in
               _reach_items("2026-2027", "Financial Management, BS", ["ACCT 2010"])), \
        "ACCT 2010 satisfied FM's REACH"

    # ONE registrar course now suffices (social sciences supplied first so the
    # documented waterfall gap does not consume it — see
    # test_registrar_courses_satisfy_reach)
    one = _reach_items("2026-2027", "Financial Management, BS",
                       ["ANTH 2010", "PSYC 2010", "SOC 2010", "ECON 2110",
                        "HIST 1010"])
    assert len(one) == 2, f"a REACH plan cell was deleted: {len(one)}"
    assert any(i["status"] == "met" for i in one), \
        f"one registrar REACH course did not satisfy REACH: " \
        f"{[(i['status'], i.get('credits_earned')) for i in one]}"


def test_merged_only_reach_slot_totals_zero_and_takes_one_course():
    """The five 2026-2027 business majors whose ONLY REACH occurrence is the
    merged cell. Their REACH slot carries 0 credits, so the pack rule totals 0
    — and a 0-credit credit_set rule is satisfied by any one course it lists
    (`bool(counted)`), which is the correct reading of a degree block the
    catalog page never sized. SUM=0 is not NULL, so apply_pack's NULL guard
    does not fire.

    Both directions are pinned: a registrar course satisfies it, the layout
    artifact ACCT 2010 does not.
    """
    from gc_advisor.db.access import CatalogAccess
    programs = ["Marketing, BS", "Accounting, BS", "Management, BS",
                "Economics, BS", "Pre-Business"]
    narrow = ["ANTH 2010", "PSYC 2010", "SOC 2010", "ECON 2110"]
    for program in programs:
        rules = {r["slot_type"]: r["rule"] for r in
                 CatalogAccess(str(DB)).get_requirement_rules("2026-2027", program)}
        rule = next(v for k, v in rules.items() if "REACH" in k)
        assert rule["total_credits"] == 0, \
            f"{program}: merged-only REACH slot should total 0, got " \
            f"{rule['total_credits']}"
        got = _reach_items("2026-2027", program, narrow + ["HIST 1010"])
        assert any(i["status"] == "met" for i in got), \
            f"{program}: one registrar course did not satisfy a 0-credit REACH: " \
            f"{[(i['status'], i.get('credits_earned')) for i in got]}"
        bad = _reach_items("2026-2027", program, narrow + ["ACCT 2010"])
        assert all(i["status"] != "met" for i in bad), \
            f"{program}: ACCT 2010 satisfied a 0-credit REACH: " \
            f"{[(i['status'], i.get('counted_courses')) for i in bad]}"
