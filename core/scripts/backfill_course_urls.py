"""Backfill course.source_url from frozen course snapshots (offline, no crawl).

Each data/raw/courses/<coid>.txt -> parse the code -> set the shareable catalog
page URL (preview_course_nopop.php?catoid=..&coid=..). Idempotent. Run after a
course crawl, or once to close the historical gap.

Run: PYTHONPATH=src .venv/bin/python scripts/backfill_course_urls.py
"""
import os
import argparse
from pathlib import Path

from gc_advisor.db.connection import get_connection
from gc_advisor.ingest.course_urls import backfill_course_source_urls

ROOT = Path(__file__).parent.parent


def main():
    ap = argparse.ArgumentParser(description="Backfill course.source_url from frozen snapshots")
    # GC_INGEST_DB: scratch-rebuild override (deliberately not GC_ADVISOR_DB)
    ap.add_argument("--db", default=os.environ.get("GC_INGEST_DB",
                    str(ROOT / "db" / "catalog.db")))
    ap.add_argument("--raw", default=str(ROOT / "data" / "raw" / "courses"))
    ap.add_argument("--catoid", type=int, default=49,
                    help="catoid the courses were crawled from (default 49 = 2026-2027)")
    args = ap.parse_args()
    con = get_connection(args.db)
    try:
        n = backfill_course_source_urls(con, args.raw, args.catoid)
        print(f"course.source_url populated: {n}")
    finally:
        con.close()


if __name__ == "__main__":
    main()
