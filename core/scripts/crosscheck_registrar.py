#!/usr/bin/env python3
"""Compare the CATALOG plan against the REGISTRAR's requirements.

    PYTHONPATH=src .venv/bin/python scripts/crosscheck_registrar.py
    PYTHONPATH=src .venv/bin/python scripts/crosscheck_registrar.py --year 2026-2027

This is the reason the two provenances are kept apart instead of blended: when
they disagree, the disagreement is the signal. It is how a real defect was
found on 2026-09-08 — Packaging Science 2024-2025's catalog page prints
"PKSC 4050 2" with no title or credits, the parser skipped the line in silence,
and Degree Works listed the course all along.

What it compares: courses each source states are REQUIRED OUTRIGHT — catalog
`fixed_course` plan items, versus registrar requirements of the form
"1 Class in X" (a single course, no alternatives). Choices, attribute rules and
wildcards are excluded on both sides; they are stated in different vocabularies
and a mismatch there is not evidence of anything.

NEITHER DIRECTION IS AUTOMATICALLY A BUG. Registrar-only usually means the
catalog parse dropped something (worth fixing). Catalog-only is often a
recommended-sequence course the registrar counts under a broader rule, or a
course whose requirement is satisfied elsewhere. Read the page before acting —
the output names what to look at, it does not adjudicate.
"""
import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "src"))

from gc_advisor.db.connection import get_connection  # noqa: E402

DB = (
    Path(os.environ["GC_INGEST_DB"])
    if os.environ.get("GC_INGEST_DB")
    else ROOT / "db" / "catalog.db"
)


def catalog_required(con, program_id: int) -> set[str]:
    return {
        r[0]
        for r in con.execute(
            "SELECT pi.course_code FROM plan_item pi "
            "JOIN requirement_group rg ON pi.group_id=rg.id "
            "WHERE rg.program_id=? AND pi.kind='fixed_course' "
            "  AND pi.course_code IS NOT NULL",
            (program_id,),
        )
    }


def registrar_mentions(con, program_id: int) -> set[str]:
    """Every course named ANYWHERE in the registrar's rules — including inside
    choices, attribute rules and alternatives.

    Used to explain the catalog-only direction rather than just report it: a
    course the catalog requires outright is usually stated by the registrar
    under a broader rule ("1 Class in CH 2010 or 2230", "MGT 4150 with
    attribute = GLCH"), which is a vocabulary difference and not a defect. A
    catalog course the registrar never mentions AT ALL is the interesting case.
    """
    out: set[str] = set()
    for (rule,) in con.execute(
        "SELECT rule FROM registrar_requirement WHERE program_id=?", (program_id,)
    ):
        r = json.loads(rule)
        out.update(r.get("courses") or [])
        for alt in r.get("alternatives") or []:
            out.update(alt.get("courses") or [])
    return out


def registrar_required(con, program_id: int) -> set[str]:
    out: set[str] = set()
    for (rule,) in con.execute(
        "SELECT rule FROM registrar_requirement WHERE program_id=?", (program_id,)
    ):
        r = json.loads(rule)
        if r.get("alternatives") or r.get("attribute") or r.get("wildcards"):
            continue
        courses = r.get("courses") or []
        # A single course with no alternative is a hard requirement. An "and"
        # list is too — every course in it is required.
        if len(courses) == 1 or r.get("conjunction") == "and":
            out.update(courses)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--year")
    a = ap.parse_args()

    con = get_connection(DB)
    rows = con.execute(
        "SELECT p.id, p.name, cy.label FROM program p "
        "JOIN catalog_year cy ON p.catalog_year_id=cy.id "
        "WHERE p.id IN (SELECT DISTINCT program_id FROM registrar_requirement) "
        "ORDER BY cy.label, p.name"
    ).fetchall()
    if not rows:
        print("No registrar requirements imported yet "
              "(scripts/import_registrar_audit.py).")
        return

    total_missing = 0
    for pid, name, year in rows:
        if a.year and year != a.year:
            continue
        cat = catalog_required(con, pid)
        reg = registrar_required(con, pid)
        only_reg = sorted(reg - cat)
        only_cat = sorted(cat - reg)
        total_missing += len(only_reg)
        print(f"\n{name} — {year}")
        print(f"  catalog requires {len(cat)}, registrar requires {len(reg)}")
        if only_reg:
            print(f"  REGISTRAR ONLY (check the catalog page): {', '.join(only_reg)}")
        if only_cat:
            mentioned = registrar_mentions(con, pid)
            broader = [c for c in only_cat if c in mentioned]
            unknown = [c for c in only_cat if c not in mentioned]
            if broader:
                print(f"  catalog requires outright, registrar states under a "
                      f"broader rule (expected): {', '.join(broader)}")
            if unknown:
                print(f"  CATALOG ONLY, registrar never mentions: "
                      f"{', '.join(unknown)}")
        if not only_reg and not only_cat:
            print("  agree")
    print(f"\n{total_missing} course(s) required by the registrar and absent "
          f"from the catalog plan.")


if __name__ == "__main__":
    main()
