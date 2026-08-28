from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest import crawl_courses as cc
from gc_advisor.models import CourseRef

def test_discover_all_coids_paginates_until_empty():
    pages = {1: [(1,"ACCT 2010","A"),(2,"ACCT 2020","B")], 2: [(3,"BIOL 1030","C")], 3: []}
    def fake_list(catoid, navoid, cpage):
        return [CourseRef(coid=c, code=k, title=t) for c,k,t in pages.get(cpage, [])]
    refs = cc.discover_all_coids(catoid=49, navoid=1988, fetch_page=fake_list)
    assert [r.coid for r in refs] == [1, 2, 3]

def test_crawl_courses_freezes_and_syncs(tmp_path, fixtures_dir):
    db = tmp_path / "t.db"; init_db(db)
    raw = tmp_path / "raw"
    refs = [CourseRef(coid=283323, code="ACCT 3110", title="Intermediate Financial Accounting I")]
    detail = (fixtures_dir / "course_acct3110.txt").read_text()
    res = cc.crawl_courses(db, raw, catoid=49,
                           discover=lambda **k: refs,
                           render=lambda url: detail,
                           synced_at="2026-06-23")
    con = get_connection(db)
    row = con.execute("SELECT code, credits, prereq_text, source_url FROM course WHERE code='ACCT 3110'").fetchone()
    assert row["code"] == "ACCT 3110" and row["credits"] == "3"
    assert "ACCT 2010" in row["prereq_text"]
    # citation URL is the shareable full page (not the ajax scrape endpoint)
    assert row["source_url"] == "https://catalog.clemson.edu/preview_course_nopop.php?catoid=49&coid=283323"
    assert (raw / "courses" / "283323.txt").exists()
    assert res["parsed"] == 1 and res["discovered"] == 1

def test_crawl_skips_already_frozen(tmp_path, fixtures_dir):
    db = tmp_path / "t.db"; init_db(db)
    raw = tmp_path / "raw"; (raw / "courses").mkdir(parents=True)
    (raw / "courses" / "283323.txt").write_text((fixtures_dir / "course_acct3110.txt").read_text())
    calls = {"n": 0}
    def render(url):
        calls["n"] += 1
        return "should not be called"
    cc.crawl_courses(db, raw, catoid=49,
                     discover=lambda **k: [CourseRef(283323, "ACCT 3110", "x")],
                     render=render, synced_at="2026-06-23")
    assert calls["n"] == 0
