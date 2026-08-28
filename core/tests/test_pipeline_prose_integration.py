import json
import pytest
from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.load import ensure_catalog_year
from gc_advisor.ingest.pipeline import ingest_prose_program

@pytest.mark.integration
def test_ingest_accounting_minor_end_to_end(tmp_path):
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    raw = tmp_path / "raw"
    cy = ensure_catalog_year(con, "2026-2027", 49)
    pid = ingest_prose_program(con, raw, "2026-2027", 49, cy, 16611,
                               name="Accounting Minor", kind="minor")
    prog = con.execute("SELECT kind, total_credits FROM program WHERE id=?", (pid,)).fetchone()
    assert prog["kind"] == "minor" and prog["total_credits"] == 18
    rr = con.execute("SELECT rule FROM requirement_rule WHERE program_id=?", (pid,)).fetchone()
    assert "ACCT 2010" in json.loads(rr["rule"])["required_courses"]
    assert (raw / "2026-2027" / "16611.txt").exists()
    assert (raw / "2026-2027" / "16611.llm.json").exists()
