"""Backfill lecture/lab corequisites on the course table (spec 2026-07-25).

Deterministic, idempotent, rebuild-safe: derives each lab's lecture(s) from its
description ('...accompany DEPT NNNN') and writes coreq_text/coreq_parsed
bidirectionally on both rows, for ALL subjects. Run AFTER courses are loaded
(e.g. after scripts/crawl_courses.py) as part of the .db rebuild.

Run: PYTHONPATH=src .venv/bin/python scripts/backfill_coreqs.py
"""
import os
import argparse
from pathlib import Path

from gc_advisor.db.connection import get_connection
from gc_advisor.ingest.coreqs import backfill_coreqs, derive_lab_pairs

# GC_INGEST_DB overrides the target DB (scratch rebuilds; deliberately NOT
# GC_ADVISOR_DB, which the service config reads — an exported override must
# never repoint the live daemons).
DEFAULT_DB = Path(os.environ["GC_INGEST_DB"]) if os.environ.get("GC_INGEST_DB") else Path(__file__).parent.parent / "db" / "catalog.db"


def main():
    ap = argparse.ArgumentParser(description="Backfill lecture/lab corequisites")
    ap.add_argument("--db", default=str(DEFAULT_DB))
    args = ap.parse_args()
    con = get_connection(args.db)
    try:
        pairs = derive_lab_pairs(con)
        n = backfill_coreqs(con)
        print(f"lab->lecture pairs derived: {len(pairs)}; course rows updated: {n}")
    finally:
        con.close()


if __name__ == "__main__":
    main()
