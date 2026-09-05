import json
import sqlite3
from gc_advisor.models import ParsedProgram, ParsedCourse, GenEdCategory, AcademicRegulation


def ensure_catalog_year(con: sqlite3.Connection, label: str, catoid: int) -> int:
    con.execute(
        "INSERT INTO catalog_year(label, catoid) VALUES(?,?) "
        "ON CONFLICT(label) DO UPDATE SET catoid=excluded.catoid",
        (label, catoid))
    con.commit()
    return con.execute("SELECT id FROM catalog_year WHERE label=?", (label,)).fetchone()[0]


def _delete_program(con, cy_id, poid, kind):
    row = con.execute("SELECT id FROM program WHERE catalog_year_id=? AND poid=? AND kind=?",
                      (cy_id, poid, kind)).fetchone()
    if not row:
        return
    pid = row[0]
    gids = [r[0] for r in con.execute("SELECT id FROM requirement_group WHERE program_id=?", (pid,))]
    for gid in gids:
        con.execute("DELETE FROM plan_item WHERE group_id=?", (gid,))
    con.execute("DELETE FROM requirement_group WHERE program_id=?", (pid,))
    con.execute("DELETE FROM footnote WHERE program_id=?", (pid,))
    con.execute("DELETE FROM requirement_rule WHERE program_id=?", (pid,))
    con.execute("DELETE FROM program WHERE id=?", (pid,))


def load_program(con, cy_id: int, prog: ParsedProgram, poid: int,
                 source_url: str, source_hash: str) -> int:
    _delete_program(con, cy_id, poid, prog.kind)
    cur = con.execute(
        "INSERT INTO program(catalog_year_id, poid, name, kind, degree, total_credits, "
        "description, source_url, source_hash) VALUES(?,?,?,?,?,?,?,?,?)",
        (cy_id, poid, prog.name, prog.kind, prog.degree, prog.total_credits,
         prog.description, source_url, source_hash))
    pid = cur.lastrowid
    for order, g in enumerate(prog.groups):
        gcur = con.execute(
            "INSERT INTO requirement_group(program_id, label, kind, credit_total, ordering) "
            "VALUES(?,?,?,?,?)", (pid, g.label, g.kind, g.credit_total, order))
        gid = gcur.lastrowid
        for io, it in enumerate(g.items):
            con.execute(
                "INSERT INTO plan_item(group_id, kind, course_code, one_of, slot_type, "
                "credits, footnote_refs, ordering) VALUES(?,?,?,?,?,?,?,?)",
                (gid, it.kind, it.course_code, json.dumps(it.one_of) if it.one_of else None,
                 it.slot_type, it.credits, json.dumps(it.footnote_refs), io))
    for fn in prog.footnotes:
        con.execute("INSERT INTO footnote(program_id, number, text) VALUES(?,?,?)",
                    (pid, fn.number, fn.text))
    con.commit()
    return pid


def load_prose_program(con, cy_id: int, prog, poid: int,
                       source_url: str, source_hash: str) -> int:
    """Load a prose-described program (minor/certificate): a program row plus a
    single requirement_rule holding the LLM-extracted structured rule.
    Idempotent via _delete_program (which also clears requirement_rule)."""
    _delete_program(con, cy_id, poid, prog.kind)
    cur = con.execute(
        "INSERT INTO program(catalog_year_id, poid, name, kind, degree, total_credits, "
        "description, source_url, source_hash) VALUES(?,?,?,?,?,?,?,?,?)",
        (cy_id, poid, prog.name, prog.kind, None, prog.total_credits,
         prog.description, source_url, source_hash))
    pid = cur.lastrowid
    con.execute(
        "INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
        (pid, "program_requirement", json.dumps(prog.rule)))
    con.commit()
    return pid


def load_gen_ed(con, cy_id: int, categories: list[GenEdCategory]) -> int:
    """Load gen-ed categories into the database.

    Idempotent: deletes existing rows for the catalog year before inserting.
    Self-migrating: adds the learning_outcome column if an older DB lacks it.
    """
    # self-migrate: add the learning_outcome column if an older DB lacks it
    try:
        con.execute("ALTER TABLE gen_ed_category ADD COLUMN learning_outcome TEXT")
    except Exception:
        pass
    try:
        con.execute("ALTER TABLE gen_ed_category ADD COLUMN subcategories TEXT")
    except Exception:
        pass
    con.execute("DELETE FROM gen_ed_category WHERE catalog_year_id=?", (cy_id,))
    for c in categories:
        con.execute(
            "INSERT INTO gen_ed_category(catalog_year_id, name, min_credits, rules, "
            "allowed_courses, learning_outcome, subcategories) VALUES(?,?,?,?,?,?,?)",
            (cy_id, c.name, c.min_credits, c.rules, json.dumps(c.allowed_courses),
             c.learning_outcome,
             json.dumps(c.subcategories) if c.subcategories else None))
    con.commit()
    return len(categories)


def load_academic_regs(con, cy_id: int, regs: list[AcademicRegulation]) -> int:
    """Load academic regulation sections into the database.

    Idempotent: deletes existing rows for the catalog year before inserting.
    Self-migrating: creates the academic_regulation table if it doesn't exist.
    """
    con.execute(
        "CREATE TABLE IF NOT EXISTS academic_regulation("
        "id INTEGER PRIMARY KEY, "
        "catalog_year_id INTEGER NOT NULL, "
        "section TEXT NOT NULL, "
        "text TEXT NOT NULL)"
    )
    con.execute("DELETE FROM academic_regulation WHERE catalog_year_id=?", (cy_id,))
    for r in regs:
        con.execute(
            "INSERT INTO academic_regulation(catalog_year_id, section, text) VALUES(?,?,?)",
            (cy_id, r.section, r.text))
    con.commit()
    return len(regs)


def sync_courses(con, courses: list[ParsedCourse], synced_at: str) -> None:
    incoming = {c.code for c in courses}
    for c in courses:
        con.execute(
            "INSERT INTO course(code, subject, number, title, credits, description, "
            "prereq_text, prereq_parsed, source_url, status, first_seen, last_synced) "
            "VALUES(?,?,?,?,?,?,?,?,?, 'active', ?, ?) "
            "ON CONFLICT(code) DO UPDATE SET title=excluded.title, credits=excluded.credits, "
            "description=excluded.description, prereq_text=excluded.prereq_text, "
            "prereq_parsed=excluded.prereq_parsed, "
            "source_url=COALESCE(excluded.source_url, course.source_url), "
            "status='active', last_synced=excluded.last_synced",
            (c.code, c.subject, c.number, c.title, c.credits, c.description,
             c.prereq_text, json.dumps(c.prereq_codes) if c.prereq_codes else None,
             c.source_url, synced_at, synced_at))
    existing = [r[0] for r in con.execute("SELECT code FROM course")]
    for code in existing:
        if code not in incoming:
            con.execute("UPDATE course SET status='retired' WHERE code=?", (code,))
    con.commit()
