import sqlite3
from gc_advisor.db.connection import init_db

EXPECTED_TABLES = {
    "catalog_year", "program", "requirement_group", "plan_item",
    "requirement_rule", "gen_ed_category", "academic_regulation",
    "footnote", "course", "source_snapshot",
}

def test_init_db_creates_all_tables(tmp_path):
    db = tmp_path / "t.db"
    init_db(db)
    con = sqlite3.connect(db)
    names = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert EXPECTED_TABLES <= names

def test_init_db_is_idempotent(tmp_path):
    db = tmp_path / "t.db"
    init_db(db)
    init_db(db)  # must not raise
    con = sqlite3.connect(db)
    assert con.execute("SELECT 1").fetchone() == (1,)
