"""Ingest one named major for one catalog year.

    PYTHONPATH=src .venv/bin/python scripts/ingest_year.py 2026-2027
    PYTHONPATH=src .venv/bin/python scripts/ingest_year.py 2026-2027 --program "Marketing, BS"

Requirement rules are NOT built here — run scripts/backfill_requirements.py
afterwards, which builds them for every major in the year.
"""
import os
import argparse, tomllib
from pathlib import Path
from gc_advisor.db.connection import init_db
from gc_advisor.ingest.pipeline import (ingest_year, find_program_poid,
                                        find_cob_navoid)

ROOT = Path(__file__).parent.parent
# GC_INGEST_DB overrides the target DB (scratch rebuilds; deliberately NOT
# GC_ADVISOR_DB, which the service config reads — an exported override must
# never repoint the live daemons).
DB = Path(os.environ["GC_INGEST_DB"]) if os.environ.get("GC_INGEST_DB") else ROOT / "db" / "catalog.db"
RAW = ROOT / "data" / "raw"
DEFAULT_PROGRAM = "Graphic Communications, BS"

def main(year: str, program: str, navoid: int | None):
    catoid = tomllib.loads((ROOT / "catalogs.toml").read_text())["catalogs"][year]
    init_db(DB)
    if navoid is None:
        navoid = find_cob_navoid(catoid)
    poid = find_program_poid(catoid, navoid, program)
    res = ingest_year(DB, RAW, year, catoid, poid, navoid)
    print(f"{year} {program}: navoid={navoid} poid={poid} program_id={res['program_id']} "
          f"issues={res['issues']}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("year")
    ap.add_argument("--program", default=DEFAULT_PROGRAM)
    ap.add_argument("--navoid", type=int, default=None,
                    help="override the discovered COB programs-index navoid")
    a = ap.parse_args()
    main(a.year, a.program, a.navoid)
