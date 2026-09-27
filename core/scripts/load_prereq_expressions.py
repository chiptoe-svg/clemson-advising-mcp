"""Load core/prereqs/plan-courses.json into prereq_expression.

Run: PYTHONPATH=src .venv/bin/python scripts/load_prereq_expressions.py
Exits non-zero if any row was stale (text changed since review) so a rebuild
can't pass quietly with fewer expressions than were reviewed."""
import argparse
import json
import os
import sys
from pathlib import Path

from gc_advisor.db.connection import get_connection
from gc_advisor.ingest.prereq_expressions import load_prereq_expressions

ROOT = Path(__file__).parent.parent
DEFAULT_DB = Path(os.environ["GC_INGEST_DB"]) if os.environ.get("GC_INGEST_DB") else ROOT / "db" / "catalog.db"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--fixture", default=str(ROOT / "prereqs" / "plan-courses.json"))
    args = ap.parse_args()
    fixture = json.loads(Path(args.fixture).read_text())
    con = get_connection(args.db)
    try:
        res = load_prereq_expressions(con, fixture)
    finally:
        con.close()
    print(res)
    if res["stale"]:
        print(f"STALE (re-review these): {res['stale']}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
