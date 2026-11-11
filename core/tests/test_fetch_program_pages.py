"""Fetching program pages for the HTML reader: each page is loaded ONCE and
both its HTML and its text are kept, so the two readers can never be fed
different versions of a page. The catalog site is fetched politely: one page
at a time, at least 4 s apart, stopping on the first failure; a re-run skips
what is already saved."""
import json
import sqlite3

import pytest

from scripts.fetch_program_pages import PageRef, fetch_all, program_pages


def _page(poid, year="2026-2027", catoid=49, name="Accounting, BS"):
    return PageRef(
        name=name,
        kind="major",
        year=year,
        catoid=catoid,
        poid=poid,
        url=f"https://catalog.clemson.edu/preview_program.php?catoid={catoid}&poid={poid}",
    )


class Recorder:
    def __init__(self, fail_on=None):
        self.calls = []
        self.sleeps = []
        self.fail_on = fail_on

    def render(self, url):
        self.calls.append(url)
        if self.fail_on and self.fail_on in url:
            raise RuntimeError("render failed")
        return f"<div>{url}</div>", f"text of {url}"

    def sleep(self, s):
        self.sleeps.append((len(self.calls), s))


def test_fetch_saves_both_forms_and_manifest(tmp_path):
    rec = Recorder()
    res = fetch_all([_page(1), _page(2)], tmp_path, render=rec.render, sleep=rec.sleep)
    assert res.fetched == 2 and res.skipped == 0 and res.failed is None
    for poid in (1, 2):
        assert (tmp_path / "2026-2027" / f"{poid}.html").read_text().startswith("<div>")
        assert (tmp_path / "2026-2027" / f"{poid}.txt").read_text().startswith("text of")
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert [m["poid"] for m in manifest] == [1, 2]
    assert all(m["fetched_at"] for m in manifest)


def test_fetch_skips_saved_pages(tmp_path):
    d = tmp_path / "2026-2027"
    d.mkdir()
    (d / "1.html").write_text("<div>old</div>")
    (d / "1.txt").write_text("old")
    rec = Recorder()
    res = fetch_all([_page(1), _page(2)], tmp_path, render=rec.render, sleep=rec.sleep)
    assert res.skipped == 1 and res.fetched == 1
    assert len(rec.calls) == 1 and "poid=2" in rec.calls[0]
    assert (d / "1.html").read_text() == "<div>old</div>"


def test_fetch_paces_at_least_4s(tmp_path):
    rec = Recorder()
    fetch_all([_page(1), _page(2), _page(3)], tmp_path, render=rec.render, sleep=rec.sleep)
    # Never before the first render; between every pair after it.
    assert [n for n, _ in rec.sleeps] == [1, 2]
    assert all(s >= 4.0 for _, s in rec.sleeps)


def test_fetch_stops_on_first_failure(tmp_path):
    rec = Recorder(fail_on="poid=2")
    res = fetch_all([_page(1), _page(2), _page(3)], tmp_path, render=rec.render, sleep=rec.sleep)
    assert res.failed.poid == 2
    assert not any("poid=3" in c for c in rec.calls)
    assert not (tmp_path / "2026-2027" / "2.html").exists()
    assert not (tmp_path / "2026-2027" / "2.txt").exists()


def test_program_pages_reads_majors_only(tmp_path):
    db = tmp_path / "c.db"
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE catalog_year (id INTEGER PRIMARY KEY, label TEXT, catoid INTEGER);
        CREATE TABLE program (id INTEGER PRIMARY KEY, catalog_year_id INTEGER, name TEXT,
                              kind TEXT, source_url TEXT);
        INSERT INTO catalog_year VALUES (1, '2026-2027', 49);
        INSERT INTO program VALUES
          (1, 1, 'Accounting, BS', 'major', 'https://catalog.clemson.edu/preview_program.php?catoid=49&poid=16761'),
          (2, 1, 'Pre-Business', 'pre_business', 'https://catalog.clemson.edu/preview_program.php?catoid=49&poid=16765'),
          (3, 1, 'Accounting Minor', 'minor', 'https://catalog.clemson.edu/preview_program.php?catoid=49&poid=16900');
        """
    )
    con.commit()
    con.close()
    pages = program_pages(db)
    assert pages == [_page(16761)]
