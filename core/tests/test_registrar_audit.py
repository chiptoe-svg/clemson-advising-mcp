"""Degree Works audit -> requirement rules (gc_advisor.ingest.registrar_audit).

Every fixture line here is REAL Degree Works notation, taken verbatim from the
Packaging Science What-If audits Chip pulled on 2026-09-08 (What-If, so no real
student: the audits render as "Jane Doe / C00000000 / GPA 0.00", and only the
requirement lines are reproduced — no name, ID, GPA, or course history).

The point of the module under test is that the REGISTRAR states requirements in
a small formal notation, where the catalog states them in prose that varies by
college. These tests pin the notation.
"""
from gc_advisor.ingest.registrar_audit import parse_audit, parse_requirement


# ---------------------------------------------------------------------------
# The notation, requirement by requirement
# ---------------------------------------------------------------------------


def test_elided_subject_expands():
    """Degree Works omits a repeated subject: the bare 1030 is POSC 1030."""
    r = parse_requirement("3 Credits in HIST 1010 or POSC 1010 or 1030")
    assert r.need == 3 and r.unit == "credits"
    assert r.courses == ["HIST 1010", "POSC 1010", "POSC 1030"]


def test_credits_and_classes_are_different_units():
    """"1 Class in CH 1010" is not "1 credit" — conflating them mis-sizes a
    requirement, so the unit is carried, never normalized away."""
    assert parse_requirement("1 Class in CH 1010").unit == "classes"
    assert parse_requirement("3 Credits in ENGL 1030").unit == "credits"


def test_attribute_requirement_has_no_course_list():
    """"@ @ with attribute = LIT" is satisfied by ANY course carrying the
    attribute; an empty course list here is correct, not a parse failure."""
    r = parse_requirement("3 Credits in @ @ with attribute = LIT")
    assert r.attribute == "LIT"
    assert r.courses == []
    assert not r.is_empty()  # the attribute IS the satisfaction rule


def test_exclusions_capture_every_subject_in_the_clause():
    """"Except AGRB @ or ECON @" excludes BOTH subjects. Anchoring one course
    reference to the word "Except" caught only AGRB and silently left ECON
    satisfying a requirement the registrar excludes."""
    r = parse_requirement(
        "3 Credits in @ @ with attribute = SOSC Except AGRB @ or ECON @"
    )
    assert r.attribute == "SOSC"
    assert sorted(r.excludes) == ["AGRB @", "ECON @"]


def test_excluded_courses_are_not_also_read_as_options():
    r = parse_requirement("9 Credits in ACCT 3000:4999 Except ECON 3990")
    assert "ECON 3990" not in r.courses
    assert r.excludes == ["ECON 3990"]


def test_range_becomes_a_wildcard():
    r = parse_requirement("9 Credits in ACCT 3000:4999")
    assert r.wildcards == [{"type": "dept_level_min", "dept": "ACCT", "min": 3000}]
    assert r.courses == []  # the range's own codes are not options


def test_any_subject_range_is_an_unscoped_level_wildcard():
    r = parse_requirement("6 Credits in @ 3000:4999")
    assert r.wildcards == [{"type": "level_min", "min": 3000}]


def test_residency_flag():
    r = parse_requirement(
        "3 Credits in FNPS 3680 with attribute = GLCH and resident= Y"
    )
    assert r.resident_required is True
    assert parse_requirement("3 Credits in PKSC 3200 with attribute = GLCH").resident_required is False


# ---------------------------------------------------------------------------
# Whole-audit behaviour
# ---------------------------------------------------------------------------

# Verbatim excerpt: a requirement, then the block boundary, then prose that
# names courses. The REACH requirement used to run past the boundary and take
# PKSC 1020/2020/2040/2060 into its option list.
BLOCK_BOUNDARY = """SC REACH ACT REQUIREMENT Still needed: 3 Credits in HIST 1010 or POSC 1010 or 1030
Major in Packaging Science INCOMPLETE
Catalog year: 2026-2027
Undergraduates in the BS Packaging Science Program are required to: 1) Complete PKSC 1020, 2020, 2040 and 2060 with a grade of C or better before being
allowed to register for PKSC 4010, 4040, 4160, 4300, 4400, 4540, 4640.
"""


def test_a_rule_stops_at_its_block_boundary():
    reqs = parse_audit(BLOCK_BOUNDARY)
    assert len(reqs) == 1
    name, r = reqs[0]
    assert r.courses == ["HIST 1010", "POSC 1010", "POSC 1030"], (
        "the REACH rule absorbed the next block's prose and gained PKSC courses"
    )


# Verbatim excerpt: Degree Works wraps the rule AND the display name, and
# interleaves them — "Approved Coursework) (12 Cr)" sits in the MIDDLE of the
# option list. The rule must survive that.
WRAPPED_WITH_INTERLEAVED_NAME = """BREADTH REQUIREMENT (OPTION 2 - Still needed: 12 Credits in ACCT 2010 or AGM 2050 or 4060 or 4600 or BCHM 3050
Approved Coursework) (12 Cr)
or BIOE 2010 or 3020 or 3200 or 4010 or BIOL 1040 or 1060 or
1110 or 2220 or CHE 3190 or ECON 3140 or 3190 or EES 2010 or
2020 or ENR 4290 or ENSP 2000 or 4000 or FDSC 4010 or 4020 or
4040 or FNPS 2140 or GC 3460 or 4060 or 4070 or 4510 or LAW 3220
or MATH 1080 or 2060 or MGT 2010 or 3030 or 3170 or 4240 or
MICR 3050 or 4070 or MKT 3010 or 3020 or MSE 2100 or 3190
or PHYS 2080 or 2100 or 2210 or 2230 or PKSC 4210 or 4220 or 4230
or 4240 or 4990
"""


def test_wrapped_rule_survives_an_interleaved_name_fragment():
    (name, r), = parse_audit(WRAPPED_WITH_INTERLEAVED_NAME)
    assert r.need == 12 and r.unit == "credits"
    # Spans the whole wrapped list, first line to last.
    assert r.courses[0] == "ACCT 2010"
    assert r.courses[-1] == "PKSC 4990"
    # Elided subjects expand across line breaks: "or 4060" after "AGM 2050",
    # and "1110 or 2220" continuing BIOL from the previous line.
    assert "AGM 4060" in r.courses
    assert "BIOL 1110" in r.courses and "BIOL 2220" in r.courses
    assert len(r.courses) > 45


def test_prose_only_requirements_are_dropped_not_emitted_empty():
    """"Still needed: A minimum of 120 credits is required" states no options.
    Emitting it as a requirement with zero ways to satisfy it would read as
    unmeetable — worse than not emitting it."""
    text = (
        "MINIMUM CREDITS REQUIRED FOR THIS Still needed: A minimum of 120 "
        "credits is required. You currently have 9 credits applied\n"
    )
    assert parse_audit(text) == []


def test_2_0_gpa_and_see_section_pointers_are_dropped():
    text = (
        "2.0 GPA REQUIREMENT Still needed: A 2.0 is required for your degree to graduate.\n"
        "MAJOR REQUIREMENTS Still needed: See Major in Packaging Science section\n"
    )
    assert parse_audit(text) == []
