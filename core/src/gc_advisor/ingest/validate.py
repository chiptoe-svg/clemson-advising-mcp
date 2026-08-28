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
