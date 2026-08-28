import json
from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.parse_program import parse_program
from gc_advisor.ingest.load import ensure_catalog_year, load_program
from gc_advisor.ingest.requirement_rules import build_requirement_rules


def _seed(tmp_path, fixtures_dir):
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    cy = ensure_catalog_year(con, "2026-2027", 49)
    prog = parse_program((fixtures_dir / "gc_program_2026.txt").read_text(), kind="major", degree="BS")
    pid = load_program(con, cy, prog, poid=16765, source_url="u", source_hash="h")
    return con, pid


def test_builds_rules_for_footnoted_slots_only(tmp_path, fixtures_dir):
    con, pid = _seed(tmp_path, fixtures_dir)
    build_requirement_rules(con, pid)
    rules = {r["slot_type"]: json.loads(r["rule"]) for r in
             con.execute("SELECT slot_type, rule FROM requirement_rule WHERE program_id=?", (pid,))}
    assert any("Laboratory Science" in s for s in rules)
    assert any("Specialty Area" in s for s in rules)
    assert any("Technical Requirement" in s for s in rules)
    assert not any("Arts and Humanities" in s for s in rules)
    assert not any("REACH" in s for s in rules)


def test_technical_requirement_rule_has_explicit_codes_and_credits(tmp_path, fixtures_dir):
    con, pid = _seed(tmp_path, fixtures_dir)
    build_requirement_rules(con, pid)
    r = json.loads(con.execute(
        "SELECT rule FROM requirement_rule WHERE program_id=? AND slot_type LIKE '%Technical Requirement%'",
        (pid,)).fetchone()["rule"])
    assert r["total_credits"] == 6
    assert "GC 4450" in r["explicit_courses"] and "GC 1990" in r["explicit_courses"]


def test_specialty_area_rule_flags_minor_alternative(tmp_path, fixtures_dir):
    con, pid = _seed(tmp_path, fixtures_dir)
    build_requirement_rules(con, pid)
    r = json.loads(con.execute(
        "SELECT rule FROM requirement_rule WHERE program_id=? AND slot_type LIKE '%Specialty Area%'",
        (pid,)).fetchone()["rule"])
    assert r["total_credits"] == 15
    assert r["satisfy_one_of"] == ["approved_minor", "course_set"]
    assert "ART 1030" in r["explicit_courses"]
    assert "minor" in r["raw_text"].lower()


def test_idempotent(tmp_path, fixtures_dir):
    con, pid = _seed(tmp_path, fixtures_dir)
    build_requirement_rules(con, pid)
    build_requirement_rules(con, pid)
    n = con.execute("SELECT COUNT(*) FROM requirement_rule WHERE program_id=?", (pid,)).fetchone()[0]
    assert n == 3


def test_builds_rules_for_every_major_in_a_catalog_year(tmp_path, fixtures_dir):
    """Two majors sharing a catalog year must BOTH get rules.

    scripts/backfill_requirements.py selected the year's major with a
    `fetchone()` on kind='major', so once a second major exists only whichever
    row SQLite happened to return first was given rules — the other silently
    got none, and every one of its slots would then fall through to gen-ed
    matching or 'verify manually'.
    """
    from gc_advisor.ingest.requirement_rules import build_rules_for_catalog_year

    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    cy = ensure_catalog_year(con, "2026-2027", 49)
    gc = parse_program((fixtures_dir / "gc_program_2026.txt").read_text(),
                       kind="major", degree="BS")
    mkt = parse_program((fixtures_dir / "marketing_program_2026.txt").read_text(),
                        kind="major", degree="BS")
    gc_id = load_program(con, cy, gc, poid=16765, source_url="u1", source_hash="h1")
    mkt_id = load_program(con, cy, mkt, poid=16767, source_url="u2", source_hash="h2")

    build_rules_for_catalog_year(con, cy)

    for pid, name in ((gc_id, gc.name), (mkt_id, mkt.name)):
        n = con.execute("SELECT count(*) AS c FROM requirement_rule WHERE program_id=?",
                        (pid,)).fetchone()["c"]
        assert n > 0, f"{name} got no requirement rules"


def test_rebuild_preserves_hand_authored_rule_keys(tmp_path, fixtures_dir):
    """Re-deriving a program's rules must not destroy curated rule data.

    build_requirement_rules DELETEs the program's rules and rebuilds them from
    footnotes. Wildcards, however, are hand-authored afterwards by
    scripts/backfill_advisor_and_wildcards.py and are NOT derivable from the
    catalog — so a plain rebuild silently wiped them, degrading every affected
    audit. Observed on the live DB: running backfill_requirements.py stripped
    wildcards from four catalog years of GC Specialty Area rules.
    """
    con, pid = _seed(tmp_path, fixtures_dir)
    build_requirement_rules(con, pid)

    wildcards = [{"type": "dept_any", "dept": "CHE"},
                 {"type": "dept_capped", "depts": ["BIOL"], "cap_credits": 4}]
    row = con.execute(
        "SELECT id, rule FROM requirement_rule WHERE program_id=? "
        "AND slot_type LIKE '%Specialty Area%'", (pid,)).fetchone()
    rule = json.loads(row["rule"]); rule["wildcards"] = wildcards
    con.execute("UPDATE requirement_rule SET rule=? WHERE id=?",
                (json.dumps(rule), row["id"]))
    con.commit()

    build_requirement_rules(con, pid)          # re-derive

    after = json.loads(con.execute(
        "SELECT rule FROM requirement_rule WHERE program_id=? "
        "AND slot_type LIKE '%Specialty Area%'", (pid,)).fetchone()["rule"])
    assert after.get("wildcards") == wildcards


def test_rebuild_preserves_evaluator_key(tmp_path, fixtures_dir):
    """A pack-set `evaluator` key must survive a rebuild the same way
    wildcards do — it's pack-authored knowledge with no catalog source.

    Reproduces the whole-branch review finding: PRESERVED_RULE_KEYS only
    named 'wildcards', so applying a pack that sets `evaluator` and then
    re-running build_requirement_rules (as scripts/backfill_requirements.py
    does after any re-ingest) silently dropped it, rerouting a
    minor_or_course_set slot back to credit_set with no warning.
    """
    con, pid = _seed(tmp_path, fixtures_dir)
    build_requirement_rules(con, pid)

    row = con.execute(
        "SELECT id, rule FROM requirement_rule WHERE program_id=? "
        "AND slot_type LIKE '%Specialty Area%'", (pid,)).fetchone()
    rule = json.loads(row["rule"]); rule["evaluator"] = "minor_or_course_set"
    con.execute("UPDATE requirement_rule SET rule=? WHERE id=?",
                (json.dumps(rule), row["id"]))
    con.commit()

    build_requirement_rules(con, pid)          # re-derive

    after = json.loads(con.execute(
        "SELECT rule FROM requirement_rule WHERE program_id=? "
        "AND slot_type LIKE '%Specialty Area%'", (pid,)).fetchone()["rule"])
    assert after.get("evaluator") == "minor_or_course_set"


def test_builds_rules_from_footnoted_choice_items(tmp_path):
    """A requirement can parse as kind='choice' with a slot_type (e.g. a
    course-or-slot alternative). Those were skipped entirely, so programs built
    largely from choices got no rules at all."""
    from gc_advisor.db.connection import init_db, get_connection

    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    con.execute("INSERT INTO catalog_year(label, catoid) VALUES(?,?)", ("2026-2027", 49))
    cy = con.execute("SELECT id FROM catalog_year").fetchone()["id"]
    con.execute("INSERT INTO program(catalog_year_id, poid, name, kind) VALUES(?,?,?,?)",
                (cy, 1, "Choicey, BS", "major"))
    pid = con.execute("SELECT id FROM program").fetchone()["id"]
    con.execute("INSERT INTO requirement_group(program_id, label, kind, credit_total, ordering) "
                "VALUES(?,?,?,?,?)", (pid, "G", "term", 3, 0))
    gid = con.execute("SELECT id FROM requirement_group").fetchone()["id"]
    con.execute("INSERT INTO plan_item(group_id, kind, course_code, one_of, slot_type, "
                "credits, footnote_refs, ordering) VALUES(?,?,?,?,?,?,?,?)",
                (gid, "choice", None, '["ACCT 2010"]', "Business Core Requirement",
                 3, "[1]", 0))
    con.execute("INSERT INTO footnote(program_id, number, text) VALUES(?,?,?)",
                (pid, 1, "Select one: ACCT 2010 or MGT 2010."))
    con.commit()

    build_requirement_rules(con, pid)

    r = con.execute("SELECT rule FROM requirement_rule WHERE program_id=? "
                    "AND slot_type='Business Core Requirement'", (pid,)).fetchone()
    assert r is not None, "no rule derived from the footnoted choice item"
    rule = json.loads(r["rule"])
    assert rule["total_credits"] == 3
    assert "ACCT 2010" in rule["explicit_courses"]
    assert "MGT 2010" in rule["explicit_courses"]


def test_slot_and_choice_sharing_a_slot_type_aggregate_into_one_rule(tmp_path):
    """Regression test for the pi.kind IN ('slot','choice') widening.

    DOCUMENTS TODAY'S BEHAVIOUR, does not assert what it "should" be: when a
    'slot' item and a 'choice' item share the same footnoted slot_type,
    build_requirement_rules merges them into a single requirement_rule row —
    summing both items' credits and unioning their footnote text — because
    the derivation groups plan_item rows by slot_type alone, with no
    awareness of kind.

    This rule is only ever looked up by run_audit for the 'slot' item
    (pass 2 skips everything where kind != 'slot'; the 'choice' item is
    resolved from its own one_of list in pass 1 and never consults
    requirement_rule at all — see docs/known-data-gaps.md). So the merged
    total_credits here (both items summed) does not describe what either
    item alone needs; it is a byproduct of grouping-by-slot_type, not a
    considered feature. A future change that makes choice-derived rules
    consumable will need to revisit this aggregation, which is why the
    regression is pinned here rather than left implicit.
    """
    from gc_advisor.db.connection import init_db, get_connection

    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    con.execute("INSERT INTO catalog_year(label, catoid) VALUES(?,?)", ("2026-2027", 49))
    cy = con.execute("SELECT id FROM catalog_year").fetchone()["id"]
    con.execute("INSERT INTO program(catalog_year_id, poid, name, kind) VALUES(?,?,?,?)",
                (cy, 1, "Sharey, BS", "major"))
    pid = con.execute("SELECT id FROM program").fetchone()["id"]
    con.execute("INSERT INTO requirement_group(program_id, label, kind, credit_total, ordering) "
                "VALUES(?,?,?,?,?)", (pid, "G", "term", 7, 0))
    gid = con.execute("SELECT id FROM requirement_group").fetchone()["id"]
    # A 'slot' item...
    con.execute("INSERT INTO plan_item(group_id, kind, course_code, one_of, slot_type, "
                "credits, footnote_refs, ordering) VALUES(?,?,?,?,?,?,?,?)",
                (gid, "slot", None, None, "Shared Requirement", 3, "[1]", 0))
    # ...and a 'choice' item, both footnoted under the same slot_type.
    con.execute("INSERT INTO plan_item(group_id, kind, course_code, one_of, slot_type, "
                "credits, footnote_refs, ordering) VALUES(?,?,?,?,?,?,?,?)",
                (gid, "choice", None, '["ACCT 2010"]', "Shared Requirement",
                 4, "[1]", 1))
    con.execute("INSERT INTO footnote(program_id, number, text) VALUES(?,?,?)",
                (pid, 1, "Select one: ACCT 2010 or MGT 2010."))
    con.commit()

    build_requirement_rules(con, pid)

    rows = con.execute("SELECT rule FROM requirement_rule WHERE program_id=? "
                       "AND slot_type='Shared Requirement'", (pid,)).fetchall()
    assert len(rows) == 1, "slot and choice items sharing a slot_type must merge into one rule"
    rule = json.loads(rows[0]["rule"])
    # Today's behaviour: credits from BOTH items (3 + 4) are summed into the
    # one merged rule, even though only the 'slot' item's need (3) is ever
    # actually read by run_audit.
    assert rule["total_credits"] == 7
    assert "ACCT 2010" in rule["explicit_courses"]
    assert "MGT 2010" in rule["explicit_courses"]


def test_builds_rules_for_pre_business_programs_too(tmp_path, fixtures_dir):
    """build_rules_for_catalog_year filtered kind='major', so Pre-Business —
    whose requirements DO carry rule-bearing footnotes — never got rules and
    its slots fell through to university-wide gen-ed matching, broader than
    the registrar's pre-business-specific course lists."""
    from gc_advisor.ingest.requirement_rules import build_rules_for_catalog_year

    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    cy = ensure_catalog_year(con, "2026-2027", 49)
    con.execute("INSERT INTO program(catalog_year_id, poid, name, kind) VALUES(?,?,?,?)",
                (cy, 1, "Pre-Business", "pre_business"))
    pid = con.execute("SELECT id FROM program").fetchone()["id"]
    con.execute("INSERT INTO requirement_group(program_id, label, kind, credit_total, ordering) "
                "VALUES(?,?,?,?,?)", (pid, "G", "term", 3, 0))
    gid = con.execute("SELECT id FROM requirement_group").fetchone()["id"]
    con.execute("INSERT INTO plan_item(group_id, kind, course_code, one_of, slot_type, "
                "credits, footnote_refs, ordering) VALUES(?,?,?,?,?,?,?,?)",
                (gid, "slot", None, None, "Social Science Requirement", 3, "[1]", 0))
    con.execute("INSERT INTO footnote(program_id, number, text) VALUES(?,?,?)",
                (pid, 1, "Select from ANTH 2010 or PSYC 2010 or SOC 2010."))
    con.commit()

    made = build_rules_for_catalog_year(con, cy)

    assert pid in made and made[pid] == 1, f"pre_business got no rules: {made}"
    import json as _json
    rule = _json.loads(con.execute(
        "SELECT rule FROM requirement_rule WHERE program_id=?", (pid,)).fetchone()["rule"])
    assert set(rule["explicit_courses"]) == {"ANTH 2010", "PSYC 2010", "SOC 2010"}


def test_rebuild_preserves_pack_inserted_rules_for_footnoteless_slots(tmp_path):
    """apply_pack can INSERT a rule for a slot the catalog derived none for
    (a footnote-less slot). build_requirement_rules DELETEs and re-derives —
    and a footnote-less slot re-derives NOTHING, so the pack-inserted rule
    was destroyed entirely (observed live: the Economics ingest's backfill
    wiped Accounting's Business Requirement rules). A hand-authored rule
    whose slot still exists in the plan must survive a rebuild whole."""
    from gc_advisor.db.connection import init_db, get_connection
    from gc_advisor.ingest.packs import Pack, apply_pack

    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    con.execute("INSERT INTO catalog_year(label, catoid) VALUES(?,?)", ("2026-2027", 49))
    cy = con.execute("SELECT id FROM catalog_year").fetchone()["id"]
    con.execute("INSERT INTO program(catalog_year_id, poid, name, kind) VALUES(?,?,?,?)",
                (cy, 1, "Biz, BS", "major"))
    pid = con.execute("SELECT id FROM program").fetchone()["id"]
    con.execute("INSERT INTO requirement_group(program_id, label, kind, credit_total, ordering) "
                "VALUES(?,?,?,?,?)", (pid, "G", "term", 6, 0))
    gid = con.execute("SELECT id FROM requirement_group").fetchone()["id"]
    # a slot with NO footnote refs — derivation produces nothing for it
    con.execute("INSERT INTO plan_item(group_id, kind, course_code, one_of, slot_type, "
                "credits, footnote_refs, ordering) VALUES(?,?,?,?,?,?,?,?)",
                (gid, "slot", None, None, "Business Requirement", 6, "[]", 0))
    con.commit()

    pack = Pack(name="Biz", programs=["Biz, BS"],
                rules={"Business Requirement": {
                    "wildcards": [{"type": "dept_level_min", "dept": "FIN", "min": 3000}]}})
    apply_pack(con, pack, added_on="2026-08-25")
    assert con.execute("SELECT count(*) c FROM requirement_rule WHERE program_id=?",
                       (pid,)).fetchone()["c"] == 1

    build_requirement_rules(con, pid)   # the routine rebuild

    row = con.execute("SELECT rule FROM requirement_rule WHERE program_id=? "
                      "AND slot_type='Business Requirement'", (pid,)).fetchone()
    assert row is not None, "pack-inserted rule destroyed by rebuild"
    assert json.loads(row["rule"])["wildcards"], "wildcards lost in rebuild"
