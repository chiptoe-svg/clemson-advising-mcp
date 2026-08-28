from gc_advisor.ingest.parse_program import parse_program


def _gc(fixtures_dir):
    text = (fixtures_dir / "gc_program_2026.txt").read_text()
    return parse_program(text, kind="major", degree="BS")


def test_program_name_and_total(fixtures_dir):
    p = _gc(fixtures_dir)
    assert p.name == "Graphic Communications, BS"
    assert p.total_credits == 120


def test_first_fixed_course(fixtures_dir):
    p = _gc(fixtures_dir)
    first_term = p.groups[0]
    assert first_term.label == "Freshman/First Semester"
    item = first_term.items[0]
    assert item.kind == "fixed_course"
    assert item.course_code == "GC 1010"
    assert item.credits == 1


def test_lab_science_slot_has_footnote(fixtures_dir):
    p = _gc(fixtures_dir)
    slots = [i for g in p.groups for i in g.items if i.kind == "slot"]
    lab = [i for i in slots if i.slot_type and "Laboratory Science" in i.slot_type]
    assert lab and lab[0].credits == 4 and 1 in lab[0].footnote_refs


def test_stat_choice_parsed(fixtures_dir):
    p = _gc(fixtures_dir)
    choices = [i for g in p.groups for i in g.items if i.kind == "choice"]
    stat = [c for c in choices if "STAT 2220" in c.one_of]
    assert stat and set(stat[0].one_of) == {
        "STAT 2220", "STAT 2300", "STAT 3090", "STAT 3300"}


def test_six_footnotes(fixtures_dir):
    p = _gc(fixtures_dir)
    assert {f.number for f in p.footnotes} == {1, 2, 3, 4, 5, 6}
    f6 = next(f for f in p.footnotes if f.number == 6)
    assert "GC 4450" in f6.text  # technical-requirement list


def test_elective_items_are_captured(fixtures_dir):
    p = _gc(fixtures_dir)
    electives = [i for g in p.groups for i in g.items
                 if i.kind == "slot" and i.slot_type == "Elective"]
    # 4 bare Elective lines in the 2026-27 GC plan: 3,1,1,4 credits
    assert sorted(i.credits for i in electives) == [1, 1, 3, 4]


def test_item_credits_sum_to_total(fixtures_dir):
    p = _gc(fixtures_dir)
    item_total = sum(i.credits or 0 for g in p.groups for i in g.items)
    assert item_total == p.total_credits == 120


def test_footnote6_has_no_trailing_boilerplate(fixtures_dir):
    p = _gc(fixtures_dir)
    f6 = next(f for f in p.footnotes if f.number == 6)
    assert not f6.text.rstrip().endswith(" a")
    assert "Return to" not in f6.text


# ── Marketing, BS (second major; different page structure) ──────────────────

def _mkt(fixtures_dir):
    text = (fixtures_dir / "marketing_program_2026.txt").read_text()
    return parse_program(text, kind="major", degree="BS")


def test_marketing_name_and_total(fixtures_dir):
    p = _mkt(fixtures_dir)
    assert p.name == "Marketing, BS"
    assert p.total_credits == 120


def test_marketing_resumes_after_first_footnote_block(fixtures_dir):
    # The pre-business Footnotes block must NOT swallow the sophomore-senior
    # major curriculum that follows "Additional Curriculum".
    p = _mkt(fixtures_dir)
    labels = [g.label or "" for g in p.groups]
    assert any("Sophomore" in l for l in labels)
    assert any("Senior" in l for l in labels)


def test_marketing_emphasis_and_support_slots(fixtures_dir):
    p = _mkt(fixtures_dir)
    slots = [i for g in p.groups for i in g.items if i.kind == "slot"]
    emph = [i for i in slots if i.slot_type == "Marketing Emphasis Area Requirement"]
    assert emph and emph[0].credits == 6 and 2 in emph[0].footnote_refs
    supp = [i for i in slots if i.slot_type == "Support Course Requirement"]
    assert supp and 3 in supp[0].footnote_refs


def test_marketing_major_footnotes_are_the_second_block(fixtures_dir):
    # Only the major (plain-numbered) footnotes survive; the pre-business N*
    # block is dropped when the major curriculum resumes.
    p = _mkt(fixtures_dir)
    assert {f.number for f in p.footnotes} == {1, 2, 3, 4}
    f2 = next(f for f in p.footnotes if f.number == 2)
    assert "emphasis area" in f2.text.lower()
    f3 = next(f for f in p.footnotes if f.number == 3)
    assert "minor" in f3.text.lower()


def test_pre_business_asterisk_footnotes_and_reach_layout_artifact():
    # The pre-business freshman block uses "N*" footnotes, and its REACH line
    # renders as a course-or-slot "choice" ("ACCT 2010 or South Carolina REACH
    # Act Requirement") — a TWO-COLUMN LAYOUT ARTIFACT, not a real alternative.
    # Registrar truth (DegreeWorks blank What-If, mirrored in
    # tests/fixtures/registrar/reach-act.txt): REACH = 3 credits in HIST 1010
    # or POSC 1010 or POSC 1030, or an exemption. So the parser normalizes it
    # back to a plain slot; left as a choice, run_audit satisfies the slot
    # from one_of and ACCT 2010 wrongly audits REACH as met.
    text = (
        "Program Requirements\n"
        "Pre-Business Freshman Curriculum\n"
        "First Semester\n"
        "MATH 1020 - Business Calculus I 3 Credits 1*, 2*\n\nor\n\n"
        "MATH 1060 - Calculus of One Variable I 4 Credits 1*, 2*\n\n"
        "Credit Hours: 7\n"
        "Second Semester\n"
        "ACCT 2010 - Financial Accounting Concepts 3 Credits 5*\n\nor\n\n"
        "South Carolina REACH Act Requirement 3 Credits 5*,6*\n\n"
        "ECON 2120 - Principles of Macroeconomics 3 Credits 1*\n"
        "Credit Hours: 6\n"
        "Footnotes\n"
        "1* Freshman core curriculum class.\n"
        "2* The following MATH sequences are acceptable.\n"
        "5* Accounting/Finance students take ACCT 2010.\n"
        "6* See REACH Act in the Academic Regulations section.\n"
    )
    p = parse_program(text, kind="major", degree=None)
    items = [it for g in p.groups for it in g.items]
    # course choice carries its footnote refs (the MATH sequence rules)
    math = next(it for it in items if it.kind == "choice" and "MATH 1020" in it.one_of)
    assert set(math.footnote_refs) == {1, 2}
    # The merged row holds TWO requirements and emits both: ACCT 2010 as a
    # course requirement carrying the cell's 3 credits, and the REACH slot at 0
    # credits (its real weight lives in a standalone block cell where the page
    # prints one). Footnote refs go to both.
    reach = next(it for it in items if it.slot_type and "REACH" in it.slot_type)
    assert reach.kind == "slot", f"REACH still parses as {reach.kind!r}"
    assert not reach.one_of and set(reach.footnote_refs) == {5, 6}
    assert reach.credits == 0
    acct = next(it for it in items if it.course_code == "ACCT 2010")
    assert acct.kind == "fixed_course" and acct.credits == 3
    # ECON 2120 stays a fixed course (not corrupted into the ACCT choice)
    assert any(it.kind == "fixed_course" and it.course_code == "ECON 2120" for it in items)
    # asterisked footnote DEFINITIONS captured with their text
    assert {f.number for f in p.footnotes} == {1, 2, 5, 6}
    assert "MATH sequences" in next(f for f in p.footnotes if f.number == 2).text


def test_marketing_asterisk_footnote_refs_dont_drop_courses(fixtures_dir):
    # Pre-business grid parses best-effort: an "N*" footnote ref must not make
    # the course/slot line fail to match.
    p = _mkt(fixtures_dir)
    codes = [i.course_code for g in p.groups for i in g.items if i.kind == "fixed_course"]
    assert "BUS 1010" in codes  # "BUS 1010 - ... 1 Credit 1*"
