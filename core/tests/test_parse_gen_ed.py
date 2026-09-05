from gc_advisor.ingest.parse_gen_ed import parse_gen_ed


def _cats(fixtures_dir):
    return parse_gen_ed((fixtures_dir / "gen_ed_2026.txt").read_text())


def test_parses_six_categories(fixtures_dir):
    names = " | ".join(c.name for c in _cats(fixtures_dir))
    for kw in ("Communication","Mathematic","Natural Science","Arts and Humanities","Social Science","Global Challenge"):
        assert kw in names, f"missing {kw} in {names}"


def test_categories_have_credits_and_courses(fixtures_dir):
    cats = _cats(fixtures_dir)
    natsci = next(c for c in cats if "Natural Science" in c.name)
    assert natsci.min_credits == 4
    assert any(code.startswith("CH ") or code.startswith("PHYS ") for code in natsci.allowed_courses)
    assert all(c.min_credits and c.min_credits > 0 for c in cats)
    assert all(c.allowed_courses for c in cats)


def test_learning_outcomes_captured(fixtures_dir):
    cats = _cats(fixtures_dir)
    # at least one category carries its Student Learning Outcome, and no mission/marketing prose
    assert any(len(c.learning_outcome) > 20 for c in cats)
    comm = next(c for c in cats if "Communication" in c.name)
    assert "Students will" in comm.learning_outcome


def test_load_gen_ed_persists_slo(tmp_path, fixtures_dir):
    from gc_advisor.db.connection import init_db, get_connection
    from gc_advisor.ingest.load import ensure_catalog_year, load_gen_ed
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    cy = ensure_catalog_year(con, "2026-2027", 49)
    cats = parse_gen_ed((fixtures_dir / "gen_ed_2026.txt").read_text())
    load_gen_ed(con, cy, cats)
    n = con.execute("SELECT COUNT(*) FROM gen_ed_category WHERE catalog_year_id=?", (cy,)).fetchone()[0]
    assert n == len(cats) >= 6
    row = con.execute("SELECT learning_outcome FROM gen_ed_category WHERE name LIKE 'Communication%'").fetchone()
    assert row and "Students will" in (row["learning_outcome"] or "")


def test_arts_and_humanities_subcategories(fixtures_dir):
    cats = _cats(fixtures_dir)
    ah = next(c for c in cats if "Arts and Humanities" in c.name)
    assert ah.subcategories, "published Literature/Non-Literature split not parsed"
    by_name = {s["name"]: s for s in ah.subcategories}
    assert set(by_name) == {"Literature", "Non-Literature"}
    assert "ENGL 2120" in by_name["Literature"]["allowed_courses"]
    assert "PHIL 1010" in by_name["Non-Literature"]["allowed_courses"]
    assert by_name["Literature"]["min_credits"] == 3
    # The open-ended sentence is requirement text, not decoration.
    assert by_name["Literature"].get("note", "").lower().startswith("any 2000-level")
    # Sub-lists are subsets of the category's own list — a parse that invents
    # courses the category does not allow is wrong.
    for s in by_name.values():
        assert set(s["allowed_courses"]) <= set(ah.allowed_courses)
    # No split shown for other categories -> None, never [].
    comm = next(c for c in cats if "Communication" in c.name)
    assert comm.subcategories is None


def test_subcategories_old_format():
    text = """
A. Communication: at least 6 credits
ENGL 1030 - Composition and Rhetoric 3 Credits
C. Arts and Humanities: at least 6 credits
Literature 3 credits
Any 2000-level ENGL literature course or any of the other courses listed
ENGL 2120 - World Literature 3 Credits
Non-Literature 3 credits
PHIL 1010 - Introduction to Philosophic Problems 3 Credits
D. Social Science: at least 6 credits
ECON 2110 - Principles of Microeconomics 3 Credits
"""
    cats = parse_gen_ed(text)
    ah = next(c for c in cats if "Arts and Humanities" in c.name)
    assert ah.subcategories is not None
    assert [s["name"] for s in ah.subcategories] == ["Literature", "Non-Literature"]
    assert ah.subcategories[0]["allowed_courses"] == ["ENGL 2120"]
