import gc_advisor.db.advisor as advisor
from gc_advisor.db.connection import init_db, get_connection

SPECIALTY = "Specialty Area Requirement"

def _db(tmp_path):
    p = tmp_path / "t.db"
    init_db(p)
    return get_connection(p)

def test_add_and_read_allow(tmp_path):
    con = _db(tmp_path)
    advisor.add_course(con, SPECIALTY, "MKT 4290", note="faculty vote", added_on="2026-07-23")
    allow, deny = advisor.advisor_sets(con, SPECIALTY, "2026-2027")
    assert "MKT 4290" in allow and deny == set()

def test_deny_action(tmp_path):
    con = _db(tmp_path)
    advisor.add_course(con, SPECIALTY, "ART 1030", action="deny", added_on="2026-07-23")
    _, deny = advisor.advisor_sets(con, SPECIALTY, "2026-2027")
    assert "ART 1030" in deny

def test_year_scoping(tmp_path):
    con = _db(tmp_path)
    advisor.add_course(con, SPECIALTY, "GC 9999", catalog_year="2024-2025", added_on="2026-07-23")
    assert "GC 9999" in advisor.advisor_sets(con, SPECIALTY, "2024-2025")[0]
    assert "GC 9999" not in advisor.advisor_sets(con, SPECIALTY, "2026-2027")[0]

def test_remove(tmp_path):
    con = _db(tmp_path)
    advisor.add_course(con, SPECIALTY, "MKT 4290", added_on="2026-07-23")
    assert advisor.remove_course(con, SPECIALTY, "MKT 4290") == 1
    assert advisor.advisor_sets(con, SPECIALTY, "2026-2027")[0] == set()

def test_duplicate_add_is_noop(tmp_path):
    con = _db(tmp_path)
    assert advisor.add_course(con, SPECIALTY, "MKT 4290", added_on="2026-07-23") == 1
    assert advisor.add_course(con, SPECIALTY, "MKT 4290", added_on="2026-07-24") == 0
    allow, _ = advisor.advisor_sets(con, SPECIALTY, "2026-2027")
    assert allow == {"MKT 4290"}
    assert len(advisor.list_entries(con, SPECIALTY)) == 1

def test_duplicate_add_noop_for_null_year(tmp_path):
    con = _db(tmp_path)
    advisor.add_course(con, SPECIALTY, "GC 3610", catalog_year=None, added_on="2026-07-23")
    advisor.add_course(con, SPECIALTY, "GC 3610", catalog_year=None, added_on="2026-07-24")
    assert len(advisor.list_entries(con, SPECIALTY)) == 1  # NULL years dedupe too

def test_invalid_action_raises(tmp_path):
    import pytest
    con = _db(tmp_path)
    with pytest.raises(ValueError):
        advisor.add_course(con, SPECIALTY, "X 1000", action="maybe", added_on="2026-07-23")

def test_list_entries(tmp_path):
    con = _db(tmp_path)
    advisor.add_course(con, SPECIALTY, "MKT 4290", note="vote 2026-03", added_on="2026-07-23")
    rows = advisor.list_entries(con, SPECIALTY)
    assert rows[0]["code"] == "MKT 4290" and rows[0]["note"] == "vote 2026-03"
