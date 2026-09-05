#!/usr/bin/env python3
"""Backfill gen_ed_category.subcategories on an EXISTING database from the
committed raw corpus — the additive alternative to a full rebuild (which needs
Playwright and an LLM endpoint and is deliberately not run casually).

Touches ONLY the subcategories column, and only for rows where the re-parsed
page shows a split. Reports every year loudly, including the ones where no
split was found — silence must not read as absence.
"""
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from gc_advisor.ingest.parse_gen_ed import parse_gen_ed  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "db" / "catalog.db"
RAW = ROOT / "data" / "raw"

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
try:
    con.execute("ALTER TABLE gen_ed_category ADD COLUMN subcategories TEXT")
except sqlite3.OperationalError:
    pass  # already present

updated, missing = 0, []
for cy in con.execute("SELECT id, label FROM catalog_year ORDER BY label"):
    raw = RAW / cy["label"] / "gen_ed.txt"
    if not raw.exists():
        missing.append(f"{cy['label']}: no raw gen_ed.txt")
        continue
    cats = parse_gen_ed(raw.read_text())
    hit = False
    for c in cats:
        if not c.subcategories:
            continue
        n = con.execute(
            "UPDATE gen_ed_category SET subcategories=? "
            "WHERE catalog_year_id=? AND name=?",
            (json.dumps(c.subcategories), cy["id"], c.name),
        ).rowcount
        if n != 1:
            missing.append(f"{cy['label']}: parsed split for {c.name!r} but {n} DB rows matched")
            continue
        names = ", ".join(f"{s['name']}({len(s['allowed_courses'])})" for s in c.subcategories)
        print(f"{cy['label']}: {c.name} -> {names}")
        updated += 1
        hit = True
    if not hit:
        missing.append(f"{cy['label']}: page shows no parseable split")
con.commit()
print(f"\n{updated} rows updated")
if missing:
    print("NOT updated (stated, not silent):")
    for m in missing:
        print(f"  - {m}")
