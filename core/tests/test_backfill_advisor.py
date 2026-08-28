"""GC's real pack (packs/gc) must scope its writes to its own program, the
same guarantee the retired scripts/backfill_advisor_and_wildcards.py held via
its --program argument. The generic mechanism is covered by
test_apply_pack_does_not_touch_another_programs_rule in test_packs.py against
a synthetic pack; this test proves it holds for the actual GC pack."""
import datetime
import json
from pathlib import Path

from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.packs import load_pack, apply_pack

ROOT = Path(__file__).parent.parent
PACK = ROOT / "packs" / "gc"
SPECIALTY = "Specialty Area Requirement"


def test_wildcard_backfill_does_not_touch_another_programs_rules(tmp_path):
    """Two programs share a slot name; applying the GC pack must only alter
    its own program's rule."""
    db = tmp_path / "t.db"
    init_db(db)
    con = get_connection(db)
    con.execute("INSERT INTO catalog_year(label, catoid) VALUES(?,?)", ("2026-2027", 49))
    cy = con.execute("SELECT id FROM catalog_year").fetchone()["id"]
    ids = {}
    for poid, name in ((1, "Graphic Communications, BS"), (2, "Other Major, BS")):
        con.execute(
            "INSERT INTO program(catalog_year_id, poid, name, kind) VALUES(?,?,?,?)",
            (cy, poid, name, "major"))
        pid = con.execute("SELECT id FROM program WHERE poid=?", (poid,)).fetchone()["id"]
        ids[name] = pid
        con.execute(
            "INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
            (pid, SPECIALTY, json.dumps({"total_credits": 15, "explicit_courses": []})))
    con.commit()

    apply_pack(con, load_pack(PACK), added_on=datetime.date.today().isoformat())

    def wc(name):
        r = con.execute("SELECT rule FROM requirement_rule WHERE program_id=?",
                        (ids[name],)).fetchone()
        return json.loads(r["rule"]).get("wildcards")

    assert wc("Graphic Communications, BS"), "GC should have been given wildcards"
    assert wc("Other Major, BS") is None, "another program's rule must be untouched"
