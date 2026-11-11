"""Comparing the HTML reader with the text parser, program by program. A
difference is either a bug in one reader or a repair the text parser makes on
purpose; the second kind is labelled so it does not hide the first."""
import sqlite3

import pytest

from gc_advisor.ingest.compare_programs import (
    credit_checks,
    diff_programs,
    pre_business_html,
    registrar_lines,
)
from gc_advisor.models import ParsedGroup, ParsedItem, ParsedProgram


def prog(*items, credit_total=None, total=None, label="Freshman/First Semester"):
    return ParsedProgram(
        name="P", kind="major", total_credits=total,
        groups=[ParsedGroup(label=label, kind="term", credit_total=credit_total, items=list(items))],
    )


def course(code, credits=3, refs=()):
    return ParsedItem(kind="fixed_course", course_code=code, credits=credits, footnote_refs=list(refs))


def test_identical_programs_have_no_diffs():
    a = prog(course("GC 1040"), ParsedItem(kind="slot", slot_type="Elective", credits=3))
    b = prog(course("GC 1040"), ParsedItem(kind="slot", slot_type="Elective", credits=3))
    assert diff_programs(a, b) == []


def test_missing_and_changed_items_are_reported():
    text = prog(course("GC 1040", 4), course("GC 1010"))
    html = prog(course("GC 1040", 3), course("GC 2070"))
    kinds = sorted((d.kind, (d.text_item or d.html_item).course_code) for d in diff_programs(text, html))
    assert kinds == [("changed", "GC 1040"), ("only_html", "GC 2070"), ("only_text", "GC 1010")]


def test_layout_artifact_diff_is_labelled():
    reach = "South Carolina REACH Act Requirement"
    # Text parser: the split (course with the cell's credits + slot at 0).
    text = prog(course("ACCT 2010"), ParsedItem(kind="slot", slot_type=reach, credits=0))
    # HTML: what the page prints, one choice.
    html = prog(ParsedItem(kind="choice", one_of=["ACCT 2010"], slot_type=reach, credits=3))
    diffs = diff_programs(text, html)
    assert diffs and all(d.label == "layout artifact" for d in diffs)


def test_unlabelled_choice_difference_has_no_label():
    text = prog(course("PSYC 3680"))
    html = prog(ParsedItem(kind="choice", one_of=["MGT 3070", "PSYC 3680"], credits=3))
    assert all(d.label is None for d in diff_programs(text, html))


def test_groups_only_on_one_side_are_reported():
    text = prog(course("GC 1040"), label="Sophomore/Summer")
    html = ParsedProgram(name="P", kind="major")
    (d,) = diff_programs(text, html)
    assert d.kind == "only_text" and d.group == "Sophomore/Summer"


def test_credit_checks_flag_a_short_term():
    lines = credit_checks(prog(course("GC 1040", 6), course("GC 1010", 6), credit_total=15, total=15))
    assert any("Freshman/First Semester" in l and "12" in l and "15" in l for l in lines)


def test_credit_checks_quiet_when_sums_agree():
    assert credit_checks(prog(course("GC 1040", 6), course("GC 1010", 9), credit_total=15, total=15)) == []


@pytest.fixture
def regdb(tmp_path):
    p = tmp_path / "c.db"
    con = sqlite3.connect(p)
    con.executescript(
        """
        CREATE TABLE catalog_year (id INTEGER PRIMARY KEY, label TEXT, catoid INTEGER);
        CREATE TABLE program (id INTEGER PRIMARY KEY, catalog_year_id INTEGER, name TEXT, kind TEXT);
        CREATE TABLE registrar_requirement (id INTEGER PRIMARY KEY, program_id INTEGER, ordering INTEGER,
            display_name TEXT, need INTEGER, unit TEXT, rule TEXT, audit_date TEXT);
        INSERT INTO catalog_year VALUES (1, '2026-2027', 49);
        INSERT INTO program VALUES (1, 1, 'Accounting, BS', 'major');
        INSERT INTO registrar_requirement VALUES
          (1, 1, 0, 'Financial Accounting Concepts', 1, 'classes', '{"courses": ["ACCT 2010"]}', '11/01/2026'),
          (2, 1, 1, 'SC REACH ACT REQUIREMENT', 3, 'credits', '{"courses": ["HIST 1010"]}', '11/01/2026');
        """
    )
    con.commit()
    con.close()
    return p


def test_registrar_lines_name_the_matching_rules(regdb):
    lines = registrar_lines(regdb, "Accounting, BS", "2026-2027", ["ACCT 2010"])
    assert lines == ['Financial Accounting Concepts: 1 classes in {"courses": ["ACCT 2010"]}']


def test_registrar_lines_open_read_only(regdb):
    con = sqlite3.connect(f"file:{regdb}?mode=ro", uri=True)
    with pytest.raises(sqlite3.OperationalError):
        con.execute("DELETE FROM registrar_requirement")
    con.close()
    # and the function never writes: the rows are still there afterwards
    assert len(registrar_lines(regdb, "Accounting, BS", "2026-2027", ["ACCT 2010", "HIST 1010"])) == 2


def test_pre_business_html_side_stops_at_additional_curriculum():
    html = (
        "<h1>Marketing, BS</h1>"
        '<div class="acalog-core"><h2>Program Requirements</h2></div>'
        '<div class="acalog-core"><h3>Pre-Business Freshman Curriculum</h3></div>'
        '<div class="acalog-core"><h4>First Semester</h4><ul>'
        '<li class="acalog-course"><span><a>BUS 1010&nbsp;-&nbsp;T</a> 1 Credit</span></li></ul></div>'
        '<div class="acalog-core"><h5>Credit Hours: 1</h5></div>'
        '<div class="acalog-core"><h3><a name="x"></a>Additional Curriculum</h3></div>'
        '<div class="acalog-core"><h3>Sophomore Year</h3></div>'
        '<div class="acalog-core"><h4>First Semester</h4><ul>'
        '<li class="acalog-course"><span><a>MKT 3010&nbsp;-&nbsp;T</a> 3 Credits</span></li></ul></div>'
        '<div class="acalog-core"><h5>Credit Hours: 3</h5></div>'
    )
    r = pre_business_html(html)
    assert r.program.name == "Pre-Business"
    assert [g.label for g in r.program.groups] == ["Pre-Business Freshman/First Semester"]
