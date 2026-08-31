import argparse, json
from pathlib import Path
from gc_advisor.db.access import CatalogAccess

DEFAULT_DB = Path(__file__).parent.parent / "db" / "catalog.db"

def main():
    ap = argparse.ArgumentParser(description="GC curriculum query (JSON out)")
    ap.add_argument("--db", default=str(DEFAULT_DB))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("years")
    pp = sub.add_parser("program-plan")
    pp.add_argument("--year", required=True)
    pp.add_argument("--name", default="Graphic Communications, BS")
    gc = sub.add_parser("course"); gc.add_argument("--code", required=True)
    rr = sub.add_parser("req-rules")
    rr.add_argument("--year", required=True)
    rr.add_argument("--name", default="Graphic Communications, BS")
    ge = sub.add_parser("gen-ed")
    ge.add_argument("--year", required=True)
    args = ap.parse_args()
    acc = CatalogAccess(args.db)

    def _known_programs(year):
        from gc_advisor.db.connection import get_connection
        con = get_connection(args.db)
        try:
            return [r["name"] for r in con.execute(
                "SELECT p.name FROM program p JOIN catalog_year cy "
                "ON p.catalog_year_id=cy.id WHERE cy.label=? "
                "AND p.kind IN ('major','pre_business') ORDER BY p.name", (year,))]
        finally:
            con.close()
    if args.cmd == "years":
        print(json.dumps(acc.list_catalog_years()))
    elif args.cmd == "program-plan":
        try:
            print(json.dumps(acc.get_program_plan(args.year, args.name), indent=2))
        except KeyError as e:
            print(json.dumps({"error": str(e).strip('"'),
                              "known_programs": _known_programs(args.year)}))
            raise SystemExit(2)
    elif args.cmd == "course":
        print(json.dumps(acc.get_course(args.code)))
    elif args.cmd == "req-rules":
        try:
            print(json.dumps(acc.get_requirement_rules(args.year, args.name), indent=2))
        except KeyError as e:
            print(json.dumps({"error": str(e).strip('"'),
                              "known_programs": _known_programs(args.year)}))
            raise SystemExit(2)
    elif args.cmd == "gen-ed":
        print(json.dumps(acc.get_gen_ed(args.year), indent=2))

if __name__ == "__main__":
    main()
