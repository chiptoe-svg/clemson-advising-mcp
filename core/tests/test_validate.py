from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.parse_program import parse_program
from gc_advisor.ingest.load import ensure_catalog_year, load_program
from gc_advisor.ingest.validate import validate_program

def test_validate_flags_credit_mismatch(tmp_path, fixtures_dir):
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    cy = ensure_catalog_year(con, "2026-2027", 49)
    prog = parse_program((fixtures_dir / "gc_program_2026.txt").read_text(),
                         kind="major", degree="BS")
    pid = load_program(con, cy, prog, poid=16765, source_url="u", source_hash="h")
    issues = validate_program(con, pid)
    assert [i for i in issues if i["type"] == "credit_sum"] == []

def test_validate_detects_bad_total(tmp_path, fixtures_dir):
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    cy = ensure_catalog_year(con, "2026-2027", 49)
    prog = parse_program((fixtures_dir / "gc_program_2026.txt").read_text(),
                         kind="major", degree="BS")
    prog.total_credits = 999
    pid = load_program(con, cy, prog, poid=16765, source_url="u", source_hash="h")
    issues = validate_program(con, pid)
    assert any(i["type"] == "credit_sum" for i in issues)
