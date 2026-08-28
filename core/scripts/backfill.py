"""Backfill GC catalog data for all years in catalogs.toml.

For each year in required scope (2019-2020 through 2026-2027), discovers
the correct programs navoid for that catoid, finds the GC BS poid, and
runs ingest_year. Prints a per-year status line; never aborts on one
year's failure.

Run: PYTHONPATH=src .venv/bin/python scripts/backfill.py
"""
import os
import tomllib
import re
from pathlib import Path

from gc_advisor.db.connection import init_db
from gc_advisor.ingest.pipeline import ingest_year, find_program_poid
from gc_advisor.ingest.render import render_html

ROOT = Path(__file__).parent.parent
# GC_INGEST_DB overrides the target DB (scratch rebuilds; deliberately NOT
# GC_ADVISOR_DB, which the service config reads — an exported override must
# never repoint the live daemons).
DB = Path(os.environ["GC_INGEST_DB"]) if os.environ.get("GC_INGEST_DB") else ROOT / "db" / "gc_advisor.db"
RAW = ROOT / "data" / "raw"
CATALOGS = ROOT / "catalogs.toml"

# Required scope: 2019-2020 through 2026-2027
REQUIRED_YEARS = {
    "2019-2020", "2020-2021", "2021-2022", "2022-2023",
    "2023-2024", "2024-2025", "2025-2026", "2026-2027",
}

GC_NAME_CONTAINS = "Graphic Communications"


def find_cob_navoid(catoid: int) -> int:
    """Find the College of Business programs index navoid for a given catoid.

    Strategy: render the catalog index page for the given catoid and find
    the navbar link whose text contains 'College of Business'. The navoid
    on that link is the one that lists CoB programs including GC BS.
    """
    url = f"https://catalog.clemson.edu/index.php?catoid={catoid}"
    html = render_html(url, selector="body")

    # Primary pattern: navoid=NNN" ...><span...>...College of Business...
    m = re.search(
        r'navoid=(\d+)\"[^>]*>[^<]*<[^>]*>[^<]*(?:College of Business|Business College)',
        html, re.I
    )
    if m:
        return int(m.group(1))

    # Fallback: any line/text containing navoid=NNN followed by Business on same line
    m = re.search(r'navoid=(\d+)[^\n]*Business', html, re.I)
    if m:
        return int(m.group(1))

    raise LookupError(
        f"No College of Business nav link found for catoid={catoid}"
    )


def main():
    catalogs = tomllib.loads(CATALOGS.read_text())["catalogs"]

    # Filter to required scope only, sort descending (newest first)
    years_in_scope = sorted(
        [(y, c) for y, c in catalogs.items() if y in REQUIRED_YEARS],
        reverse=True,
    )

    print(f"Initializing DB at {DB}")
    init_db(DB)

    results = []

    for year, catoid in years_in_scope:
        print(f"\n{'='*60}")
        print(f"Processing {year}  catoid={catoid}")
        try:
            print(f"  Discovering CoB navoid...")
            navoid = find_cob_navoid(catoid)
            print(f"  Found navoid={navoid}")

            print(f"  Finding GC BS poid...")
            gc_poid = find_program_poid(catoid, navoid, GC_NAME_CONTAINS)
            print(f"  Found poid={gc_poid}")

            print(f"  Running ingest_year...")
            res = ingest_year(DB, RAW, year, catoid, gc_poid, navoid)
            issues = res["issues"]
            if issues:
                status = f"OK_WITH_ISSUES (issues={len(issues)})"
                for iss in issues:
                    print(f"    ISSUE: {iss}")
            else:
                status = "OK"
            results.append(dict(
                year=year, catoid=catoid, navoid=navoid, poid=gc_poid,
                status=status, issues=issues,
            ))
            print(f"  Status: {status}")

        except Exception as exc:
            status = f"FAIL: {exc}"
            results.append(dict(
                year=year, catoid=catoid, navoid=None, poid=None,
                status=status, issues=[],
            ))
            print(f"  Status: FAIL")
            print(f"  Error: {exc}")
            import traceback
            traceback.print_exc()

    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    print(f"{'Year':<12} {'catoid':>7} {'navoid':>7} {'poid':>7}  Status")
    print(f"{'-'*12} {'-'*7} {'-'*7} {'-'*7}  {'-'*40}")
    for r in results:
        navoid_s = str(r['navoid']) if r['navoid'] else 'N/A'
        poid_s = str(r['poid']) if r['poid'] else 'N/A'
        print(f"{r['year']:<12} {r['catoid']:>7} {navoid_s:>7} {poid_s:>7}  {r['status']}")

    n_ok = sum(1 for r in results if r["status"].startswith("OK"))
    n_fail = sum(1 for r in results if r["status"].startswith("FAIL"))
    print(f"\nTotal: {len(results)} years  OK={n_ok}  FAIL={n_fail}")


if __name__ == "__main__":
    main()
