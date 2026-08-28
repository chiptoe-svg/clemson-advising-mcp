import json
from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.load import ensure_catalog_year, load_prose_program
from gc_advisor.models import ParsedProseProgram

def _prog(fixtures_dir):
    rule = json.loads((fixtures_dir / "accounting_minor_2026.llm.json").read_text())
    return ParsedProseProgram(name="Accounting Minor", kind="minor",
                              total_credits=18, description="(18 credits minimum) ...",
                              rule=rule)

def test_load_prose_persists_program_and_rule(tmp_path, fixtures_dir):
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    cy = ensure_catalog_year(con, "2026-2027", 49)
    pid = load_prose_program(con, cy, _prog(fixtures_dir), poid=16611,
                             source_url="u", source_hash="h")
    prog = con.execute("SELECT kind, total_credits FROM program WHERE id=?", (pid,)).fetchone()
    assert prog["kind"] == "minor" and prog["total_credits"] == 18
    rr = con.execute("SELECT slot_type, rule FROM requirement_rule WHERE program_id=?", (pid,)).fetchone()
    assert rr["slot_type"] == "program_requirement"
    assert "ACCT 2010" in json.loads(rr["rule"])["required_courses"]

def test_load_prose_is_idempotent(tmp_path, fixtures_dir):
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    cy = ensure_catalog_year(con, "2026-2027", 49)
    load_prose_program(con, cy, _prog(fixtures_dir), poid=16611, source_url="u", source_hash="h")
    load_prose_program(con, cy, _prog(fixtures_dir), poid=16611, source_url="u", source_hash="h")
    n = con.execute("SELECT COUNT(*) FROM program WHERE poid=16611").fetchone()[0]
    assert n == 1
    nr = con.execute("SELECT COUNT(*) FROM requirement_rule").fetchone()[0]
    assert nr == 1
