"""Materialized bogus-rule verdicts (CUassistant handoff finding, 2026-08-25).

The bogus-rule filter lived only in CatalogAccess, but consumers also read
`requirement_rule` via DIRECT SQL (CUassistant ATTACHes the DB for
find-requirement-sections) — so MGT 4150 sections were still offered as
"Natural Science" on that path. The verdict is now materialized: a `bogus`
column computed by the SAME rule_semantics.is_bogus_rule (never re-implemented
in SQL), refreshed by every writer, exposed to direct readers via the
`requirement_rule_effective` view. A DB-wide agreement test keeps column and
code from drifting.
"""
import json
from pathlib import Path
import pytest
from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.db.access import refresh_bogus_flags

DB = Path(__file__).parent.parent / "db" / "gc_advisor.db"


def _seed(tmp_path):
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    con.execute("INSERT INTO catalog_year(label, catoid) VALUES(?,?)", ("2026-2027", 49))
    cy = con.execute("SELECT id FROM catalog_year").fetchone()["id"]
    con.execute("INSERT INTO program(catalog_year_id, poid, name, kind) VALUES(?,?,?,?)",
                (cy, 1, "T, BS", "major"))
    pid = con.execute("SELECT id FROM program").fetchone()["id"]
    con.execute("INSERT INTO gen_ed_category(catalog_year_id, name, min_credits, allowed_courses, rules) "
                "VALUES(?,?,?,?,?)",
                (cy, "Natural Sciences with Lab", 4, json.dumps(["CH 1010", "BIOL 1030"]), "[]"))
    # wrong-course rule: NSR asserting a business course (the Management shape)
    con.execute("INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
                (pid, "Natural Science Requirement",
                 json.dumps({"total_credits": 4, "explicit_courses": ["MGT 4150"], "raw_text": "x"})))
    # healthy rule
    con.execute("INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
                (pid, "Lab Requirement",
                 json.dumps({"total_credits": 4, "explicit_courses": ["CH 1010"], "raw_text": "y"})))
    con.commit()
    return con, pid


def test_refresh_marks_bogus_and_view_excludes_it(tmp_path):
    con, pid = _seed(tmp_path)
    n = refresh_bogus_flags(con)
    assert n == 1
    rows = {r["slot_type"]: r["bogus"] for r in
            con.execute("SELECT slot_type, bogus FROM requirement_rule WHERE program_id=?", (pid,))}
    assert rows == {"Natural Science Requirement": 1, "Lab Requirement": 0}
    eff = [r["slot_type"] for r in
           con.execute("SELECT slot_type FROM requirement_rule_effective WHERE program_id=?", (pid,))]
    assert eff == ["Lab Requirement"]


def test_advisor_rescue_flips_the_flag_on_refresh(tmp_path):
    """An advisor allow is exactly what rescues a rule; the materialized flag
    must follow after refresh — which is why every writer calls refresh."""
    from gc_advisor.db import advisor
    con, pid = _seed(tmp_path)
    refresh_bogus_flags(con)
    advisor.add_course(con, "Natural Science Requirement", "CH 1010",
                       program="T, BS", added_on="2026-08-25")
    refresh_bogus_flags(con)
    row = con.execute("SELECT bogus FROM requirement_rule WHERE program_id=? "
                      "AND slot_type='Natural Science Requirement'", (pid,)).fetchone()
    assert row["bogus"] == 0


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_materialized_flags_agree_with_the_code_everywhere():
    """Drift guard: the column must equal a live is_bogus_rule computation for
    EVERY rule row in the real DB. If this fails, a writer forgot refresh."""
    from gc_advisor.audit.rule_semantics import is_bogus_rule
    from gc_advisor.db import advisor as _advisor
    con = get_connection(DB)
    try:
        disagreements = []
        for p in con.execute(
                "SELECT p.id, p.name, cy.id AS cyid, cy.label FROM program p "
                "JOIN catalog_year cy ON p.catalog_year_id=cy.id"):
            gen_ed = [{"name": g["name"],
                       "allowed_courses": json.loads(g["allowed_courses"] or "[]")}
                      for g in con.execute(
                          "SELECT name, allowed_courses FROM gen_ed_category "
                          "WHERE catalog_year_id=?", (p["cyid"],))]
            for r in con.execute(
                    "SELECT slot_type, rule, bogus FROM requirement_rule WHERE program_id=?",
                    (p["id"],)):
                rule = json.loads(r["rule"])
                allow, deny = _advisor.advisor_sets(con, r["slot_type"], p["label"], program=p["name"])
                rule["advisor_courses"] = sorted(allow)
                rule["advisor_denies"] = sorted(deny)
                want = 1 if is_bogus_rule(r["slot_type"], rule, gen_ed) else 0
                if want != r["bogus"]:
                    disagreements.append((p["name"], p["label"], r["slot_type"], r["bogus"], want))
        assert not disagreements, f"column vs code drift: {disagreements[:8]}"
    finally:
        con.close()


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_direct_sql_reader_no_longer_sees_the_management_nsr_rule():
    """The exact CUassistant repro: a direct reader of the effective view must
    not see Management 2025-26's Natural Science rule (MGT 4150 artifact)."""
    con = get_connection(DB)
    try:
        rows = con.execute(
            "SELECT r.slot_type FROM requirement_rule_effective r "
            "JOIN program p ON r.program_id=p.id "
            "JOIN catalog_year cy ON p.catalog_year_id=cy.id "
            "WHERE p.name='Management, BS' AND cy.label='2025-2026'").fetchall()
        assert "Natural Science Requirement" not in {r["slot_type"] for r in rows}
    finally:
        con.close()


def test_prose_minor_rules_are_never_judged_bogus(tmp_path):
    """Minor/certificate rules use the PROSE schema (required_courses,
    elective_rules — no raw_text, no explicit_courses). is_bogus_rule judged
    them as vacuous, which silently dropped all 958 of them from
    get_requirement_rules since the filter landed — caught only because the
    materialized flag count (987) was absurd. A rule not in the derived-rule
    schema is never bogus."""
    con, pid = _seed(tmp_path)
    con.execute("INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
                (pid, "Minor Requirements",
                 json.dumps({"total_credits": 18,
                             "required_courses": ["ACCT 2010"],
                             "elective_rules": [], "not_open_to": []})))
    con.commit()
    refresh_bogus_flags(con)
    row = con.execute("SELECT bogus FROM requirement_rule WHERE program_id=? "
                      "AND slot_type='Minor Requirements'", (pid,)).fetchone()
    assert row["bogus"] == 0


@pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")
def test_minor_rules_flow_through_the_access_layer():
    """Regression pin for the consumer surface: req-rules for a minor must
    return its prose rule, not an empty list."""
    from gc_advisor.db.access import CatalogAccess
    rules = CatalogAccess(str(DB)).get_requirement_rules("2026-2027", "Accounting Minor")
    assert rules, "minor's prose rule filtered out by the bogus-rule filter"
