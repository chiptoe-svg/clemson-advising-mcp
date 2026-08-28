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
