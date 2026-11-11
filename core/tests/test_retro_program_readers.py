"""The retrospective: for each past parser fix, run the parser as it was just
before and just after the fix on the saved text, take what the fix changed,
and ask whether the HTML reader gets that item right on its own."""
import json
import shutil
from pathlib import Path

from gc_advisor.models import ParsedGroup, ParsedItem, ParsedProgram
from gc_advisor.ingest.parse_program_html import HtmlReading
from scripts.retro_program_readers import pages_to_score, run_parser, score

SRC = Path(__file__).resolve().parent.parent / "src"


def prog(*items):
    return ParsedProgram(name="P", kind="major", groups=[
        ParsedGroup(label="Senior/Second Semester", kind="term", items=list(items))])


def course(code, credits=3):
    return ParsedItem(kind="fixed_course", course_code=code, credits=credits)


CHOICE = ParsedItem(kind="choice", one_of=["MGT 3070", "PSYC 3680"], credits=3)


def test_delta_is_the_items_a_fix_changed():
    before = prog(course("GC 4800"), course("PSYC 3680"))
    after = prog(course("GC 4800"), CHOICE)
    html = HtmlReading(program=prog(course("GC 4800"), CHOICE))
    verdicts = score(before, after, html, after)
    assert sorted(v.change for v in verdicts) == ["added", "removed"]
    assert all("GC 4800" not in v.item for v in verdicts)


def test_verdict_avoided_when_html_matches_after():
    before = prog(course("PSYC 3680"))
    after = prog(CHOICE)
    verdicts = {v.change: v.verdict for v in score(before, after, HtmlReading(program=prog(CHOICE)), after)}
    # The added choice is a real avoid; the removed course is the other half
    # of the same correction, counted apart so it is not counted twice.
    assert verdicts == {"added": "avoided", "removed": "wrong item not produced"}


def test_verdict_not_avoided_when_html_matches_before():
    before = prog(course("PSYC 3680"))
    after = prog(CHOICE)
    verdicts = score(before, after, HtmlReading(program=prog(course("PSYC 3680"))), after)
    assert {v.verdict for v in verdicts} == {"not avoided"}


def test_carried_decision_is_marked():
    before = prog()
    after = prog(course("PKSC 4050", None))
    html = HtmlReading(program=prog(course("PKSC 4050", None)),
                       carried=["Senior/Second Semester: bare course code in an ad-hoc cell read as PKSC 4050"])
    (v,) = score(before, after, html, after)
    assert v.verdict == "avoided" and v.carried


def _tree(tmp_path, body):
    root = tmp_path / "tree"
    (root / "gc_advisor" / "ingest").mkdir(parents=True)
    (root / "gc_advisor" / "__init__.py").write_text("")
    (root / "gc_advisor" / "ingest" / "__init__.py").write_text("")
    shutil.copy(SRC / "gc_advisor" / "models.py", root / "gc_advisor" / "models.py")
    (root / "gc_advisor" / "ingest" / "parse_program.py").write_text(body)
    return root


def test_old_parser_runs_in_its_own_tree(tmp_path):
    root = _tree(tmp_path, (
        "from gc_advisor.models import ParsedProgram, ParsedGroup, ParsedItem\n"
        "def parse_program(text, kind, degree=None):\n"
        "    return ParsedProgram(name=text.strip(), kind=kind, groups=[ParsedGroup(label='X/First Semester', kind='term',"
        " items=[ParsedItem(kind='fixed_course', course_code='GC 1040', credits=4)])])\n"))
    page = tmp_path / "p.txt"
    page.write_text("Hello")
    out = run_parser(root, [{"key": "a", "path": str(page), "kind": "major", "degree": "BS", "pre_business": False}])
    assert out["a"].name == "Hello" and out["a"].groups[0].items[0].course_code == "GC 1040"


def test_old_parser_crash_is_reported_not_raised(tmp_path):
    root = _tree(tmp_path, "def parse_program(text, kind, degree=None):\n    raise ValueError('old bug')\n")
    page = tmp_path / "p.txt"
    page.write_text("x")
    out = run_parser(root, [{"key": "a", "path": str(page), "kind": "major", "degree": "BS", "pre_business": False}])
    assert isinstance(out["a"], str) and "old bug" in out["a"]


def test_changed_page_is_not_scored(tmp_path):
    pages, raw = tmp_path / "pages", tmp_path / "raw"
    for d in (pages / "2026-2027", raw / "2026-2027"):
        d.mkdir(parents=True)
    (pages / "manifest.json").write_text(json.dumps([
        {"name": "A, BS", "year": "2026-2027", "poid": 1}, {"name": "B, BS", "year": "2026-2027", "poid": 2}]))
    for poid, fresh, saved in ((1, "same", "same"), (2, "new", "old")):
        (pages / "2026-2027" / f"{poid}.txt").write_text(fresh)
        (raw / "2026-2027" / f"{poid}.txt").write_text(saved)
    scored, changed = pages_to_score(pages, raw)
    assert [p["poid"] for p in scored] == [1] and [p["poid"] for p in changed] == [2]


def test_layout_artifact_items_are_not_a_reading_problem():
    reach = "South Carolina REACH Act Requirement"
    before = prog(ParsedItem(kind="choice", one_of=["ACCT 2010"], slot_type=reach, credits=3))
    after = prog(course("ACCT 2010"), ParsedItem(kind="slot", slot_type=reach, credits=0))
    html = HtmlReading(program=prog(ParsedItem(kind="choice", one_of=["ACCT 2010"], slot_type=reach, credits=3)))
    verdicts = score(before, after, html, after)
    assert verdicts and {v.verdict for v in verdicts} == {"not a reading problem"}


def test_judged_against_the_final_reading_not_an_intermediate_one():
    # A fix whose own output was still wrong (an item later removed again by
    # another fix): the HTML never had that item, which is the right answer.
    before = prog(course("GC 4800"))
    after = prog(course("GC 4800"), ParsedItem(kind="slot", slot_type="Elective", credits=1))
    final = prog(course("GC 4800"))
    (v,) = score(before, after, HtmlReading(program=prog(course("GC 4800"))), final)
    assert v.verdict == "wrong item not produced"


def test_course_from_a_printed_artifact_choice_is_not_a_reading_problem():
    # The fix added ACCT 2010 as its own course; the old output had only the
    # slot. The HTML shows the page prints "ACCT 2010 or REACH".
    reach = "South Carolina REACH Act Requirement"
    before = prog(ParsedItem(kind="slot", slot_type=reach, credits=3))
    after = prog(course("ACCT 2010"), ParsedItem(kind="slot", slot_type=reach, credits=0))
    html = HtmlReading(program=prog(ParsedItem(kind="choice", one_of=["ACCT 2010"], slot_type=reach, credits=3)))
    verdicts = {v.item: v.verdict for v in score(before, after, html, after)}
    assert verdicts["ACCT 2010 (3 cr)"] == "not a reading problem"


def test_a_term_the_old_parser_did_not_read_is_counted_apart():
    before = ParsedProgram(name="P", kind="major")
    after = prog(course("GC 4800"))
    (v,) = score(before, after, HtmlReading(program=prog(course("GC 4800"))), after)
    assert v.verdict == "old parser did not read this term"
