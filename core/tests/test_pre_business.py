from pathlib import Path
import pytest
from gc_advisor.ingest.pre_business import parse_pre_business, PROGRAM_NAME

FIXTURES = Path(__file__).parent / "fixtures"
MKT = FIXTURES / "marketing_program_2026.txt"


@pytest.mark.skipif(not MKT.exists(), reason="marketing fixture missing")
def test_parse_pre_business_from_business_major_page():
    prog = parse_pre_business(MKT.read_text())
    assert prog.name == PROGRAM_NAME
    assert prog.kind == "pre_business"
    assert "common freshman year" in prog.description

    # only the two shared freshman-semester groups (major curriculum excluded)
    labels = [g.label for g in prog.groups]
    assert all("Pre-Business Freshman" in l for l in labels)
    assert len(labels) == 2

    items = [it for g in prog.groups for it in g.items]
    # REACH normalizes to a PLAIN SLOT, never a choice. The catalog's
    # two-column layout merges the adjacent fixed ACCT 2010 into the REACH
    # row; this test previously pinned that artifact (one_of == ["ACCT 2010"])
    # as if it were a real alternative. Registrar truth (DegreeWorks blank
    # What-If, tests/fixtures/registrar/reach-act.txt): REACH is satisfied by
    # HIST 1010 / POSC 1010 / POSC 1030 or an exemption — ACCT 2010 is not an
    # option. Left as a choice, run_audit's pass 1 read one_of directly and
    # every business student holding ACCT 2010 audited REACH as MET.
    # ACCT 2010 remains a real fixed course on the same page, so nothing is
    # lost by dropping it here.
    reach = next(it for it in items if it.slot_type and "REACH" in it.slot_type)
    assert reach.kind == "slot", f"REACH still parses as {reach.kind!r}"
    assert not reach.one_of
    # The merged row holds TWO requirements, so both are emitted: ACCT 2010 as a
    # course requirement carrying the cell's credits (the What-If lists it
    # separately — "Financial Accounting Concepts (3 Cr) Still needed: 1 Class
    # in ACCT 2010"), and the REACH slot at 0 credits, whose real weight lives
    # in a standalone block cell where the page prints one.
    assert reach.credits == 0
    assert any(it.kind == "fixed_course" and it.course_code == "ACCT 2010"
               and it.credits == 3 for it in items), \
        "ACCT 2010 was dropped instead of emitted as its own requirement"
    assert not any(it.kind == "choice" and it.slot_type and "REACH" in it.slot_type
                   for it in items)
    # the MATH-sequence choice links to its footnotes
    math = next(it for it in items if it.kind == "choice" and "MATH 1020" in it.one_of)
    assert set(math.footnote_refs) >= {2}
    # ECON 2120 stays a fixed course
    assert any(it.kind == "fixed_course" and it.course_code == "ECON 2120" for it in items)
    # pre-business footnotes (N*) captured with text
    assert {f.number for f in prog.footnotes} >= {1, 2, 4, 5}
