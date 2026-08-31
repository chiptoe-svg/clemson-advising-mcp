"""Ingest the `Pre-Business` program for recent catalog years.

The pre-business freshman curriculum is the shared block embedded in every
business major's page; we parse it out of one business major (Marketing — any of
the five shares the identical block) per year and store it as a standalone
`Pre-Business` program. Freezes the source page to data/raw/<year>/<poid>.txt.

Run: PYTHONPATH=src .venv/bin/python scripts/ingest_pre_business.py
     (optionally pass one or more years:  ... 2025-2026 2026-2027)
"""
import os
import argparse
import re
import sys
import tomllib
from pathlib import Path

from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.render import render_text, render_html
from gc_advisor.ingest.pipeline import find_program_poid, BASE
from gc_advisor.ingest.load import ensure_catalog_year, load_program
from gc_advisor.ingest.snapshots import freeze, content_hash
from gc_advisor.ingest.pre_business import parse_pre_business

ROOT = Path(__file__).parent.parent
# GC_INGEST_DB overrides the target DB (scratch rebuilds; deliberately NOT
# GC_ADVISOR_DB, which the service config reads — an exported override must
# never repoint the live daemons).
DB = Path(os.environ["GC_INGEST_DB"]) if os.environ.get("GC_INGEST_DB") else ROOT / "db" / "catalog.db"
RAW = ROOT / "data" / "raw"

# 4 back years is enough (per advising scope).
DEFAULT_YEARS = ["2023-2024", "2024-2025", "2025-2026", "2026-2027"]
SOURCE_MAJOR = "Marketing, BS"  # any business major carries the shared pre-biz block


def find_cob_navoid(catoid: int) -> int:
    """College of Business programs-index navoid for a catoid (from backfill.py)."""
    html = render_html(f"{BASE}/index.php?catoid={catoid}", selector="body")
    m = re.search(
        r'navoid=(\d+)\"[^>]*>[^<]*<[^>]*>[^<]*(?:College of Business|Business College)',
        html, re.I)
    if m:
        return int(m.group(1))
    m = re.search(r'navoid=(\d+)[^\n]*Business', html, re.I)
    if m:
        return int(m.group(1))
    raise LookupError(f"No College of Business nav for catoid={catoid}")


def main():
    ap = argparse.ArgumentParser(description="Ingest the Pre-Business program for recent years")
    ap.add_argument("years", nargs="*", default=DEFAULT_YEARS,
                    help="catalog year labels (default: 4 back years)")
    args = ap.parse_args()
    catalogs = tomllib.loads((ROOT / "catalogs.toml").read_text())["catalogs"]

    init_db(DB)
    con = get_connection(DB)
    try:
        for year in (args.years or DEFAULT_YEARS):
            catoid = catalogs.get(year)
            if not catoid:
                print(f"FAIL {year}: not in catalogs.toml")
                continue
            try:
                cy = ensure_catalog_year(con, year, catoid)
                navoid = find_cob_navoid(catoid)
                poid = find_program_poid(catoid, navoid, SOURCE_MAJOR)
                url = f"{BASE}/preview_program.php?catoid={catoid}&poid={poid}"
                text = render_text(url)
                freeze(RAW, year, poid, text)
                prog = parse_pre_business(text)
                pid = load_program(con, cy, prog, poid=poid, source_url=url,
                                   source_hash=content_hash(text))
                nfix = sum(1 for g in prog.groups for it in g.items if it.kind == "fixed_course")
                nch = sum(1 for g in prog.groups for it in g.items if it.kind == "choice")
                nsl = sum(1 for g in prog.groups for it in g.items if it.kind == "slot")
                print(f"OK {year}: Pre-Business program_id={pid} "
                      f"groups={len(prog.groups)} fixed={nfix} choice={nch} slot={nsl} "
                      f"footnotes={len(prog.footnotes)} (from {SOURCE_MAJOR} poid={poid})")
            except Exception as e:
                print(f"FAIL {year}: {type(e).__name__}: {e}")
    finally:
        con.close()


if __name__ == "__main__":
    main()
