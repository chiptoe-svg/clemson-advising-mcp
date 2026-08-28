from gc_advisor.ingest.parse_course_page import parse_course_page


def _page(heading, credits_line, body):
    # minimal real-shaped course page text
    return f"Print (opens a new window)\n{heading}\n{credits_line}\n{body}\n"


def test_prereq_stops_before_grad_counterpart_note():
    txt = _page(
        "AGRB 4110 - Agricultural Finance",
        "3 Credits (3 Contact Hours)",
        "Study of agricultural finance. Preq: AGRB 2020; or both ECON 2110 and "
        "ECON 2120. This 4000-level course has a 6000-level counterpart. Students "
        "should refer to the Graduate Catalog for the 6000-level description and requirements.",
    )
    c = parse_course_page(txt)
    assert "counterpart" not in (c.prereq_text or "")
    assert "Graduate Catalog" not in (c.prereq_text or "")
    assert c.prereq_text == "AGRB 2020; or both ECON 2110 and ECON 2120"
    assert c.prereq_codes == ["AGRB 2020", "ECON 2110", "ECON 2120"]


def test_nbsp_normalized_in_prereq():
    txt = _page("WFB 4400 - Wildlife Management",
                "3 Credits (3 Contact Hours)",
                "Management of wildlife. Preq: WFB 3000\xa0and WFB 3500.")
    c = parse_course_page(txt)
    assert "\xa0" not in (c.prereq_text or "")
    assert c.prereq_text == "WFB 3000 and WFB 3500"
    assert c.prereq_codes == ["WFB 3000", "WFB 3500"]


def test_parse_course_with_prereq(fixtures_dir):
    c = parse_course_page((fixtures_dir / "course_acct3110.txt").read_text())
    assert c.code == "ACCT 3110"
    assert c.subject == "ACCT" and c.number == "3110"
    assert c.title == "Intermediate Financial Accounting I"
    assert c.credits == "3"
    assert c.prereq_text and "ACCT 2010" in c.prereq_text
    assert "Preq:" not in c.description
    assert "In-depth" in c.description


def test_parse_course_without_prereq(fixtures_dir):
    c = parse_course_page((fixtures_dir / "course_acct2010.txt").read_text())
    assert c.code == "ACCT 2010"
    assert c.credits == "3"
    assert c.prereq_text is None
    assert "accounting" in c.description.lower()


def test_prereq_codes_extracted(fixtures_dir):
    c = parse_course_page((fixtures_dir / "course_acct3110.txt").read_text())
    assert "ACCT 2010" in c.prereq_codes


def test_parses_ajax_fragment_with_duplicated_heading():
    # ajax/preview_course.php repeats the title (link + table heading). The
    # parser must skip the duplicate so credits/description stay correct.
    txt = (
        "GC 1010 - Orientation to Graphic Communications\n\n"
        "Add to Portfolio (opens a new window) [Print Course (opens a new window)]\n"
        "GC 1010 - Orientation to Graphic Communications\n"
        "1 Credit (1 Contact Hour)\n"
        "Introduction to the curriculum and the industry. To be taken Pass/No Pass only.\n"
    )
    c = parse_course_page(txt)
    assert c.code == "GC 1010"
    assert c.credits == "1"                       # was None before the fix
    assert c.description.startswith("Introduction to the curriculum")
    assert "GC 1010" not in c.description          # duplicated heading not leaked
