"""Backfill minors and certificates for all catalog years in catalogs.toml.

For each catalog year, discovers the Minors and Certificates index navoids,
then ingests each listed program through the prose pipeline (render → freeze
→ LLM → load).  The --limit flag caps the number of programs per index so
the script can be validated cheaply and run incrementally.  Frozen .llm.json
artifacts make re-runs instant (cache hits) and the full run resumable.

Usage:
    # validate on a small slice:
    PYTHONPATH=src .venv/bin/python scripts/backfill_prose.py 2026-2027 --limit 3

    # full run for one year (launched by controller):
    PYTHONPATH=src .venv/bin/python scripts/backfill_prose.py 2026-2027

    # full multi-year run (launched by controller):
    PYTHONPATH=src .venv/bin/python scripts/backfill_prose.py
"""
import os
import sys
import tomllib
import argparse
import re
from pathlib import Path

from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.render import render_html
from gc_advisor.ingest.discover import parse_index
from gc_advisor.ingest.load import ensure_catalog_year
from gc_advisor.ingest.pipeline import ingest_prose_program, BASE
from gc_advisor.ingest.health import preflight, PreflightError, is_oom_error

ROOT = Path(__file__).parent.parent
# GC_INGEST_DB overrides the target DB (scratch rebuilds; deliberately NOT
# GC_ADVISOR_DB, which the service config reads — an exported override must
# never repoint the live daemons).
DB = Path(os.environ["GC_INGEST_DB"]) if os.environ.get("GC_INGEST_DB") else ROOT / "db" / "catalog.db"
RAW = ROOT / "data" / "raw"


class BackfillAborted(RuntimeError):
    """Raised when too many consecutive OOM errors indicate the server is stuck."""


def find_navoid(catoid: int, link_text: str) -> int:
    """Find the navoid for a top-level catalog nav link by its display text.

    Renders the catalog index page for the given catoid and searches for an
    anchor (possibly wrapping a <span>) whose visible text exactly matches
    link_text (case-insensitive).

    The catalog renders links like:
        navoid=NNN" class="navbar"><span class="text-accent">Minors</span>
    so the text lives inside a <span>, not directly in the <a> tag.
    We match both patterns:
      1. direct text:  navoid=NNN">TEXT<
      2. span-wrapped: navoid=NNN" ...><span...>TEXT</span>
    """
    html = render_html(f"{BASE}/index.php?catoid={catoid}", selector="body")
    # Pattern 1: span-wrapped text (the common catalog nav pattern)
    for m in re.finditer(r'navoid=(\d+)"[^>]*>(?:[^<]*<[^>]+>)?\s*([^<]+?)\s*<', html):
        if m.group(2).strip().lower() == link_text.lower():
            return int(m.group(1))
    raise LookupError(f"no '{link_text}' nav for catoid {catoid}")


def ingest_index_limited(con, year: str, catoid: int, cy: int,
                         navoid: int, kind: str, limit: int,
                         oom_counter: list[int] | None = None) -> int:
    """Ingest programs from a single catalog index page.

    Renders the index, parses program entries, and calls ingest_prose_program
    for each.  If limit > 0, only the first `limit` entries are processed.
    Returns the number successfully ingested; prints a warning for each failure.

    oom_counter is an optional 1-element list used to track consecutive OOM
    errors across calls.  When it reaches 5, BackfillAborted is raised.
    """
    html = render_html(f"{BASE}/content.php?catoid={catoid}&navoid={navoid}")
    entries = parse_index(html)
    if limit:
        entries = entries[:limit]
    n = 0
    for e in entries:
        try:
            ingest_prose_program(con, RAW, year, catoid, cy, e.poid,
                                 name=e.name, kind=kind)
            n += 1
            if oom_counter is not None:
                oom_counter[0] = 0
        except BackfillAborted:
            raise
        except Exception as ex:
            print(f"  ! {kind} {e.name!r} (poid {e.poid}): {ex}")
            if oom_counter is not None:
                if is_oom_error(ex):
                    oom_counter[0] += 1
                    if oom_counter[0] >= 5:
                        raise BackfillAborted(
                            "Aborting after 5 consecutive out-of-memory errors; "
                            "free memory and rerun — resumes from cache."
                        )
                else:
                    oom_counter[0] = 0
    return n


def main():
    ap = argparse.ArgumentParser(
        description="Backfill minors/certificates for all catalog years.")
    ap.add_argument("year", nargs="?",
                    help="restrict to this catalog year label (e.g. 2026-2027)")
    ap.add_argument("--limit", type=int, default=0,
                    help="max programs per index (0 = all; use 3 for validation)")
    args = ap.parse_args()

    cfg = tomllib.loads((ROOT / "catalogs.toml").read_text())["catalogs"]

    try:
        preflight()
    except PreflightError as e:
        print(f"PREFLIGHT FAILED: {e}")
        return

    init_db(DB)
    con = get_connection(DB)

    oom_counter = [0]  # consecutive OOM errors across all programs/years

    try:
        for year, catoid in sorted(cfg.items()):
            if not catoid:
                continue
            if args.year and year != args.year:
                continue

            cy = ensure_catalog_year(con, year, catoid)

            for kind, link in (("minor", "Minors"), ("certificate", "Certificates")):
                try:
                    navoid = find_navoid(catoid, link)
                    n = ingest_index_limited(con, year, catoid, cy, navoid,
                                             kind, args.limit,
                                             oom_counter=oom_counter)
                    print(f"OK {year} {kind}: {n} ingested (navoid {navoid})")
                except BackfillAborted:
                    raise
                except Exception as e:
                    print(f"FAIL {year} {kind}: {e}")
    except BackfillAborted as e:
        print(f"ABORTED: {e}")
    finally:
        con.close()


if __name__ == "__main__":
    main()
