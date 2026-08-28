from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.course_urls import backfill_course_source_urls


def _course(con, code, source_url=None):
    subj, num = code.split(" ")
    con.execute("INSERT INTO course(code, subject, number, source_url) VALUES(?,?,?,?)",
                (code, subj, num, source_url))
    con.commit()


def _snapshot(raw_dir, coid, heading, credits, body):
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / f"{coid}.txt").write_text(
        f"Print (opens a new window)\n{heading}\n{credits}\n{body}\n")


def _db(tmp_path):
    p = tmp_path / "t.db"
    init_db(p)
    return get_connection(p)


def test_backfill_sets_source_url_from_snapshot(tmp_path):
    con = _db(tmp_path)
    _course(con, "GC 1010")
    raw = tmp_path / "courses"
    _snapshot(raw, 285006, "GC 1010 - Orientation", "1 Credit", "Intro course.")
    n = backfill_course_source_urls(con, raw, catoid=49)
    assert n == 1
    url = con.execute("SELECT source_url FROM course WHERE code='GC 1010'").fetchone()[0]
    assert url == "https://catalog.clemson.edu/preview_course_nopop.php?catoid=49&coid=285006"


def test_idempotent_and_no_clobber(tmp_path):
    con = _db(tmp_path)
    _course(con, "GC 1010", source_url="https://real.catalog/existing")  # already set
    raw = tmp_path / "courses"
    _snapshot(raw, 285006, "GC 1010 - Orientation", "1 Credit", "Intro course.")
    assert backfill_course_source_urls(con, raw, catoid=49) == 0  # not clobbered
    assert con.execute("SELECT source_url FROM course WHERE code='GC 1010'").fetchone()[0] \
        == "https://real.catalog/existing"


def test_snapshot_for_absent_course_is_skipped(tmp_path):
    con = _db(tmp_path)  # no courses in the table
    raw = tmp_path / "courses"
    _snapshot(raw, 999999, "ZZZ 9999 - Nope", "3 Credits", "x.")
    assert backfill_course_source_urls(con, raw, catoid=49) == 0
