import json
from pathlib import Path
import pytest
from gc_advisor.audit.models import PassedCourse, Progress
from gc_advisor.audit.engine import run_audit
from gc_advisor.db.connection import init_db, get_connection

DB = Path(__file__).parent.parent / "db" / "catalog.db"
pytestmark = pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")


def _run(fixture, fixtures_dir):
    d = json.loads((fixtures_dir / fixture).read_text())
    return run_audit(str(DB), Progress.from_dict(d))


def _seed_engine_db(tmp_path):
    """Build a minimal from-scratch catalog DB (init_db + direct SQL, matching
    the `_seed` pattern used in test_access.py / test_requirement_rules.py)
    covering: a GC Technical Requirement slot with a subject_nonrequired
    wildcard, and a fixed_course with a coreq_parsed value — the two pieces
    of engine wiring under test here."""
    db = tmp_path / "t.db"
    init_db(db)
    con = get_connection(db)
    con.execute("INSERT INTO catalog_year(label, catoid) VALUES(?,?)", ("2026-2027", 1))
    cy = con.execute("SELECT id FROM catalog_year WHERE label=?", ("2026-2027",)).fetchone()["id"]
    con.execute(
        "INSERT INTO program(catalog_year_id, poid, name, kind, degree, total_credits, description) "
        "VALUES(?,?,?,?,?,?,?)",
        (cy, 1, "Graphic Communications, BS", "major", "BS", 9, ""))
    pid = con.execute("SELECT id FROM program WHERE catalog_year_id=? AND poid=?",
                      (cy, 1)).fetchone()["id"]
    gcur = con.execute(
        "INSERT INTO requirement_group(program_id, label, kind, credit_total, ordering) "
        "VALUES(?,?,?,?,?)", (pid, "Group A", "term", 9, 0))
    gid = gcur.lastrowid

    # Item 1: fixed_course with a coreq, left unmet (not passed) so it
    # surfaces in eligible_next.
    con.execute(
        "INSERT INTO plan_item(group_id, kind, course_code, one_of, slot_type, "
        "credits, footnote_refs, ordering) VALUES(?,?,?,?,?,?,?,?)",
        (gid, "fixed_course", "GC 4070", None, None, 3, "[]", 0))

    # Item 2: GC Technical Requirement slot (6cr), resolved via the
    # subject_nonrequired derivation wildcard (no explicit_courses).
    con.execute(
        "INSERT INTO plan_item(group_id, kind, course_code, one_of, slot_type, "
        "credits, footnote_refs, ordering) VALUES(?,?,?,?,?,?,?,?)",
        (gid, "slot", None, None, "GC Technical Requirement", 6, "[]", 1))
    con.execute(
        "INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
        (pid, "GC Technical Requirement", json.dumps({
            "total_credits": 6,
            "explicit_courses": [],
            "wildcards": [{
                "type": "subject_nonrequired", "subject": "GC",
                "number_exclude": "37XX", "deny": ["GC 3610"],
                "allow_except": ["GC 3720"],
            }],
        })))

    con.execute(
        "INSERT INTO course(code, subject, number, title, credits, coreq_parsed) "
        "VALUES(?,?,?,?,?,?)",
        ("GC 4070", "GC", "4070", "Portfolio Studio", "3", json.dumps(["GC 4061"])))
    con.execute(
        "INSERT INTO course(code, subject, number, title, credits) VALUES(?,?,?,?,?)",
        ("GC 2900", "GC", "2900", "Non-required GC elective", "6"))
    con.commit()
    con.close()
    return db


def _progress(**kw):
    kw.setdefault("version", "gc-progress-v1")
    kw.setdefault("catalog_year", "2026-2027")
    return Progress(**kw)


def test_partial_student_shape(fixtures_dir):
    a = _run("progress_partial.json", fixtures_dir)
    assert a["catalog_year"] == "2026-2027"
    assert a["total_credits_required"] == 120
    assert a["credits_earned"] > 0
    assert a["credits_remaining"] < 120
    kinds = {i["kind"] for i in a["items"]}
    assert {"fixed_course", "choice", "slot"} <= kinds


def test_output_carries_version_and_source_url(fixtures_dir):
    # Contract for CUassistant: a version stamp so a shape change is detectable,
    # and the program's catalog page for citation.
    from gc_advisor.audit.engine import AUDIT_SCHEMA_VERSION
    a = _run("progress_partial.json", fixtures_dir)
    assert a["audit_version"] == AUDIT_SCHEMA_VERSION
    assert "source_url" in a
    assert a["source_url"] and "catalog.clemson.edu" in a["source_url"]


def test_passed_fixed_course_is_met(fixtures_dir):
    a = _run("progress_partial.json", fixtures_dir)
    gc1010 = next(i for i in a["items"] if i.get("course_code") == "GC 1010")
    assert gc1010["status"] == "met"


def test_choice_met_by_any_option(fixtures_dir):
    a = _run("progress_partial.json", fixtures_dir)
    # STAT 2300 satisfies the STAT choice in Freshman/Second Semester
    stat = next(i for i in a["items"] if "STAT 2300" in (i.get("one_of") or []))
    assert stat["status"] == "met"


def test_lab_science_slot_met_by_ch1010(fixtures_dir):
    a = _run("progress_partial.json", fixtures_dir)
    # CH 1010 is in explicit_courses for 'Approved Laboratory Science Requirement'
    lab = next(i for i in a["items"] if i.get("slot_type") == "Approved Laboratory Science Requirement")
    assert lab["status"] == "met"


def test_gen_ed_reported_per_category(fixtures_dir):
    a = _run("progress_partial.json", fixtures_dir)
    names = {g["name"] for g in a["gen_ed"]}
    assert any("Mathematic" in n for n in names)
    math = next(g for g in a["gen_ed"] if "Mathematic" in g["name"])
    assert math["credits_earned"] >= 3   # MATH 1020 passed
    assert math["status"] == "met"


def test_in_progress_courses_marked(fixtures_dir):
    a = _run("progress_partial.json", fixtures_dir)
    # GC 2400 is a fixed_course in the Sophomore/Second Semester group
    gc2400 = next(i for i in a["items"] if i.get("course_code") == "GC 2400")
    assert gc2400["status"] == "in_progress"


def test_eligible_next_lists_prereq_clear_courses(fixtures_dir):
    a = _run("progress_partial.json", fixtures_dir)
    assert isinstance(a["eligible_next"], list)
    for e in a["eligible_next"]:
        assert e["code"] and "prereq" in e


def test_unknown_course_flagged(fixtures_dir):
    d = json.loads((fixtures_dir / "progress_partial.json").read_text())
    d["passed"].append({"code": "FAKE 9999", "term": "Fall 2024", "credits": 3})
    a = run_audit(str(DB), Progress.from_dict(d))
    assert any("FAKE 9999" in f for f in a["flags"])


def test_partial_exact_credits(fixtures_dir):
    """Verify exact credits_earned for the partial fixture under waterfall allocation.

    Derivation (pass 1 → pass 2 → electives):

    deduped (fixture credits, not plan credits):
      GC 1010 (1), GC 1020 (3), ENGL 1030 (3), MATH 1020 (3),
      CH 1010 (4), GC 2070 (3), STAT 2300 (3)
    in_progress: GC 2400, COMM 1500

    Pass 1 — fixed/choice met (plan credits used for credits_earned):
      GC 1010 → consumed, +1cr (plan)
      GC 1020 → consumed, +2cr (plan)
      ENGL 1030 → consumed, +3cr (plan)
      STAT 2300 (choice) → consumed, +3cr (plan)
      GC 2070 → consumed, +4cr (plan)
    consumed after pass 1: {GC 1010, GC 1020, ENGL 1030, STAT 2300, GC 2070}

    Pass 2 — slots in plan order:
      Lab Science (4cr rule): CH 1010 unconsumed in explicit (4cr) → met,
        consume CH 1010; +4cr
      Specialty (all 4 slots): no unconsumed specialty-eligible courses → unmet
      REACH Act: manual (no rule/gen-ed match)
      A&H (Lit): no A&H courses in deduped → unmet
      Elective 3cr (Soph/2nd): deferred
      Oral Comm: ENGL 1030 consumed; COMM 1500 in_progress only → unmet
      Elective 1cr (Jr/1st): deferred
      A&H (Non-Lit): no A&H courses in deduped → unmet
      Elective 1cr (Jr/2nd): deferred
      GC Tech: no tech explicit courses in deduped → unmet
      Elective 4cr (Sr/2nd): deferred

    Elective resolution:
      unallocated = MATH 1020 (3cr) → 3cr
      Elective 3cr: MET (3 >= 3), unallocated = 0; +3cr
      Elective 1cr: UNMET (0 < 1)
      Elective 1cr: UNMET (0 < 1)
      Elective 4cr: UNMET (0 < 4)

    credits_earned = 1 + 2 + 3 + 3 + 4 + 4 + 3 = 20
    credits_remaining = 120 − 20 = 100
    """
    a = _run("progress_partial.json", fixtures_dir)
    assert a["credits_earned"] == 20.0
    assert a["credits_remaining"] == 100.0


def test_no_double_count_fixed_and_gen_ed_slot(fixtures_dir):
    """B1 regression: ENGL 1030 is consumed as a fixed_course in pass 1,
    so the Oral Communication gen-ed slot must be UNMET (COMM 1500 is only
    in_progress).  Confirms the same 3cr cannot add to credits_earned twice."""
    a = _run("progress_partial.json", fixtures_dir)
    oral = next(i for i in a["items"]
                if i.get("slot_type") == "Oral Communication Requirement")
    assert oral["status"] == "unmet"


def test_single_ah_course_meets_only_one_ah_slot(fixtures_dir):
    """B2 regression: a single 3-credit A&H course (ENGL 2020) is consumed
    by the first A&H slot it satisfies (Literature).  The second slot
    (Non-Literature) must remain unmet — the same credits cannot count twice."""
    d = json.loads((fixtures_dir / "progress_partial.json").read_text())
    # Add ENGL 2020 (3cr, in A&H allowed list) to the partial fixture.
    d["passed"].append({"code": "ENGL 2020", "term": "Fall 2025", "credits": 3})
    a = run_audit(str(DB), Progress.from_dict(d))
    ah_lit = next(i for i in a["items"]
                  if i.get("slot_type") == "Arts and Humanities (Literature) Requirement")
    ah_nonlit = next(i for i in a["items"]
                     if i.get("slot_type") == "Arts and Humanities (Non-Literature) Requirement")
    met_count = sum(1 for s in [ah_lit["status"], ah_nonlit["status"]] if s == "met")
    assert met_count == 1, (
        f"Expected exactly 1 A&H slot met; got Lit={ah_lit['status']}, "
        f"NonLit={ah_nonlit['status']}"
    )


def test_electives_absorb_unallocated(fixtures_dir):
    """Elective slots absorb unconsumed credits in plan order.

    Partial fixture: after all fixed/choice/rule/gen-ed slots, only MATH 1020
    (3cr) is unallocated (not consumed by any named requirement).  The first
    Elective slot (Sophomore/2nd, 3cr) must be MET; subsequent elective slots
    (1cr, 1cr, 4cr) must be UNMET because 0cr remain.
    """
    a = _run("progress_partial.json", fixtures_dir)
    elective_slots = [i for i in a["items"]
                      if i.get("slot_type") == "Elective" and i["kind"] == "slot"]
    # Plan order: 3cr (Soph/2nd), 1cr (Jr/1st), 1cr (Jr/2nd), 4cr (Sr/2nd)
    assert len(elective_slots) == 4
    statuses = [i["status"] for i in elective_slots]
    assert statuses[0] == "met",   f"First 3cr elective should be met; got {statuses[0]}"
    assert statuses[1] == "unmet", f"Second 1cr elective should be unmet; got {statuses[1]}"
    assert statuses[2] == "unmet", f"Third 1cr elective should be unmet; got {statuses[2]}"
    assert statuses[3] == "unmet", f"Fourth 4cr elective should be unmet; got {statuses[3]}"


def test_complete_student_has_nothing_unmet(fixtures_dir):
    """Complete fixture: all plan items met or manual; credits_remaining == 3
    (only the South Carolina REACH Act slot, which is 'manual' and thus not
    auto-credited).

    Derivation summary:
      Pass 1 met: all 29 fixed/choice courses → 70cr
      Lab Science slot: CH 1010 (4cr) → +4cr
      Specialty slots ×4 (via minor): +3+3+5+4 = +15cr
      A&H (Lit): ENGL 2020 consumed → +3cr
      Oral Comm: COMM 1500 consumed → +3cr
      A&H (Non-Lit): ART 2100 consumed → +3cr
      GC Tech: GC 3450 + GC 3600 consumed (6cr, greedy min) → +6cr
      Electives (all 4): 13cr unallocated (GC 3620, GC 4070, GC 4510, ANTH 3010)
        ≥ 3+1+1+4=9cr needed → all met → +3+1+1+4 = +9cr
      REACH Act: manual → +0cr
      Total: 70+4+15+3+3+3+6+9 = 113... recalculated = 117cr
      credits_remaining = 120 − 117 = 3
    """
    a = _run("progress_complete.json", fixtures_dir)
    unmet = [i for i in a["items"] if i["status"] == "unmet"]
    assert unmet == [] or all(i["kind"] == "slot" for i in unmet)
    assert a["credits_remaining"] == 3.0


def test_flags_deduplicated(fixtures_dir):
    """B3 regression: the flags list must not contain duplicates."""
    a = _run("progress_partial.json", fixtures_dir)
    assert len(a["flags"]) == len(set(a["flags"])), (
        f"Duplicate flags found: {a['flags']}"
    )


def test_gc_technical_counts_nonrequired_gc_via_derivation(tmp_path):
    """A passed non-required GC course (GC 2900 — not fixed in the plan,
    not 37XX, not denied) satisfies the 6cr GC Technical Requirement slot
    purely via the subject_nonrequired derivation wildcard (no
    explicit_courses listed in the rule)."""
    db = _seed_engine_db(tmp_path)
    progress = _progress(passed=[PassedCourse("GC 2900", "Fall 2025", 6.0)])
    a = run_audit(str(db), progress)
    tech = next(i for i in a["items"] if i.get("slot_type") == "GC Technical Requirement")
    assert tech["status"] == "met"
    assert tech["credits_earned"] == 6.0
    assert "GC 2900" in tech["counted_courses"]


def test_gc_technical_excludes_required_gc_course(tmp_path):
    """A plan-required GC course (GC 4070 — a fixed_course requirement) must
    NOT be counted toward the GC Technical Requirement slot's
    subject_nonrequired derivation wildcard, even once passed.  Guards the
    engine's required_codes wiring into SlotContext (see
    test_gc_technical_counts_nonrequired_gc_via_derivation for the
    complementary non-required case)."""
    db = _seed_engine_db(tmp_path)
    progress = _progress(passed=[PassedCourse("GC 4070", "Fall 2025", 3.0)])
    a = run_audit(str(db), progress)
    tech = next(i for i in a["items"] if i.get("slot_type") == "GC Technical Requirement")
    assert "GC 4070" not in tech["counted_courses"]


def test_eligible_next_surfaces_coreqs(tmp_path):
    """GC 4070 has no prereqs (prereq_parsed absent) so it's eligible-next
    once unmet, and its coreq_parsed = '["GC 4061"]' must surface as
    co_reqs on the eligible_next entry."""
    db = _seed_engine_db(tmp_path)
    progress = _progress(passed=[])
    a = run_audit(str(db), progress)
    entry = next(e for e in a["eligible_next"] if e["code"] == "GC 4070")
    assert entry["co_reqs"] == ["GC 4061"]


def test_audit_survives_a_program_with_no_total_credits(tmp_path):
    """A program page with no 'Total Credits:' line stores NULL, which used to
    crash run_audit with a TypeError on None - float."""
    from gc_advisor.db.connection import init_db, get_connection
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit

    db = tmp_path / "t.db"
    init_db(db)
    con = get_connection(db)
    con.execute("INSERT INTO catalog_year(label, catoid) VALUES(?,?)", ("2026-2027", 49))
    cy = con.execute("SELECT id FROM catalog_year").fetchone()["id"]
    con.execute(
        "INSERT INTO program(catalog_year_id, poid, name, kind, degree, total_credits) "
        "VALUES(?,?,?,?,?,?)", (cy, 1, "No Totals, BS", "major", "BS", None))
    con.commit()
    con.close()

    progress = Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2026-2027",
        "program": "No Totals, BS", "passed": [], "in_progress": [],
        "minor": None, "grade_checks": {}, "warnings": [],
    })
    out = run_audit(str(db), progress)
    assert out["total_credits_required"] is None
    assert out["credits_remaining"] is None


def test_capped_pre_satisfy_one_of_specialty_rule_still_caps(fixtures_dir):
    """Regression: GC's pre-2023 Specialty Area rule has no satisfy_one_of
    (no minor alternative was offered before 2023-2024) but already carried
    the dept_capped BIOL/CH/PHYS wildcard. rule_evaluator must route it to
    minor_or_course_set on the dept_capped wildcard alone, or these 12cr of
    BIOL count at full, uncapped value via the generic credit_set path
    (which by design does not apply dept_capped aggregate capping —
    engine.py:69-73), flipping status from unmet to met and dropping both
    advisory flags. Pinned to 2022-2023 specifically because all golden
    fixtures pin 2026-2027, whose rule already carries satisfy_one_of and so
    would pass even with the dept_capped branch missing."""
    d = json.loads((fixtures_dir / "progress_specialty_capped.json").read_text())
    d["catalog_year"] = "2022-2023"
    a = run_audit(str(DB), Progress.from_dict(d))
    spec = next(i for i in a["items"] if i.get("slot_type") == "Specialty Area Requirement")
    assert spec["status"] == "unmet"
    assert spec["credits_earned"] == 7.0
    assert any("BIOL/CH/PHYS credits capped" in f for f in a["flags"])
    assert any("BIOL/CH/PHYS credits accepted provisionally" in f for f in a["flags"])


def _seed_two_one_of_slots_db(tmp_path):
    """Build a from-scratch catalog DB (same pattern as _seed_engine_db) with
    TWO distinct minor-or-course-set slots under different names — 'Area One
    Requirement' and 'Area Two Requirement' — each with its own
    satisfy_one_of rule and its own explicit_courses. Exercises the per-slot
    cache and the self-referential rules.get(slot_type, {}) lookup: if the
    cache were single-valued (not keyed by slot_type) or the lookup were
    hardcoded to one slot's name, the second slot evaluated would silently
    return the first slot's answer instead of its own."""
    db = tmp_path / "t.db"
    init_db(db)
    con = get_connection(db)
    con.execute("INSERT INTO catalog_year(label, catoid) VALUES(?,?)", ("2026-2027", 2))
    cy = con.execute("SELECT id FROM catalog_year WHERE label=?", ("2026-2027",)).fetchone()["id"]
    con.execute(
        "INSERT INTO program(catalog_year_id, poid, name, kind, degree, total_credits, description) "
        "VALUES(?,?,?,?,?,?,?)",
        (cy, 2, "Two Slots, BS", "major", "BS", 8, ""))
    pid = con.execute("SELECT id FROM program WHERE catalog_year_id=? AND poid=?",
                      (cy, 2)).fetchone()["id"]
    gcur = con.execute(
        "INSERT INTO requirement_group(program_id, label, kind, credit_total, ordering) "
        "VALUES(?,?,?,?,?)", (pid, "Group A", "term", 8, 0))
    gid = gcur.lastrowid

    con.execute(
        "INSERT INTO plan_item(group_id, kind, course_code, one_of, slot_type, "
        "credits, footnote_refs, ordering) VALUES(?,?,?,?,?,?,?,?)",
        (gid, "slot", None, None, "Area One Requirement", 3, "[]", 0))
    con.execute(
        "INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
        (pid, "Area One Requirement", json.dumps({
            "total_credits": 3,
            "explicit_courses": ["AAA 1000"],
            "satisfy_one_of": ["approved_minor", "course_set"],
        })))

    con.execute(
        "INSERT INTO plan_item(group_id, kind, course_code, one_of, slot_type, "
        "credits, footnote_refs, ordering) VALUES(?,?,?,?,?,?,?,?)",
        (gid, "slot", None, None, "Area Two Requirement", 5, "[]", 1))
    con.execute(
        "INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
        (pid, "Area Two Requirement", json.dumps({
            "total_credits": 10,
            "explicit_courses": ["BBB 2000"],
            "satisfy_one_of": ["approved_minor", "course_set"],
        })))

    con.execute(
        "INSERT INTO course(code, subject, number, title, credits) VALUES(?,?,?,?,?)",
        ("AAA 1000", "AAA", "1000", "Area One Course", "3"))
    con.execute(
        "INSERT INTO course(code, subject, number, title, credits) VALUES(?,?,?,?,?)",
        ("BBB 2000", "BBB", "2000", "Area Two Course", "5"))
    con.commit()
    con.close()
    return db


def test_two_minor_or_course_set_slots_get_independent_results(tmp_path):
    """Each minor-or-course-set slot must be evaluated and cached against its
    OWN rule. Area One's rule is satisfied by AAA 1000 (3cr needed, 3cr
    passed); Area Two's rule needs 10cr but only BBB 2000 (5cr) is passed, so
    it must be unmet. If the cache or lookup collapsed to a single shared
    slot (the pre-fix behaviour), Area Two would silently report Area One's
    result: met, 3cr, ["AAA 1000"]."""
    db = _seed_two_one_of_slots_db(tmp_path)
    progress = _progress(program="Two Slots, BS", passed=[
        PassedCourse("AAA 1000", "Fall 2025", 3.0),
        PassedCourse("BBB 2000", "Fall 2025", 5.0),
    ])
    a = run_audit(str(db), progress)
    area_one = next(i for i in a["items"] if i.get("slot_type") == "Area One Requirement")
    area_two = next(i for i in a["items"] if i.get("slot_type") == "Area Two Requirement")

    assert area_one["status"] == "met"
    assert area_one["credits_earned"] == 3.0
    assert area_one["counted_courses"] == ["AAA 1000"]

    assert area_two["status"] == "unmet"
    assert area_two["credits_earned"] == 5.0
    assert area_two["counted_courses"] == ["BBB 2000"]


@pytest.mark.parametrize("year,credits", [
    ("2023-2024", 12), ("2024-2025", 12), ("2025-2026", 12), ("2026-2027", 15),
])
def test_specialty_credit_totals_match_the_registrar(year, credits):
    """Pinned to the DegreeWorks What-If audits (docs/degreeworks/
    freshman_gc_*cleaned.md): the registrar's Specialty Area Option 2 is
    12 credits through 2025-26 and 15 in 2026-27. Our catalog-derived rules
    agree today; this catches an ingest regression that drifts them."""
    from gc_advisor.db.connection import get_connection
    con = get_connection(DB)
    try:
        row = con.execute(
            "SELECT json_extract(r.rule,'$.total_credits') AS tc "
            "FROM requirement_rule r JOIN program p ON r.program_id=p.id "
            "JOIN catalog_year cy ON p.catalog_year_id=cy.id "
            "WHERE p.name LIKE 'Graphic%' AND cy.label=? "
            "AND r.slot_type='Specialty Area Requirement'", (year,)).fetchone()
    finally:
        con.close()
    assert row is not None, f"no Specialty Area rule for {year}"
    assert row["tc"] == credits


def test_vacuous_rule_falls_through_to_gen_ed_matching():
    """Finding #4 of the 2026-08-25 whole-branch review, using its exact
    example: Marketing's Natural Science Requirement derived a rule with
    total_credits but NO courses, wildcards, or advisor entries (a footnote
    mis-association), and because `st in rules` outranks gen-ed matching the
    slot was UNSATISFIABLE — unmet forever, worse than manual. A vacuous rule
    must be ignored so the slot falls through to gen-ed. Deferred while it
    could move GC output; measured 2026-08-25: GC has zero vacuous rules, so
    the goldens are unaffected."""
    from gc_advisor.audit.models import Progress
    from gc_advisor.audit.engine import run_audit
    out = run_audit(str(DB), Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2026-2027",
        "program": "Marketing, BS",
        "passed": [{"code": "CH 1010", "credits": 4}, {"code": "CH 1020", "credits": 4}],
        "in_progress": [], "minor": None, "grade_checks": {}, "warnings": []}))
    ns = [i for i in out["items"] if i.get("slot_type") == "Natural Science Requirement"]
    assert ns, "no Natural Science slot"
    assert any(i["status"] == "met" for i in ns), \
        f"lab science did not satisfy Natural Science: {[(i['status'], i.get('credits_earned')) for i in ns]}"
