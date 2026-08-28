from gc_advisor.ingest.parse_academic_regs import parse_academic_regs, _is_heading


def test_parses_sections(fixtures_dir):
    secs = parse_academic_regs((fixtures_dir / "academic_regs_2026.txt").read_text())
    assert len(secs) >= 3
    # every section has a non-empty heading and body text
    assert all(s.section and len(s.text) > 0 for s in secs)
    # the REACH Act (referenced by GC footnote 3) appears
    joined = " ".join(s.section for s in secs)
    assert "REACH" in joined or any("REACH" in s.text for s in secs)


def test_boilerplate_filtered_out(fixtures_dir):
    """Boilerplate lines must not appear in any section heading or body."""
    secs = parse_academic_regs((fixtures_dir / "academic_regs_2026.txt").read_text())
    all_text = " ".join(s.section + " " + s.text for s in secs)
    for boiler in ("Add to My Favorites", "opens a new window", "Return to:"):
        assert boiler not in all_text, f"Boilerplate leaked: {boiler!r}"


def test_known_section_present(fixtures_dir):
    """A known real section heading from the 2026-27 fixture is parsed."""
    secs = parse_academic_regs((fixtures_dir / "academic_regs_2026.txt").read_text())
    headings = {s.section for s in secs}
    # "Grading System" and "Credit System" are clearly present in the fixture
    assert any("Grading" in h or "Grade" in h or "Attendance" in h or "Academic Standing" in h
               for h in headings), f"No known section heading found in: {sorted(headings)[:10]}"


def test_is_heading_accepts_short_title_case():
    assert _is_heading("Grading System") is True
    assert _is_heading("South Carolina REACH Act") is True


def test_is_heading_rejects_sentences():
    assert _is_heading(
        "Students who fail to maintain a cumulative GPA of 2.0 will be placed on probation."
    ) is False


def test_is_heading_rejects_empty_and_punctuation():
    assert _is_heading("") is False
    assert _is_heading("something that ends with a comma,") is False
    assert _is_heading("something that ends with a colon:") is False
