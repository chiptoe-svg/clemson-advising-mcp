"""Add / remove / list advisor-maintained Specialty Area & GC Technical courses
(spec §B). The catalog explicit list is read-only here; this manages the
advisor_course layer only."""
import argparse, datetime
from pathlib import Path
from gc_advisor.db.connection import get_connection
from gc_advisor.db import advisor

DEFAULT_DB = Path(__file__).parent.parent / "db" / "gc_advisor.db"
SLOTS = {"specialty": "Specialty Area Requirement",
         "technical": "Graphic Communication Technical Requirement"}


def _slot(alias: str) -> str:
    if alias in SLOTS:
        return SLOTS[alias]
    if alias in SLOTS.values():
        return alias
    raise SystemExit(f"unknown --slot {alias!r}; use one of: {', '.join(SLOTS)}")


def main():
    ap = argparse.ArgumentParser(description="Manage the advisor course list")
    ap.add_argument("--db", default=str(DEFAULT_DB))
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("add", "deny", "remove", "list"):
        p = sub.add_parser(name)
        p.add_argument("--slot", required=True)
        if name != "list":
            p.add_argument("--code", required=True)
        if name in ("add", "deny"):
            p.add_argument("--year", default="all")
            p.add_argument("--note", default=None)
    args = ap.parse_args()
    slot = _slot(args.slot)
    con = get_connection(args.db)
    try:
        if args.cmd in ("add", "deny"):
            year = None if args.year == "all" else args.year
            inserted = advisor.add_course(
                con, slot, args.code,
                action=("deny" if args.cmd == "deny" else "allow"),
                catalog_year=year, note=args.note,
                added_on=datetime.date.today().isoformat())
            if inserted:
                print(f"{args.cmd}: {args.code} -> {slot} ({args.year})")
            else:
                print(f"{args.cmd}: {args.code} already present in {slot} ({args.year}) "
                      f"— no change (use `remove` first to change its action/note)")
        elif args.cmd == "remove":
            n = advisor.remove_course(con, slot, args.code)
            print(f"removed {n} row(s) for {args.code} from {slot}")
        if args.cmd in ("add", "deny", "remove"):
            # advisor rows can rescue or doom a rule — keep the materialized
            # bogus flags (requirement_rule_effective) in agreement
            from gc_advisor.db.access import refresh_bogus_flags
            refresh_bogus_flags(con)
        elif args.cmd == "list":
            rows = advisor.list_entries(con, slot)
            print(f"# advisor layer — {slot}")
            for r in rows:
                yr = r["catalog_year"] or "all-years"
                note = f"  ({r['note']})" if r["note"] else ""
                print(f"  [{r['action']}] {r['code']}  {yr}{note}")
            if args.db == str(DEFAULT_DB):
                print("# catalog explicit + wildcards (read-only) — via req-rules; "
                      "run scripts/query.py req-rules for the full merged rule")
    finally:
        con.close()


if __name__ == "__main__":
    main()
