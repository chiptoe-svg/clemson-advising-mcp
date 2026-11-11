#!/usr/bin/env python3
"""Save every plan-parsed program page's HTML and text, from one load each.

    PYTHONPATH=src .venv/bin/python scripts/fetch_program_pages.py

For the HTML reader comparison (docs/superpowers/specs/
2026-11-11-catalog-html-reader-design.md). Majors only: Pre-Business has no
page of its own and is read from the same year's Marketing page. Pages go to
<repo>/state/catalog-html/<year>/<poid>.html and .txt, untracked. Polite to
the catalog site: one page at a time, at least 4 s apart, stop on the first
failure; a re-run skips pages already saved. catalog.db is read only.
"""
import argparse
import json
import re
import sqlite3
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent


@dataclass(frozen=True)
class PageRef:
    name: str
    kind: str
    year: str
    catoid: int
    poid: int
    url: str


@dataclass
class FetchResult:
    fetched: int = 0
    skipped: int = 0
    failed: PageRef | None = None


def program_pages(db_path) -> list[PageRef]:
    """The major program pages in catalog.db, oldest year first."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT p.name, p.kind, cy.label, p.source_url FROM program p "
            "JOIN catalog_year cy ON cy.id = p.catalog_year_id "
            "WHERE p.kind = 'major' ORDER BY cy.label, p.name"
        ).fetchall()
    finally:
        con.close()
    out = []
    for name, kind, year, url in rows:
        m = re.search(r"catoid=(\d+)&poid=(\d+)", url or "")
        if not m:
            raise ValueError(f"{name} {year}: no catoid/poid in source_url {url!r}")
        out.append(PageRef(name, kind, year, int(m.group(1)), int(m.group(2)), url))
    return out


def fetch_all(pages, out_dir, render=None, sleep=time.sleep, pause_s=4.0) -> FetchResult:
    if render is None:
        from gc_advisor.ingest.render import render_both as render
    out_dir = Path(out_dir)
    res = FetchResult()
    manifest = []
    rendered_any = False
    for page in pages:
        d = out_dir / page.year
        html_p, text_p = d / f"{page.poid}.html", d / f"{page.poid}.txt"
        entry = asdict(page)
        if html_p.exists() and text_p.exists():
            res.skipped += 1
            entry["fetched_at"] = datetime.fromtimestamp(
                html_p.stat().st_mtime, timezone.utc).isoformat()
            manifest.append(entry)
            continue
        if rendered_any:
            sleep(pause_s)
        rendered_any = True
        try:
            html, text = render(page.url)
        except Exception as e:  # stop on the first failure, never retry in a loop
            print(f"FAILED {page.name} {page.year}: {e}", file=sys.stderr)
            res.failed = page
            break
        d.mkdir(parents=True, exist_ok=True)
        html_p.write_text(html, encoding="utf-8")
        text_p.write_text(text, encoding="utf-8")
        entry["fetched_at"] = datetime.now(timezone.utc).isoformat()
        manifest.append(entry)
        res.fetched += 1
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(REPO / "state" / "catalog-html"))
    ap.add_argument("--db", default=str(ROOT / "db" / "catalog.db"))
    a = ap.parse_args()
    res = fetch_all(program_pages(a.db), a.out)
    print(f"fetched {res.fetched}, skipped {res.skipped}, failed: "
          f"{f'{res.failed.name} {res.failed.year}' if res.failed else 'none'}")
    return 1 if res.failed else 0


if __name__ == "__main__":
    sys.exit(main())
