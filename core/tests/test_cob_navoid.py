"""College of Business programs-index navoid discovery.

scripts/ingest_year.py hardcoded navoid=1996 with a "verify per year" comment.
It is in fact only correct for 2026-2027 — ingesting Marketing for 2023-24,
2024-25 or 2025-26 with it fails outright, so the navoid must be discovered
per catalog year.
"""
import pytest
from gc_advisor.ingest.discover import parse_cob_navoid

LINKED = ('<ul><li><a href="content.php?catoid=49&navoid=1996">'
          '<span>College of Business</span></a></li>'
          '<li><a href="content.php?catoid=49&navoid=1990">'
          '<span>College of Engineering</span></a></li></ul>')

LOOSE = '<a href="content.php?catoid=39&navoid=1701">Business College</a>'

FALLBACK = '<div>navoid=1234 &mdash; Business programs</div>'


def test_finds_navoid_from_college_of_business_link():
    assert parse_cob_navoid(LINKED) == 1996


def test_accepts_the_business_college_wording():
    assert parse_cob_navoid(LOOSE) == 1701


def test_falls_back_to_a_looser_business_match():
    assert parse_cob_navoid(FALLBACK) == 1234


def test_raises_when_no_business_nav_present():
    with pytest.raises(LookupError):
        parse_cob_navoid('<a href="content.php?navoid=42">College of Nursing</a>')
