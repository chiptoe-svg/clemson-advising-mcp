"""The HTML reader: a program page read from its structure (cores, headings,
list items, the course id on each course link) rather than from flattened
text. It returns the same ParsedProgram the text parser does, so the two can
be compared item by item, plus every list item it could not read (never
dropped) and the Acalog course id of each course. Fixtures are saved catalog
pages (public), each paired with the text of the same page load."""
import pytest

from gc_advisor.ingest.parse_program import parse_program
from gc_advisor.ingest.parse_program_html import (
    UnreadItem,
    parse_program_html,
    read_program_html,
)

FIXTURES = ["gc_2021-2022", "pksc_2022-2023", "pksc_2024-2025", "accounting_2026-2027", "fm_2026-2027"]


def load(fixtures_dir, slug):
    d = fixtures_dir / "html"
    return (d / f"{slug}.html").read_text(), (d / f"{slug}.txt").read_text()


def items(prog):
    return [(g.label, it) for g in prog.groups for it in g.items]


def test_course_ids_are_read(fixtures_dir):
    html, _ = load(fixtures_dir, "gc_2021-2022")
    r = read_program_html(html, "major", "BS")
    assert isinstance(r.course_ids["GC 1040"], int)
    for _, it in items(r.program):
        if it.kind == "fixed_course" and not it.course_code.startswith("PKSC 4050"):
            assert it.course_code in r.course_ids, it.course_code


def test_trailing_or_makes_a_choice(fixtures_dir):
    # The text parser once dropped the first alternative and made the second
    # required (GC 2021-22 senior year: PSYC 3680 or MGT 3070).
    html, _ = load(fixtures_dir, "gc_2021-2022")
    r = read_program_html(html, "major", "BS")
    choices = [it for _, it in items(r.program) if it.kind == "choice"]
    assert any({"PSYC 3680", "MGT 3070"} <= set(c.one_of) for c in choices)


def test_bare_course_cell_is_read_as_that_course_and_marked_carried(fixtures_dir):
    # Packaging Science 2024-25 prints "PKSC 4050 2" as a plain ad-hoc cell,
    # not a course link: the HTML has no more structure than the text here.
    html, _ = load(fixtures_dir, "pksc_2024-2025")
    r = read_program_html(html, "major", "BS")
    pksc = [it for _, it in items(r.program) if it.course_code == "PKSC 4050"]
    assert len(pksc) == 1 and pksc[0].kind == "fixed_course"
    assert "PKSC 4050" not in r.course_ids
    assert any("PKSC 4050" in c for c in r.carried)


def test_reach_or_acct_is_one_choice_as_printed(fixtures_dir):
    # The page prints ACCT 2010, then a list item holding only "or", then the
    # REACH slot. The HTML reader reports what is printed; the text parser's
    # layout-artifact split is not applied here (the report labels it).
    html, _ = load(fixtures_dir, "accounting_2026-2027")
    r = read_program_html(html, "major", "BS")
    reach = [
        it for _, it in items(r.program)
        if it.kind == "choice" and it.slot_type == "South Carolina REACH Act Requirement"
    ]
    # Printed twice on this page (two terms), both as "ACCT 2010 or REACH".
    assert len(reach) == 2
    assert all(c.one_of == ["ACCT 2010"] and c.credits == 3 for c in reach)


def test_and_pairs_are_read_position_wise_and_marked_carried(fixtures_dir):
    # "(CH 2010 and CH 2020) or (CH 2230 and CH 2270)": Degree Works reads it
    # position-wise, as two choices; the model cannot hold a pair.
    html, _ = load(fixtures_dir, "pksc_2022-2023")
    r = read_program_html(html, "major", "BS")
    one_ofs = [sorted(it.one_of) for _, it in items(r.program) if it.kind == "choice"]
    assert ["CH 2010", "CH 2230"] in one_ofs and ["CH 2020", "CH 2270"] in one_ofs
    assert any("and" in c for c in r.carried)


@pytest.mark.parametrize("slug", FIXTURES)
def test_group_labels_match_text_parser(fixtures_dir, slug):
    html, txt = load(fixtures_dir, slug)
    r = read_program_html(html, "major", "BS")
    assert [g.label for g in r.program.groups] == [g.label for g in parse_program(txt, "major", "BS").groups]


@pytest.mark.parametrize("slug", FIXTURES)
def test_fixture_totals_and_term_credits(fixtures_dir, slug):
    html, txt = load(fixtures_dir, slug)
    h = read_program_html(html, "major", "BS").program
    t = parse_program(txt, "major", "BS")
    assert h.total_credits == t.total_credits
    assert [g.credit_total for g in h.groups] == [g.credit_total for g in t.groups]


@pytest.mark.parametrize("slug", FIXTURES)
def test_footnote_refs_match_text_parser(fixtures_dir, slug):
    # Footnote marks in <sup>: "5*", "5*,6*", "1*, 2*".
    html, txt = load(fixtures_dir, slug)
    h = {(g, it.course_code): it.footnote_refs for g, it in items(read_program_html(html, "major", "BS").program) if it.kind == "fixed_course"}
    t = {(g, it.course_code): it.footnote_refs for g, it in items(parse_program(txt, "major", "BS")) if it.kind == "fixed_course"}
    for key in h.keys() & t.keys():
        assert h[key] == t[key], key


@pytest.mark.parametrize("slug", FIXTURES)
def test_footnotes_match_text_parser(fixtures_dir, slug):
    html, txt = load(fixtures_dir, slug)
    h = read_program_html(html, "major", "BS").program.footnotes
    t = parse_program(txt, "major", "BS").footnotes
    assert [f.number for f in h] == [f.number for f in t]


@pytest.mark.parametrize("slug", FIXTURES)
def test_real_pages_have_nothing_unread_except_prose(fixtures_dir, slug):
    html, _ = load(fixtures_dir, slug)
    r = read_program_html(html, "major", "BS")
    for u in r.unread:
        assert isinstance(u, UnreadItem) and u.text


SNIPPET = """
<h1>Test Program, BS</h1>
<div class="acalog-core"><h2>Program Requirements</h2></div>
<div class="acalog-core"><h3>Freshman Year</h3></div>
<div class="acalog-core"><h4>First Semester</h4><ul>{items}</ul></div>
<div class="acalog-core"><h5>Credit Hours: 6</h5></div>
<div class="acalog-core"><h3>Total Credits: 6</h3></div>
"""
COURSE = (
    '<li class="acalog-course"><span><a href="#" onclick="showCourse(\'49\', \'{coid}\',this); return false;">'
    "{code}&nbsp;-&nbsp;Title</a> 3 Credits{tail}</span></li>"
)


def test_course_or_slot_choice():
    html = SNIPPET.format(
        items=COURSE.format(coid=1, code="GC 3400", tail=" <em>or</em>")
        + '<li class="acalog-adhoc-list-item acalog-adhoc-after">Business Elective 3 Credits</li>'
        + COURSE.format(coid=2, code="GC 1040", tail="")
    )
    r = read_program_html(html, "major", "BS")
    its = r.program.groups[0].items
    assert its[0].kind == "choice" and its[0].one_of == ["GC 3400"] and its[0].slot_type == "Business Elective"
    assert its[1].kind == "fixed_course" and its[1].course_code == "GC 1040"
    assert r.course_ids == {"GC 3400": 1, "GC 1040": 2}
    assert r.program.groups[0].label == "Freshman/First Semester"


def test_unknown_item_is_unread_and_parse_raises():
    html = SNIPPET.format(
        items=COURSE.format(coid=1, code="GC 3400", tail="")
        + '<li class="something-else">Mystery 3 Credits</li>'
    )
    r = read_program_html(html, "major", "BS")
    assert UnreadItem("Freshman/First Semester", "Mystery 3 Credits") in r.unread
    with pytest.raises(ValueError, match="Mystery"):
        parse_program_html(html, "major", "BS")


def test_page_without_program_structure_is_unreadable():
    r = read_program_html("<h1>Not a program</h1><p>Hello</p>", "major", "BS")
    assert r.unread == [UnreadItem(None, "no program structure found")]
    assert r.program.groups == []


def test_slot_in_a_plain_adhoc_item_is_a_slot():
    # Economics BA 2023-24 prints "Minor Requirement 3 Credits" in an
    # li.acalog-adhoc, not li.acalog-adhoc-list-item.
    html = SNIPPET.format(
        items=COURSE.format(coid=1, code="GC 3400", tail="")
        + '<li class="acalog-adhoc acalog-adhoc-after"><p>Minor Requirement 3 Credits</p></li>'
    )
    r = read_program_html(html, "major", "BS")
    assert r.unread == []
    slot = r.program.groups[0].items[1]
    assert slot.kind == "slot" and slot.slot_type == "Minor Requirement" and slot.credits == 3


def test_plain_list_item_slot_is_read_from_its_text_and_marked_carried():
    # Economics 2023-27: hand-typed blocks of bare <li> cells,
    # "<li>Major Requirement 6 Credits <sup>6</sup></li>".
    html = SNIPPET.format(items="<li>Major Requirement 6 Credits <sup>6</sup></li>")
    r = read_program_html(html, "major", "BS")
    assert r.unread == []
    slot = r.program.groups[0].items[0]
    assert (slot.kind, slot.slot_type, slot.credits, slot.footnote_refs) == ("slot", "Major Requirement", 6, [6])
    assert any("plain list item" in c for c in r.carried)


# Final review (2026-11-11).
def test_void_tag_inside_hidden_markup_drops_nothing():
    html = SNIPPET.format(
        items=COURSE.format(coid=1, code="GC 3400", tail="")
        # The hidden element sits right before the item's own </li>.
        + '<li class="acalog-course"><span><a href="#" onclick="showCourse(\'49\', \'2\',this);">'
        'GC 1040&nbsp;-&nbsp;Title</a> 3 Credits</span><span style="display: none">a<br>b</span></li>'
        + COURSE.format(coid=3, code="GC 2000", tail="")
    )
    codes = [it.course_code for it in parse_program_html(html, "major", "BS").groups[0].items]
    assert codes == ["GC 3400", "GC 1040", "GC 2000"]


def test_footnote_number_printed_as_text_starts_a_footnote():
    # Pre-Business 2023-25: "<p>4* See South Carolina REACH Act…</p>", no <sup>.
    html = SNIPPET.format(items=COURSE.format(coid=1, code="GC 3400", tail="")) + (
        '<div class="acalog-core"><h3>Footnotes</h3>'
        "<p><sup>3*</sup> Three.</p><p>4* See South Carolina REACH Act.</p></div>"
    )
    fns = read_program_html(html, "major", "BS").program.footnotes
    assert [(f.number, f.text) for f in fns] == [(3, "Three."), (4, "See South Carolina REACH Act.")]
