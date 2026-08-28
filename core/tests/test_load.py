import json
from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.parse_program import parse_program
from gc_advisor.ingest.parse_courses import parse_courses
from gc_advisor.ingest.load import ensure_catalog_year, load_program, sync_courses
from gc_advisor.models import ParsedProgram, ParsedGroup, ParsedItem, Footnote

def _con(tmp_path):
    db = tmp_path / "t.db"
    init_db(db)
    return get_connection(db)

def _program(kind, label):
    return ParsedProgram(
        name=label, kind=kind, degree="BS", total_credits=120,
        description="d",
        groups=[ParsedGroup(label="Year 1", kind="term", credit_total=15,
                            items=[ParsedItem(kind="fixed_course", credits=3,
                                              course_code="GC 1010")])],
        footnotes=[Footnote(number=1, text="footnote text")],
    )

def test_two_programs_at_same_poid_different_kind_both_survive(tmp_path):
    """Regression for the Pre-Business data-loss defect: one Clemson catalog
    page (one poid) can yield two logically distinct programs, e.g. the
    Marketing, BS major page also yields Pre-Business. Loading the major at a
    poid must not delete a different-kind program already stored at that same
    poid."""
    con = _con(tmp_path)
    cy = ensure_catalog_year(con, label="2026-2027", catoid=49)
    pid_a = load_program(con, cy, _program("pre_business", "Pre-Business"),
                         poid=16767, source_url="u", source_hash="h1")
    pid_b = load_program(con, cy, _program("major", "Marketing, BS"),
                         poid=16767, source_url="u", source_hash="h2")

    assert pid_a != pid_b
    rows = con.execute(
        "SELECT id, kind FROM program WHERE catalog_year_id=? AND poid=? ORDER BY kind",
        (cy, 16767)).fetchall()
    assert {(r["id"], r["kind"]) for r in rows} == {(pid_a, "pre_business"), (pid_b, "major")}

    for pid in (pid_a, pid_b):
        n_groups = con.execute(
            "SELECT COUNT(*) FROM requirement_group WHERE program_id=?", (pid,)).fetchone()[0]
        n_items = con.execute(
            "SELECT COUNT(*) FROM plan_item WHERE group_id IN "
            "(SELECT id FROM requirement_group WHERE program_id=?)", (pid,)).fetchone()[0]
        n_fn = con.execute(
            "SELECT COUNT(*) FROM footnote WHERE program_id=?", (pid,)).fetchone()[0]
        assert n_groups == 1 and n_items == 1 and n_fn == 1

def test_load_program_persists_groups_and_footnotes(tmp_path, fixtures_dir):
    con = _con(tmp_path)
    cy = ensure_catalog_year(con, label="2026-2027", catoid=49)
    text = (fixtures_dir / "gc_program_2026.txt").read_text()
    prog = parse_program(text, kind="major", degree="BS")
    pid = load_program(con, cy, prog, poid=16765, source_url="u", source_hash="h")
    n_groups = con.execute("SELECT COUNT(*) FROM requirement_group WHERE program_id=?", (pid,)).fetchone()[0]
    n_fn = con.execute("SELECT COUNT(*) FROM footnote WHERE program_id=?", (pid,)).fetchone()[0]
    total = con.execute("SELECT total_credits FROM program WHERE id=?", (pid,)).fetchone()[0]
    assert n_groups >= 8 and n_fn == 6 and total == 120

def test_load_program_is_idempotent(tmp_path, fixtures_dir):
    con = _con(tmp_path)
    cy = ensure_catalog_year(con, label="2026-2027", catoid=49)
    text = (fixtures_dir / "gc_program_2026.txt").read_text()
    prog = parse_program(text, kind="major", degree="BS")
    load_program(con, cy, prog, poid=16765, source_url="u", source_hash="h")
    load_program(con, cy, prog, poid=16765, source_url="u", source_hash="h")
    n = con.execute("SELECT COUNT(*) FROM program WHERE poid=16765").fetchone()[0]
    assert n == 1

def test_sync_courses_appends_and_marks_status(tmp_path, fixtures_dir):
    con = _con(tmp_path)
    courses = parse_courses((fixtures_dir / "courses_sample.txt").read_text())
    sync_courses(con, courses, synced_at="2026-06-22")
    sync_courses(con, [c for c in courses if c.code != "GC 4400"], synced_at="2026-07-01")
    row = con.execute("SELECT status FROM course WHERE code='GC 4400'").fetchone()
    assert row["status"] == "retired"
    assert con.execute("SELECT COUNT(*) FROM course").fetchone()[0] == 3

def test_sync_courses_persists_prereq_codes(tmp_path):
    import json as _json
    from gc_advisor.db.connection import init_db, get_connection
    from gc_advisor.ingest.load import sync_courses
    from gc_advisor.models import ParsedCourse
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    c = ParsedCourse(code="ACCT 3110", subject="ACCT", number="3110",
                     title="Intermediate Financial Accounting I", credits="3",
                     description="...", prereq_text="ACCT 2010 with a C or better",
                     prereq_codes=["ACCT 2010"])
    sync_courses(con, [c], synced_at="2026-06-23")
    row = con.execute("SELECT prereq_parsed FROM course WHERE code='ACCT 3110'").fetchone()
    assert row["prereq_parsed"] is not None
    assert _json.loads(row["prereq_parsed"]) == ["ACCT 2010"]

def test_sync_courses_null_prereq_parsed_when_no_codes(tmp_path):
    from gc_advisor.db.connection import init_db, get_connection
    from gc_advisor.ingest.load import sync_courses
    from gc_advisor.models import ParsedCourse
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    c = ParsedCourse(code="ACCT 2010", subject="ACCT", number="2010",
                     title="Financial Accounting Concepts", credits="3",
                     description="...", prereq_text=None, prereq_codes=[])
    sync_courses(con, [c], synced_at="2026-06-23")
    row = con.execute("SELECT prereq_parsed FROM course WHERE code='ACCT 2010'").fetchone()
    assert row["prereq_parsed"] is None
