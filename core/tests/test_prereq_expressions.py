# core/tests/test_prereq_expressions.py
import hashlib
from pathlib import Path

from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.prereq_expressions import DDL, load_prereq_expressions


def _db(tmp_path):
    p = tmp_path / "t.db"
    init_db(p)
    return get_connection(p)


def _course(con, code, prereq_text):
    subj, num = code.split(" ")
    con.execute("INSERT INTO course (code, subject, number, prereq_text) VALUES (?,?,?,?)",
                (code, subj, num, prereq_text))
    con.commit()


def test_ddl_matches_schema_sql():
    schema = (Path(__file__).parent.parent / "src/gc_advisor/db/schema.sql").read_text()
    assert DDL.strip() in schema


def test_loads_rows_with_hash_of_exact_text(tmp_path):
    con = _db(tmp_path)
    _course(con, "GC 3460", "GC 2070")
    res = load_prereq_expressions(con, {"GC 3460": {"text": "GC 2070", "expr": "GC 2070"}})
    assert res == {"loaded": 1, "stale": [], "missing_course": []}
    row = con.execute("SELECT expr, source_text_hash, note FROM prereq_expression").fetchone()
    assert row["expr"] == "GC 2070"
    assert row["source_text_hash"] == hashlib.sha256("GC 2070".encode()).hexdigest()
    assert row["note"] is None


def test_refuses_a_row_whose_text_no_longer_matches(tmp_path):
    con = _db(tmp_path)
    _course(con, "GC 3460", "GC 2070 and GC 3500")
    res = load_prereq_expressions(con, {"GC 3460": {"text": "GC 2070", "expr": "GC 2070"}})
    assert res["stale"] == ["GC 3460"] and res["loaded"] == 0
    assert con.execute("SELECT COUNT(*) FROM prereq_expression").fetchone()[0] == 0


def test_reports_codes_with_no_course_row(tmp_path):
    con = _db(tmp_path)
    res = load_prereq_expressions(con, {"MKT 4200": {"text": "x", "expr": "MKT 3010"}})
    assert res["missing_course"] == ["MKT 4200"]


def test_idempotent_replace_all(tmp_path):
    con = _db(tmp_path)
    _course(con, "GC 3460", "GC 2070")
    fx = {"GC 3460": {"text": "GC 2070", "expr": "GC 2070", "note": "n"}}
    load_prereq_expressions(con, fx)
    load_prereq_expressions(con, fx)
    assert con.execute("SELECT COUNT(*) FROM prereq_expression").fetchone()[0] == 1
