#!/usr/bin/env python3
"""Reload every stored registrar requirement set into the database.

    PYTHONPATH=src .venv/bin/python scripts/reimport_registrar.py

WHY THIS EXISTS. `registrar_requirement.program_id` references `program(id)`,
and a catalog re-ingest DELETEs and re-INSERTs program rows — so every ingest
both breaks the foreign key (the delete fails outright) and would orphan these
rows if it did not. The extracted JSON under state/registrar/ is therefore the
DURABLE store and the table is a cache of it; this script rebuilds the cache.

RUN IT AFTER ANY CATALOG INGEST that touches a program with registrar data.
The order that works:

    1. DELETE FROM registrar_requirement   (frees the foreign key)
    2. re-ingest the catalog               (ingest_year.py / a re-parse)
    3. this script                         (restores the requirements)

Skipping step 3 leaves get-degree-requirements reporting "no audit imported"
for every program — which is at least honest rather than wrong, but it is not
what anyone wants.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "src"))

from gc_advisor.db.connection import get_connection, init_db  # noqa: E402

DB = (
    Path(os.environ["GC_INGEST_DB"])
    if os.environ.get("GC_INGEST_DB")
    else ROOT / "db" / "catalog.db"
)
STATE = Path(os.environ.get("REGISTRAR_STATE", ROOT.parent / "state" / "registrar"))


def main() -> None:
    files = sorted(STATE.glob("*/*.json"))
    if not files:
        raise SystemExit(f"no registrar sets under {STATE}")
    init_db(DB)
    con = get_connection(DB)
    loaded = missing = 0
    try:
        for f in files:
            doc = json.loads(f.read_text())
            row = con.execute(
                "SELECT p.id FROM program p JOIN catalog_year cy "
                "ON p.catalog_year_id=cy.id WHERE p.name=? AND cy.label=?",
                (doc["program"], doc["catalog_year"]),
            ).fetchone()
            if row is None:
                # The catalog no longer carries this program-year. Say so
                # rather than dropping the set silently.
                print(f"  SKIP {doc['catalog_year']} {doc['program']}: "
                      f"not in the catalog")
                missing += 1
                continue
            pid = row[0]
            con.execute("DELETE FROM registrar_requirement WHERE program_id=?", (pid,))
            for i, r in enumerate(doc["requirements"]):
                con.execute(
                    "INSERT INTO registrar_requirement"
                    "(program_id, ordering, display_name, need, unit, rule, audit_date)"
                    " VALUES(?,?,?,?,?,?,?)",
                    (pid, i, r["display_name"], r["need"], r["unit"],
                     json.dumps(r), doc.get("audit_date")),
                )
            loaded += len(doc["requirements"])
        con.commit()
    finally:
        con.close()
    print(f"reimported {loaded} requirements from {len(files) - missing} sets"
          + (f"; {missing} skipped" if missing else ""))


if __name__ == "__main__":
    main()
