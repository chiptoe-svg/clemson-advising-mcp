import pytest
from pathlib import Path
from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.pipeline import ingest_year, find_program_poid

@pytest.mark.integration
def test_ingest_2026_end_to_end(tmp_path):
    db = tmp_path / "t.db"; init_db(db)
    raw = tmp_path / "raw"
    poid = find_program_poid(49, 1996, "Graphic Communications, BS")
    res = ingest_year(db, raw, "2026-2027", 49, poid, 1996)
    assert not res["issues"]
    con = get_connection(db)
    total = con.execute("SELECT total_credits FROM program WHERE poid=?", (poid,)).fetchone()[0]
    assert total == 120
    assert (raw / "2026-2027" / f"{poid}.txt").exists()
