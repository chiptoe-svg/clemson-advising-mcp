"""Apply a department pack to the catalog DB.

    PYTHONPATH=src .venv/bin/python scripts/apply_pack.py packs/gc

Idempotent: rule keys already set are left alone, duplicate advisor rows are
ignored. Replaces scripts/backfill_advisor_and_wildcards.py, which held one
department's knowledge as Python constants and wrote it to every program that
happened to share a slot name.
"""
import argparse, datetime
from pathlib import Path
from gc_advisor.db.connection import get_connection
from gc_advisor.ingest.packs import load_pack, apply_pack

DEFAULT_DB = Path(__file__).parent.parent / "db" / "gc_advisor.db"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pack", help="path to a pack directory, e.g. packs/gc")
    ap.add_argument("--db", default=str(DEFAULT_DB))
    args = ap.parse_args()
    con = get_connection(args.db)
    try:
        pack = load_pack(Path(args.pack))
        res = apply_pack(con, pack, added_on=datetime.date.today().isoformat())
        print(f"{pack.name}: {res}")
    finally:
        con.close()


if __name__ == "__main__":
    main()
