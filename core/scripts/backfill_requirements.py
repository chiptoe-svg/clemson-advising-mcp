#!/usr/bin/env python3
"""Backfill requirement_rules, gen_ed_category, and academic_regulation for all catalog years.

For each catalog year already in the DB:
  1. requirement_rules — pure DB, no render (derived from plan_item + footnote)
  2. gen_ed_category  — renders preview_program.php for the Gen-Ed program poid
  3. academic_regulation — renders content.php for the Academic Regulations navoid

Frozen raw text is cached under data/raw/<year>/ so re-runs are instant.

Usage:
    PYTHONPATH=src .venv/bin/python scripts/backfill_requirements.py
    PYTHONPATH=src .venv/bin/python scripts/backfill_requirements.py 2026-2027
"""
import os
import re
import sys
import argparse
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "src"))

from gc_advisor.db.connection import get_connection
from gc_advisor.ingest.render import render_html, render_text
from gc_advisor.ingest.requirement_rules import build_rules_for_catalog_year
from gc_advisor.db.access import refresh_bogus_flags
from gc_advisor.ingest.parse_gen_ed import parse_gen_ed
from gc_advisor.ingest.parse_academic_regs import parse_academic_regs
from gc_advisor.ingest.load import load_gen_ed, load_academic_regs

BASE = "https://catalog.clemson.edu"
# GC_INGEST_DB overrides the target DB (scratch rebuilds; deliberately NOT
# GC_ADVISOR_DB, which the service config reads — an exported override must
# never repoint the live daemons).
DB = Path(os.environ["GC_INGEST_DB"]) if os.environ.get("GC_INGEST_DB") else ROOT / "db" / "catalog.db"
DATA = ROOT / "data" / "raw"


def find_gen_ed_url(catoid: int) -> str | None:
    """Find the URL for the Gen-Ed page for this catoid.

    Newer catalogs (2022+) serve Gen-Ed as a preview_program.php?poid=N page.
    Older catalogs (pre-2022) serve it as a content.php?navoid=N page.

    Renders the catalog index and looks for a link whose visible text contains
    "General Education" (span-wrapped or direct), then returns the full URL.
    """
    html = render_html(f"{BASE}/index.php?catoid={catoid}", selector="body")

    # Pattern 1: preview_program.php?poid=N link (newer catalogs)
    for m in re.finditer(
        rf'href="([^"]*preview_program\.php\?catoid={catoid}&(?:amp;)?poid=(\d+)[^"]*)"'
        r'[^>]*>(?:[^<]*<[^>]+>)?\s*([^<]*General Education[^<]*)',
        html,
    ):
        url = m.group(1).replace("&amp;", "&")
        if not url.startswith("http"):
            url = BASE + "/" + url.lstrip("/")
        return url

    # Pattern 2: content.php?navoid=N link (older catalogs, span-wrapped nav)
    for m in re.finditer(r'navoid=(\d+)"[^>]*>(?:[^<]*<[^>]+>)?\s*([^<]+?)\s*<', html):
        if "general education" in m.group(2).strip().lower():
            navoid = m.group(1)
            return f"{BASE}/content.php?catoid={catoid}&navoid={navoid}"

    return None


def find_academic_regs_navoid(catoid: int) -> str | None:
    """Find the navoid for the Academic Regulations nav link for this catoid.

    Uses the same approach as find_navoid() in backfill_prose.py: renders the
    catalog index and matches nav links by visible text (span-wrapped or direct).
    """
    html = render_html(f"{BASE}/index.php?catoid={catoid}", selector="body")

    # Pattern: navoid=NNN" ...><span...>Academic Regulations</span>
    # or direct: navoid=NNN">Academic Regulations<
    for m in re.finditer(r'navoid=(\d+)"[^>]*>(?:[^<]*<[^>]+>)?\s*([^<]+?)\s*<', html):
        if "academic regulations" in m.group(2).strip().lower():
            return m.group(1)

    return None


def main():
    ap = argparse.ArgumentParser(
        description="Backfill requirement_rules, gen_ed, and academic_regs.")
    ap.add_argument("year", nargs="?",
                    help="restrict to this catalog year label (e.g. 2026-2027)")
    args = ap.parse_args()

    con = get_connection(DB)
    years = con.execute(
        "SELECT id, label, catoid FROM catalog_year ORDER BY label"
    ).fetchall()

    ok = fail = 0

    for cy_row in years:
        cy_id, label, catoid = cy_row["id"], cy_row["label"], cy_row["catoid"]

        if args.year and label != args.year:
            continue

        raw_dir = DATA / label
        raw_dir.mkdir(parents=True, exist_ok=True)

        # ------------------------------------------------------------------
        # 1. requirement_rules (pure DB — no render needed)
        # ------------------------------------------------------------------
        try:
            made = build_rules_for_catalog_year(con, cy_id)
            refresh_bogus_flags(con)
            if made:
                total = sum(made.values())
                print(f"OK  req_rules {label}: {total} rules across "
                      f"{len(made)} major(s)")
                ok += 1
            else:
                print(f"SKIP req_rules {label}: no major program")
        except Exception as e:
            print(f"FAIL req_rules {label}: {e}")
            fail += 1

        # ------------------------------------------------------------------
        # 2. Gen-Ed categories
        # ------------------------------------------------------------------
        try:
            cached = raw_dir / "gen_ed.txt"
            if cached.exists():
                text = cached.read_text()
            else:
                url = find_gen_ed_url(catoid)
                if not url:
                    raise ValueError(f"Could not find Gen-Ed URL in nav for catoid {catoid}")
                text = render_text(url)
                cached.write_text(text)
            cats = parse_gen_ed(text)
            if not cats:
                raise ValueError("parse_gen_ed returned 0 categories")
            load_gen_ed(con, cy_id, cats)
            print(f"OK  gen_ed {label}: {len(cats)} categories")
            ok += 1
        except Exception as e:
            print(f"FAIL gen_ed {label}: {e}")
            fail += 1

        # ------------------------------------------------------------------
        # 3. Academic Regulations
        # ------------------------------------------------------------------
        try:
            cached = raw_dir / "academic_regs.txt"
            if cached.exists():
                text = cached.read_text()
            else:
                navoid = find_academic_regs_navoid(catoid)
                if not navoid:
                    raise ValueError(
                        f"Could not find Academic Regs navoid in nav for catoid {catoid}"
                    )
                url = f"{BASE}/content.php?catoid={catoid}&navoid={navoid}"
                text = render_text(url)
                cached.write_text(text)
            regs = parse_academic_regs(text)
            if not regs:
                raise ValueError("parse_academic_regs returned 0 sections")
            load_academic_regs(con, cy_id, regs)
            print(f"OK  academic_regs {label}: {len(regs)} sections")
            ok += 1
        except Exception as e:
            print(f"FAIL academic_regs {label}: {e}")
            fail += 1

    con.close()
    print(f"\nDone: {ok} OK, {fail} FAIL")


if __name__ == "__main__":
    main()
