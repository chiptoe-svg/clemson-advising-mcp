"""Silent plan-item drops in parse_program — the defect class this file exists
to keep closed.

WHY (2026-09-08): five years of Packaging Science were ingested and reported
`issues=[]` while quietly dropping requirements. The DegreeWorks What-If audits
Chip pulled disagreed with the parse, and reading the catalog pages showed the
parser skipping any line its two regexes did not match — with no signal at all.
`validate_program` could not catch it: it compared the page's STATED per-term
totals against the page's STATED program total. Both are printed figures, so
they agree even when every item between them was dropped.

THE INVARIANT, and the whole point of this file:

    for every term group: sum(item credits) == the group's printed
    "Credit Hours: N"

It needs no external oracle — the page states both halves — so it detects a
drop the moment it happens, including in shapes nobody has thought of yet.

Each test below is a REAL page excerpt, verbatim, from the year named. Each one
failed when written; that is what makes them evidence rather than decoration.
"""
import pytest

from gc_advisor.ingest.parse_program import parse_program


def _one_term(body: str) -> str:
    """Wrap a term body in the minimum scaffolding parse_program requires."""
    return "Some Program, BS\nProgram Requirements\nFreshman Year\nFirst Semester\n" + body


def _items(term_body: str):
    prog = parse_program(_one_term(term_body), kind="major", degree="BS")
    assert prog.groups, "no group parsed at all"
    return prog.groups[0]


def _credit_sum(group) -> int:
    return sum(i.credits or 0 for i in group.items)


# ---------------------------------------------------------------------------
# Class A — a malformed course line (no title, no credits).
# Packaging Science 2024-2025 prints "PKSC 4050 2": course code plus footnote
# ref, missing the " - Title N Credits" the page uses everywhere else. The
# course vanished, and DegreeWorks lists it ("Sustainable Packaging Systems
# (3 Cr) Still needed: 3 Credits in PKSC 4050").
# ---------------------------------------------------------------------------

PKSC_2425_SENIOR_FIRST = """PKSC 4050 2
PKSC 4160 - Application of Polymers in Packaging 4 Credits 2
PKSC 4640 - Food and Health Care Packaging Systems 4 Credits 2
Breadth Requirement 4 Credits 8
Credit Hours: 15
"""


def test_malformed_course_line_is_not_silently_dropped():
    g = _items(PKSC_2425_SENIOR_FIRST)
    codes = [i.course_code for i in g.items if i.course_code]
    assert "PKSC 4050" in codes, (
        "PKSC 4050 was dropped: the page line carries no title/credits, so "
        "COURSE_RE did not match and nothing reported it"
    )


def test_malformed_course_line_group_arithmetic():
    g = _items(PKSC_2425_SENIOR_FIRST)
    assert g.credit_total == 15
    # 4050 has no printed credits, so it cannot contribute; what matters is that
    # the shortfall is VISIBLE rather than silent.
    assert _credit_sum(g) + 3 == g.credit_total or _credit_sum(g) == g.credit_total


# ---------------------------------------------------------------------------
# Class B — an unrecognized line drops AND leaks a pending choice.
# Accounting 2026-2027 (the CURRENT catalog year). "South Carolina REACH Act
# 3 Credits 1,2" matches neither COURSE_RE (no ' - ') nor SLOT_RE (no
# "Requirement"/"Elective"), so it is skipped — and because it never flushes
# `pending_choice`, ACCT 2010 stays pending and is swept into the NEXT or-group,
# merging two distinct requirements into one three-way choice.
# ---------------------------------------------------------------------------

ACCT_2627_SOPH_FIRST = """ACCT 2010 - Financial Accounting Concepts 3 Credits 1

or

South Carolina REACH Act 3 Credits 1,2



CPSC 2200 - Problem Solving with Office Applications 3 Credits

or

MGT 2180 - Management Personal Computer Applications 3 Credits



Arts and Humanities (Non-Literature) Requirement 3 Credits 3
Elective 5 Credits
Credit Hours: 14
"""


def test_two_or_groups_do_not_merge_into_one_choice():
    g = _items(ACCT_2627_SOPH_FIRST)
    choices = [i for i in g.items if i.kind == "choice"]
    merged = [c for c in choices if c.one_of and len(c.one_of) > 2 and "ACCT 2010" in c.one_of]
    assert not merged, (
        f"two distinct or-groups merged into one choice: {[c.one_of for c in choices]} — "
        "a student is told to pick ONE of three when two separate requirements apply"
    )


def test_two_or_groups_group_arithmetic():
    g = _items(ACCT_2627_SOPH_FIRST)
    assert g.credit_total == 14
    assert _credit_sum(g) == g.credit_total, (
        f"items sum to {_credit_sum(g)} but the page prints 14 — a requirement was lost"
    )


# ---------------------------------------------------------------------------
# Class C1 — an "or" printed at the END of a course line rather than on its own.
# Graphic Communications 2021-2022. COURSE_RE anchors on `$` after the credits
# and optional footnote refs, so a trailing " or" fails the match and the line
# is skipped. Only the LAST option (a clean line) survives — and it survives as
# a REQUIRED course, telling a student they must take PSYC 3680 when MGT 3070
# would satisfy the same requirement. A false requirement, not just a gap.
# ---------------------------------------------------------------------------

GC_2122_SENIOR_FIRST = """GC 4440 - Current Developments and Trends in Graphic Communications 4 Credits



MGT 3070 - Human Resource Management 3 Credits or
PSYC 3640 - Industrial Psychology 3 Credits or
PSYC 3680 - Organizational Psychology 3 Credits



Graphic Communication Technical Req. 6 Credits 6
Specialty Area Requirement 3 Credits 2
Credit Hours: 16
"""


def test_inline_trailing_or_is_a_choice_not_a_required_course():
    g = _items(GC_2122_SENIOR_FIRST)
    fixed = [i.course_code for i in g.items if i.kind == "fixed_course"]
    assert "PSYC 3680" not in fixed, (
        "PSYC 3680 became a REQUIRED course; it is one of three alternatives "
        "(MGT 3070 or PSYC 3640 or PSYC 3680)"
    )
    choices = [i for i in g.items if i.kind == "choice"]
    assert any(
        c.one_of and {"MGT 3070", "PSYC 3640", "PSYC 3680"} <= set(c.one_of)
        for c in choices
    ), f"the three-way choice was not preserved: {[c.one_of for c in choices]}"


# ---------------------------------------------------------------------------
# Class C2 — an abbreviated slot name. Same GC page: "Graphic Communication
# Technical Req. 6 Credits 6". SLOT_RE requires the literal "Requirement" or
# "Elective", so "Req." fails and six credits disappear.
# ---------------------------------------------------------------------------


def test_abbreviated_slot_name_is_captured():
    g = _items(GC_2122_SENIOR_FIRST)
    slots = [i.slot_type for i in g.items if i.kind == "slot" and i.slot_type]
    assert any("Technical Req" in s for s in slots), (
        f"the 6-credit 'Technical Req.' slot was dropped; slots parsed: {slots}"
    )


def test_gc_2122_group_arithmetic():
    g = _items(GC_2122_SENIOR_FIRST)
    assert g.credit_total == 16
    assert _credit_sum(g) == g.credit_total, (
        f"items sum to {_credit_sum(g)} but the page prints 16"
    )


# ---------------------------------------------------------------------------
# The invariant itself, stated once as a reusable check. Any future page shape
# that drops an item fails HERE even if no test above describes it.
# ---------------------------------------------------------------------------

ALL_EXCERPTS = {
    "PKSC 2024-2025 Senior/First": (PKSC_2425_SENIOR_FIRST, 15),
    "Accounting 2026-2027 Sophomore/First": (ACCT_2627_SOPH_FIRST, 14),
    "GC 2021-2022 Senior/First": (GC_2122_SENIOR_FIRST, 16),
}


@pytest.mark.parametrize("name", sorted(ALL_EXCERPTS))
def test_printed_credit_hours_equal_parsed_item_credits(name):
    body, expected = ALL_EXCERPTS[name]
    g = _items(body)
    assert g.credit_total == expected
    parsed = _credit_sum(g)
    assert parsed == expected, (
        f"{name}: the page prints 'Credit Hours: {expected}' but the parsed items "
        f"sum to {parsed}. Items were dropped or misparsed."
    )


# ---------------------------------------------------------------------------
# Class D — "(A and B) or (C and D)": a choice between PAIRS, with the "and"
# printed at the end of each pair's first line. Packaging Science 2022-2023.
# The lecture lines failed COURSE_RE and vanished (6 credits from this term),
# leaving the lab lines as a bogus 1-credit choice. DegreeWorks encodes the
# same block position-wise — "1 Class in CH 2010 or 2230" and "1 Class in
# CH 2020 or 2270" — which is what we emit.
# ---------------------------------------------------------------------------

PKSC_2223_SOPH_FIRST = """CH 2010 - Survey of Organic Chemistry 3 Credits and
CH 2020 - Survey of Organic Chemistry Laboratory 1 Credits

or

CH 2230 - Organic Chemistry 3 Credits and
CH 2270 - Organic Chemistry Laboratory 1 Credit

 

PHYS 1220 - Physics with Calculus I 3 Credits and
PHYS 1240 - Physics Laboratory I 1 Credit

or

PHYS 2070 - General Physics I 3 Credits and
PHYS 2090 - General Physics I Laboratory 1 Credit

 

PKSC 2020 - Packaging Materials and Manufacturing 4 Credits 1
PKSC 2200 - Product/Package Design and Prototyping 4 Credits 1
Credit Hours: 16
"""


def test_and_pairs_keep_the_lecture_courses():
    g = _items(PKSC_2223_SOPH_FIRST)
    seen = {c for i in g.items for c in (i.one_of or [])} | {
        i.course_code for i in g.items if i.course_code
    }
    for code in ("CH 2010", "CH 2230", "PHYS 1220", "PHYS 2070"):
        assert code in seen, f"{code} (a 3-credit lecture) was dropped; parsed: {sorted(seen)}"


def test_and_pairs_split_position_wise_like_degreeworks():
    g = _items(PKSC_2223_SOPH_FIRST)
    choices = [set(i.one_of) for i in g.items if i.kind == "choice" and i.one_of]
    assert {"CH 2010", "CH 2230"} in choices, f"lecture choice missing: {choices}"
    assert {"CH 2020", "CH 2270"} in choices, f"lab choice missing: {choices}"
    assert {"PHYS 1220", "PHYS 2070"} in choices, f"physics lecture choice missing: {choices}"


def test_and_pairs_group_arithmetic():
    g = _items(PKSC_2223_SOPH_FIRST)
    assert g.credit_total == 16
    assert _credit_sum(g) == 16, f"items sum to {_credit_sum(g)}, page prints 16"
