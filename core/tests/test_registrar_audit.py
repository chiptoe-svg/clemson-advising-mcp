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


# ---------------------------------------------------------------------------
# Shapes the Management / GC audits introduced (2026-09-08). Every excerpt is
# verbatim; each one was parsed WRONG before the assertion below existed.
# ---------------------------------------------------------------------------

# "Choose from 1 of the following:" — three whole alternative routes, one of
# which needs FOUR classes. Flattening them into a single option list said
# AS 3090 alone satisfies Oral Communication: false-permissive, which tells a
# student they can graduate when they cannot.
CHOOSE_BLOCK = """GENERAL EDUCATION - Oral Communication Still needed: Choose from 1 of the following:
(3 Cr)
-COMM Coursework 3 Credits in COMM 1500 or 2500 or HON 1950 or 2230
-AS Cluster 4 Classes in AS 3090 and 3100 and 4090 and 4100
-ML Cluster 2 Classes in ML 1010 and 1020
"""


def test_choose_from_keeps_routes_separate():
    (name, r), = parse_audit(CHOOSE_BLOCK)
    assert r.need == 1 and r.unit == "alternatives"
    assert len(r.alternatives) == 3
    comm, aas, ml = r.alternatives
    assert comm.courses == ["COMM 1500", "COMM 2500", "HON 1950", "HON 2230"]
    assert aas.courses == ["AS 3090", "AS 3100", "AS 4090", "AS 4100"]
    assert ml.courses == ["ML 1010", "ML 1020"]
    # The top level must NOT present them as one interchangeable list.
    assert r.courses == []


def test_and_cluster_is_a_conjunction_not_a_choice():
    """"4 Classes in AS 3090 and 3100 and 4090 and 4100" needs ALL four."""
    (_, r), = parse_audit(CHOOSE_BLOCK)
    comm, aas, ml = r.alternatives
    assert aas.conjunction == "and" and aas.need == 4
    assert ml.conjunction == "and" and ml.need == 2
    assert comm.conjunction == "or", "a plain 'or' list must stay a choice"


# An ALREADY-SATISFIED requirement is printed with the course that satisfied
# it instead of a "Still needed:" clause, so the line reads like a
# continuation of the requirement above. This pulled the student's own
# transcript rows into a rule.
SATISFIED_ROWS_FOLLOW = """GENERAL EDUCATION - Social Sciences #1 - Still needed: 3 Credits in PSYC 2010
PSYC 2010 (3 Cr)
GENERAL EDUCATION - Social Sciences #2 - ECON 2110 Principles of Microeconomics IP (3) Fall 2026
ECON 2000 or 2110 (3 Cr)
Chemistry or Physics for Everyone CH 1050 Chemistry in Context I IP (4) Fall 2026
"""


def test_transcript_rows_never_enter_a_rule():
    (name, r), = parse_audit(SATISFIED_ROWS_FOLLOW)
    assert r.courses == ["PSYC 2010"], (
        f"course history leaked into the rule: {r.courses}"
    )


APPLIED_TABLE_FOLLOWS = """Global Business (3 Cr) Still needed: 1 Class in MGT 3030
Required Electives (8 Cr) ART 1030 Visual Arts Studio TR 3 Spring 2026
Satisfied by: APA25 - Art Studio 2D - Advanced Placement (AP)
ELEC 0001 Transfer Elective TR 3 Spring 2026
"""


def test_applied_courses_table_does_not_extend_the_last_rule():
    (name, r), = parse_audit(APPLIED_TABLE_FOLLOWS)
    assert r.courses == ["MGT 3030"], (
        f"the applied-courses table extended the rule: {r.courses}"
    )


def test_multiple_ranges_all_become_wildcards():
    """Management's support area lists ten ranges in one rule."""
    r = parse_requirement(
        "15 Credits in @ 3000:4999 or ARAB 2000:4999 or ASL 2000:4999 or "
        "CHIN 2000:4999 or FR 2000:4999 or GER 2000:4999 or ITAL 2000:4999 or "
        "JAPN 2000:4999 or RUSS 2000:4999 or SPAN 2000:4999"
    )
    assert len(r.wildcards) == 10
    assert {"type": "level_min", "min": 3000} in r.wildcards
    assert {"type": "dept_level_min", "dept": "SPAN", "min": 2000} in r.wildcards
    assert r.courses == [], "range bounds must not be read as course numbers"


def test_rule_stated_on_the_line_below_still_needed():
    """"Still needed:" can be empty with the rule wrapped onto the next line."""
    text = (
        "**GENERAL EDUCATION - Natural Science with Still needed:\n"
        "Lab (4 Cr)\n"
        "-NSWL Coursework 4 Credits in @ @ with attribute = NSWL\n"
    )
    (name, r), = parse_audit(text)
    assert r.need == 4 and r.attribute == "NSWL"
