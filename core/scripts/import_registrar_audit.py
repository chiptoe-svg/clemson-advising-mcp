#!/usr/bin/env python3
"""Import a Degree Works What-If audit as the registrar's requirement set.

    PYTHONPATH=src .venv/bin/python scripts/import_registrar_audit.py \
        --program "Management, BS" --year 2026-2027 --file ~/audit.md

Two stages, deliberately separable so the extraction can be reviewed before
anything reaches the database:

  1. EXTRACT   audit text -> state/registrar/<year>/<slug>.json
     Only requirement rules are written. No name, no student ID, no GPA, no
     course history, no term data -- parse_audit stops at any transcript row,
     and this script writes only the parsed requirements, never the source
     text. The JSON is the reviewable artifact.

  2. LOAD      that JSON -> registrar_requirement, replacing the program's
     previous set in one transaction.

WHY state/ AND NOT THE REPOSITORY: this repository is public. A Degree Works
audit is an internal registrar artifact even when What-If sourced, and the
extracted rules are operator data, not published data — the same reasoning
that puts state/offering-decisions.yaml outside the tree. Committing rule
lines alone has precedent (tests/fixtures/registrar/*.txt), but that is Chip's
call to make deliberately, not a side effect of running this.

--dry-run prints what would be written and touches nothing.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "src"))

from gc_advisor.db.connection import get_connection, init_db  # noqa: E402
from gc_advisor.ingest.registrar_audit import parse_audit  # noqa: E402

# GC_INGEST_DB overrides the target DB (scratch imports); deliberately NOT
# GC_ADVISOR_DB, which the running services read.
DB = (
    Path(os.environ["GC_INGEST_DB"])
    if os.environ.get("GC_INGEST_DB")
    else ROOT / "db" / "catalog.db"
)
STATE = Path(os.environ.get("REGISTRAR_STATE", ROOT.parent / "state" / "registrar"))

_AUDIT_DATE_RE = re.compile(r"Audit date\s+(\d{2}/\d{2}/\d{4})")
_CATALOG_YEAR_RE = re.compile(r"Catalog year:\s*(\d{4}-\d{4})")
# Coursework on the record the audit was run against. THIS DECIDES WHETHER THE
# IMPORT IS COMPLETE, and it is the one thing about this pipeline that is easy
# to get wrong without noticing.
#
# A Degree Works audit lists what is STILL NEEDED. A requirement the test
# record already satisfies is printed with the satisfying course in its place
# and NO "Still needed:" clause — so it is invisible here, and the imported
# requirement set is short by exactly those requirements, with nothing about
# the result looking wrong. Measured 2026-09-08: five of eight current-year
# audits were run against a record carrying 15 in-progress credits, and
# Economics BA came in at 17 requirements where Economics BS — same degree
# family, clean record — had 28.
#
# So completeness is recorded per import and reported loudly. A What-If run
# from a record with NO coursework yields a complete set; anything else is
# partial and must say so rather than pass as whole.
_ENROLLED_ROW_RE = re.compile(r"\b(?:IP|TR)\s*\(\d")


def slug(program: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", program.lower()).strip("-")


def extract(text: str) -> dict:
    """Audit text -> the JSON document we keep. Rules only."""
    reqs = parse_audit(text)
    date = _AUDIT_DATE_RE.search(text)
    year = _CATALOG_YEAR_RE.search(text)
    enrolled = len(_ENROLLED_ROW_RE.findall(text))
    return {
        "catalog_year": year.group(1) if year else None,
        "audit_date": date.group(1) if date else None,
        "still_needed_lines": text.count("Still needed:"),
        # False when the source record carried coursework: the requirements
        # that coursework satisfies are absent from this set (see
        # _ENROLLED_ROW_RE). Never silently treat a partial set as complete.
        "source_record_clean": enrolled == 0,
        "enrolled_rows_in_source": enrolled,
        "requirements": [
            {
                "display_name": name,
                "need": r.need,
                "unit": r.unit,
                "conjunction": r.conjunction,
                "courses": r.courses,
                "wildcards": r.wildcards,
                "excludes": r.excludes,
                "attribute": r.attribute,
                "resident_required": r.resident_required,
                "alternatives": [
                    {
                        "need": a.need,
                        "unit": a.unit,
                        "conjunction": a.conjunction,
                        "courses": a.courses,
                        "wildcards": a.wildcards,
                        "attribute": a.attribute,
                    }
                    for a in r.alternatives
                ],
            }
            for name, r in reqs
        ],
    }


def load(con, program: str, year: str, doc: dict) -> int:
    row = con.execute(
        "SELECT p.id FROM program p JOIN catalog_year cy ON p.catalog_year_id=cy.id "
        "WHERE p.name=? AND cy.label=?",
        (program, year),
    ).fetchone()
    if row is None:
        raise SystemExit(
            f"error: no program {program!r} in catalog year {year} — ingest the "
            f"catalog plan first (scripts/ingest_year.py)"
        )
    pid = row[0]
    # Replace the whole set for this program: a partial update would leave
    # requirements from a previous audit mixed with the new one, and there is
    # no way to tell them apart afterwards.
    con.execute("DELETE FROM registrar_requirement WHERE program_id=?", (pid,))
    for i, r in enumerate(doc["requirements"]):
        con.execute(
            "INSERT INTO registrar_requirement"
            "(program_id, ordering, display_name, need, unit, rule, audit_date) "
            "VALUES(?,?,?,?,?,?,?)",
            (
                pid,
                i,
                r["display_name"],
                r["need"],
                r["unit"],
                json.dumps(r),
                doc.get("audit_date"),
            ),
        )
    return len(doc["requirements"])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--program", required=True, help='e.g. "Management, BS"')
    ap.add_argument("--year", help="catalog year; default: read from the audit")
    ap.add_argument("--file", required=True, help="cleaned audit text")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    doc = extract(Path(a.file).read_text())
    year = a.year or doc["catalog_year"]
    if not year:
        raise SystemExit("error: no catalog year in the audit; pass --year")
    doc["program"] = a.program
    doc["catalog_year"] = year

    n = len(doc["requirements"])
    skipped = doc["still_needed_lines"] - n
    print(f"{a.program} {year}: {n} requirements "
          f"({skipped} prose-only 'Still needed:' lines not machine-checkable)")
    if not doc["source_record_clean"]:
        print(f"   INCOMPLETE: the source audit was run against a record "
              f"carrying coursework ({doc['enrolled_rows_in_source']} enrolled/"
              f"transferred rows). Every requirement that coursework already "
              f"satisfies is ABSENT from this set. Re-run the What-If from a "
              f"record with no coursework for a complete set.")
    if a.dry_run:
        for r in doc["requirements"][:5]:
            print(f"   {r['display_name'][:44]:<44} {r['need']} {r['unit']}")
        print("   ... (dry run; nothing written)")
        return

    out = STATE / year / f"{slug(a.program)}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2) + "\n")
    out.chmod(0o600)
    print(f"   wrote {out}")

    init_db(DB)
    con = get_connection(DB)
    try:
        loaded = load(con, a.program, year, doc)
        con.commit()
    finally:
        con.close()
    print(f"   loaded {loaded} into registrar_requirement ({DB})")


if __name__ == "__main__":
    main()
