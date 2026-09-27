"""Load hand-reviewed prerequisite expressions into prereq_expression.

The fixture (core/prereqs/plan-courses.json) is the source of truth; this only
copies it in, pinning each row to the exact prereq_text it was reviewed
against. A row whose text no longer matches the course table is REFUSED and
reported, never loaded, so a catalog refresh can't silently pair an old parse
with new text. Replace-all in one transaction: idempotent and rebuild-safe."""
import hashlib
import sqlite3

DDL = """CREATE TABLE IF NOT EXISTS prereq_expression (
  code             TEXT PRIMARY KEY REFERENCES course(code),
  expr             TEXT NOT NULL,
  source_text_hash TEXT NOT NULL,
  note             TEXT
);"""


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_prereq_expressions(con: sqlite3.Connection, fixture: dict) -> dict:
    con.executescript(DDL)
    stale, missing, rows = [], [], []
    for code, entry in sorted(fixture.items()):
        r = con.execute("SELECT prereq_text FROM course WHERE code=?", (code,)).fetchone()
        if r is None:
            missing.append(code)
            continue
        if (r["prereq_text"] or "") != entry["text"]:
            stale.append(code)
            continue
        rows.append((code, entry["expr"], text_hash(entry["text"]), entry.get("note")))
    with con:
        con.execute("DELETE FROM prereq_expression")
        con.executemany(
            "INSERT INTO prereq_expression (code, expr, source_text_hash, note) VALUES (?,?,?,?)",
            rows,
        )
    return {"loaded": len(rows), "stale": stale, "missing_course": missing}
