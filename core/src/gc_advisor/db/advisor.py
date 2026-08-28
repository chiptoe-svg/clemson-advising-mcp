"""CRUD + read helpers for the advisor_course layer (spec §A.2). Each function
takes an open connection so callers control transactions/lifetime."""
import sqlite3

DEFAULT_PROGRAM = "Graphic Communications, BS"


def add_course(con: sqlite3.Connection, slot_type: str, code: str, *,
               action: str = "allow", catalog_year: str | None = None,
               note: str | None = None, program: str = DEFAULT_PROGRAM,
               added_on: str) -> int:
    """Insert an advisor row; a duplicate (same program/slot/year/code) is a
    no-op via the unique index. Returns the number of rows inserted (1, or 0
    if it already existed). Validates `action` up front so INSERT OR IGNORE
    only ever swallows the intended uniqueness conflict, not a bad value."""
    if action not in ("allow", "deny"):
        raise ValueError(f"action must be 'allow' or 'deny', got {action!r}")
    cur = con.execute(
        "INSERT OR IGNORE INTO advisor_course (program, slot_type, catalog_year, "
        "code, action, note, added_on) VALUES (?,?,?,?,?,?,?)",
        (program, slot_type, catalog_year, code, action, note, added_on))
    con.commit()
    return cur.rowcount


def remove_course(con: sqlite3.Connection, slot_type: str, code: str, *,
                  program: str = DEFAULT_PROGRAM) -> int:
    cur = con.execute(
        "DELETE FROM advisor_course WHERE program=? AND slot_type=? AND code=?",
        (program, slot_type, code))
    con.commit()
    return cur.rowcount


def advisor_sets(con: sqlite3.Connection, slot_type: str,
                 catalog_year: str | None, *,
                 program: str = DEFAULT_PROGRAM) -> tuple[set[str], set[str]]:
    """Allow/deny code sets applicable to `catalog_year` (NULL rows apply to
    every year)."""
    rows = con.execute(
        "SELECT code, action FROM advisor_course WHERE program=? AND slot_type=? "
        "AND (catalog_year IS NULL OR catalog_year=?)",
        (program, slot_type, catalog_year))
    allow: set[str] = set()
    deny: set[str] = set()
    for r in rows:
        (deny if r["action"] == "deny" else allow).add(r["code"])
    return allow, deny


def list_entries(con: sqlite3.Connection, slot_type: str, *,
                 program: str = DEFAULT_PROGRAM) -> list[dict]:
    rows = con.execute(
        "SELECT catalog_year, code, action, note, added_on FROM advisor_course "
        "WHERE program=? AND slot_type=? ORDER BY code",
        (program, slot_type))
    return [dict(r) for r in rows]
