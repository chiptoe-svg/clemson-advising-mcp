from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.parse_program import parse_program
from gc_advisor.ingest.load import ensure_catalog_year, load_program
from gc_advisor.ingest.requirement_rules import build_requirement_rules
from gc_advisor.db.access import CatalogAccess
import gc_advisor.db.advisor as advisor

def _seed(tmp_path, fixtures_dir):
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    cy = ensure_catalog_year(con, "2026-2027", 49)
    prog = parse_program((fixtures_dir / "gc_program_2026.txt").read_text(),
                         kind="major", degree="BS")
    load_program(con, cy, prog, poid=16765, source_url="u", source_hash="h")
    con.close()
    return db

def test_list_years(tmp_path, fixtures_dir):
    db = _seed(tmp_path, fixtures_dir)
    acc = CatalogAccess(db)
    assert "2026-2027" in acc.list_catalog_years()

def test_get_program_plan(tmp_path, fixtures_dir):
    db = _seed(tmp_path, fixtures_dir)
    acc = CatalogAccess(db)
    plan = acc.get_program_plan("2026-2027", "Graphic Communications, BS")
    assert plan["total_credits"] == 120
    assert len(plan["groups"]) >= 8
    assert any(it["course_code"] == "GC 1010"
               for g in plan["groups"] for it in g["items"])
    assert plan["source_url"] == "u"  # exact catalog page, surfaced for citation

def test_unknown_year_raises(tmp_path, fixtures_dir):
    db = _seed(tmp_path, fixtures_dir)
    acc = CatalogAccess(db)
    import pytest
    with pytest.raises(KeyError):
        acc.get_program_plan("1999-2000", "Graphic Communications, BS")

def test_requirement_rules_include_advisor_layer(tmp_path, fixtures_dir):
    db = _seed(tmp_path, fixtures_dir)
    con = get_connection(db)
    pid = con.execute(
        "SELECT id FROM program WHERE name=?", ("Graphic Communications, BS",)
    ).fetchone()["id"]
    build_requirement_rules(con, pid)
    advisor.add_course(con, "Specialty Area Requirement", "MKT 4290", added_on="2026-07-23")
    con.close()
    acc = CatalogAccess(db)
    rules = {r["slot_type"]: r["rule"] for r in acc.get_requirement_rules("2026-2027")}
    spec = rules["Specialty Area Requirement"]
    assert "MKT 4290" in spec["advisor_courses"]
    assert spec["advisor_denies"] == []
