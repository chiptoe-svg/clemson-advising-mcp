import json
import sqlite3


def validate_program(con: sqlite3.Connection, program_id: int) -> list[dict]:
    issues: list[dict] = []
    total = con.execute("SELECT total_credits FROM program WHERE id=?", (program_id,)).fetchone()[0]
    term_sum = con.execute(
        "SELECT COALESCE(SUM(credit_total),0) FROM requirement_group "
        "WHERE program_id=? AND kind='term'", (program_id,)).fetchone()[0]
    if total is not None and term_sum and term_sum != total:
        issues.append({"type": "credit_sum", "program_id": program_id,
                       "expected": total, "got": term_sum})
    # Per-term item arithmetic. The credit_sum check above compares the page's
    # STATED term totals against its STATED program total — both printed
    # figures, so they agree even when every item between them was dropped.
    # That is exactly how five years of Packaging Science ingested as
    # `issues=[]` while losing requirements (2026-09-08). This compares what we
    # PARSED against what the page printed, so a dropped or misparsed item is
    # loud at ingest time instead of silent forever.
    #
    # A reported group is not always OUR bug: Graphic Communications 2020-2021
    # prints "Credit Hours: 16" over items that sum to 15 (and 16 over items
    # summing to 17) — the catalog's own arithmetic. Read the page before
    # changing the parser.
    for gid, label, stated, parsed in con.execute(
        "SELECT rg.id, rg.label, rg.credit_total, "
        "       COALESCE((SELECT SUM(pi.credits) FROM plan_item pi "
        "                  WHERE pi.group_id = rg.id), 0) "
        "  FROM requirement_group rg "
        " WHERE rg.program_id=? AND rg.kind='term' AND rg.credit_total IS NOT NULL",
        (program_id,),
    ):
        if stated != parsed:
            issues.append({"type": "term_item_credits", "group": label,
                           "expected": stated, "got": parsed})
    fn_numbers = {r[0] for r in con.execute(
        "SELECT number FROM footnote WHERE program_id=?", (program_id,))}
    rows = con.execute(
        "SELECT pi.footnote_refs FROM plan_item pi JOIN requirement_group rg "
        "ON pi.group_id=rg.id WHERE rg.program_id=?", (program_id,))
    for (refs_json,) in rows:
        for ref in json.loads(refs_json or "[]"):
            if ref not in fn_numbers:
                issues.append({"type": "dangling_footnote", "ref": ref})
    return issues
