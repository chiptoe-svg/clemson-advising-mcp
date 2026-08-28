"""Department packs: the declarative form of the hand-authored wildcards and
curated advisor courses that scripts/backfill_advisor_and_wildcards.py held as
Python constants."""
import json
import pytest
from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.packs import Pack, load_pack, apply_pack


def _write_pack(root, *, program="GC, BS", slot="Specialty Area Requirement"):
    d = root / "gc"
    (d / "rules").mkdir(parents=True)
    (d / "pack.toml").write_text(
        f'name = "Graphic Communications"\nprograms = ["{program}"]\n')
    (d / "rules" / "specialty.toml").write_text(
        f'slot_type = "{slot}"\n\n'
        '[[wildcards]]\ntype = "dept_any"\ndept = "CHE"\n')
    (d / "advisor-courses.toml").write_text(
        '[[course]]\n'
        f'slot_type = "{slot}"\n'
        'code = "MKT 4200"\naction = "allow"\nnote = "advisor list"\n')
    return d


def _seed_db(tmp_path, program="GC, BS", slot="Specialty Area Requirement"):
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    con.execute("INSERT INTO catalog_year(label, catoid) VALUES(?,?)", ("2026-2027", 49))
    cy = con.execute("SELECT id FROM catalog_year").fetchone()["id"]
    con.execute("INSERT INTO program(catalog_year_id, poid, name, kind) VALUES(?,?,?,?)",
                (cy, 1, program, "major"))
    pid = con.execute("SELECT id FROM program").fetchone()["id"]
    con.execute("INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
                (pid, slot, json.dumps({"total_credits": 15, "explicit_courses": []})))
    con.commit()
    return con, pid


def test_load_pack_reads_identity_rules_and_advisor_courses(tmp_path):
    pack = load_pack(_write_pack(tmp_path))
    assert pack.name == "Graphic Communications"
    assert pack.programs == ["GC, BS"]
    assert pack.rules["Specialty Area Requirement"]["wildcards"][0]["dept"] == "CHE"
    assert pack.advisor_courses[0]["code"] == "MKT 4200"


def test_apply_pack_injects_wildcards_into_the_matching_rule(tmp_path):
    con, pid = _seed_db(tmp_path)
    pack = load_pack(_write_pack(tmp_path))
    apply_pack(con, pack, added_on="2026-08-24")
    rule = json.loads(con.execute(
        "SELECT rule FROM requirement_rule WHERE program_id=?", (pid,)).fetchone()["rule"])
    assert rule["wildcards"] == [{"type": "dept_any", "dept": "CHE"}]


def test_apply_pack_adds_advisor_courses_for_its_own_program(tmp_path):
    con, _ = _seed_db(tmp_path)
    apply_pack(con, load_pack(_write_pack(tmp_path)), added_on="2026-08-24")
    row = con.execute(
        "SELECT program, code FROM advisor_course WHERE code='MKT 4200'").fetchone()
    assert row["program"] == "GC, BS"


def test_apply_pack_is_idempotent(tmp_path):
    con, _ = _seed_db(tmp_path)
    pack = load_pack(_write_pack(tmp_path))
    first = apply_pack(con, pack, added_on="2026-08-24")
    second = apply_pack(con, pack, added_on="2026-08-24")
    assert first["advisor_added"] == 1 and second["advisor_added"] == 0
    assert second["rules_updated"] == 0
    n = con.execute("SELECT count(*) AS c FROM advisor_course").fetchone()["c"]
    assert n == 1


def test_apply_pack_does_not_touch_another_programs_rule(tmp_path):
    con, _ = _seed_db(tmp_path, program="Other, BS")
    apply_pack(con, load_pack(_write_pack(tmp_path)), added_on="2026-08-24")
    rule = json.loads(con.execute("SELECT rule FROM requirement_rule").fetchone()["rule"])
    assert "wildcards" not in rule


def test_apply_pack_does_not_clobber_a_real_zero_but_still_fills_an_empty_list(tmp_path):
    # apply_pack's overwrite predicate (rule.get(key) in (None, [], {})) must
    # leave a real falsy scalar (0) alone — falsy is not the same as absent —
    # while still filling an empty list, which IS the "nothing derived yet"
    # case a pack is meant to fill.
    #
    # total_credits is not itself a settable pack key (see PACK_RULE_KEYS in
    # packs.py — it's unreachable today and load_pack rejects it), so this
    # constructs a Pack directly rather than through load_pack/a rule file,
    # to exercise apply_pack's generic falsy-vs-missing predicate on its own
    # terms rather than a specific pack-authorable key.
    program, slot = "GC, BS", "Specialty Area Requirement"
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    con.execute("INSERT INTO catalog_year(label, catoid) VALUES(?,?)", ("2026-2027", 49))
    cy = con.execute("SELECT id FROM catalog_year").fetchone()["id"]
    con.execute("INSERT INTO program(catalog_year_id, poid, name, kind) VALUES(?,?,?,?)",
                (cy, 1, program, "major"))
    pid = con.execute("SELECT id FROM program").fetchone()["id"]
    con.execute("INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
                (pid, slot, json.dumps({"total_credits": 0, "explicit_courses": []})))
    con.commit()

    pack = Pack(name="Graphic Communications", programs=[program],
                rules={slot: {"total_credits": 9, "explicit_courses": ["ENGL 101"]}})

    apply_pack(con, pack, added_on="2026-08-24")
    rule = json.loads(con.execute(
        "SELECT rule FROM requirement_rule WHERE program_id=?", (pid,)).fetchone()["rule"])
    assert rule["total_credits"] == 0
    assert rule["explicit_courses"] == ["ENGL 101"]


def test_load_pack_raises_on_unrecognized_rule_key(tmp_path):
    d = tmp_path / "gc"
    (d / "rules").mkdir(parents=True)
    (d / "pack.toml").write_text('name = "Graphic Communications"\nprograms = ["GC, BS"]\n')
    (d / "rules" / "specialty.toml").write_text(
        'slot_type = "Specialty Area Requirement"\ntotal_credit = 9\n')

    with pytest.raises(ValueError) as exc_info:
        load_pack(d)
    message = str(exc_info.value)
    assert "specialty.toml" in message
    assert "total_credit" in message


def test_load_pack_raises_on_unrecognized_wildcard_type(tmp_path):
    """A misspelled wildcard `type` (e.g. 'dept_caped') used to load and apply
    cleanly, then wildcards.py:_allows silently returned False for the
    unknown type forever after — a capped slot's cap simply stopped applying,
    with no error anywhere."""
    d = tmp_path / "gc"
    (d / "rules").mkdir(parents=True)
    (d / "pack.toml").write_text('name = "Graphic Communications"\nprograms = ["GC, BS"]\n')
    (d / "rules" / "specialty.toml").write_text(
        'slot_type = "Specialty Area Requirement"\n\n'
        '[[wildcards]]\ntype = "dept_caped"\ndepts = ["BIOL"]\ncap_credits = 4\n')

    with pytest.raises(ValueError) as exc_info:
        load_pack(d)
    message = str(exc_info.value)
    assert "specialty.toml" in message
    assert "dept_caped" in message


def test_load_pack_raises_on_unrecognized_evaluator(tmp_path):
    """A misspelled `evaluator` value used to fall through to credit_set with
    no complaint at all."""
    d = tmp_path / "gc"
    (d / "rules").mkdir(parents=True)
    (d / "pack.toml").write_text('name = "Graphic Communications"\nprograms = ["GC, BS"]\n')
    (d / "rules" / "specialty.toml").write_text(
        'slot_type = "Specialty Area Requirement"\nevaluator = "minor_or_corse_set"\n')

    with pytest.raises(ValueError) as exc_info:
        load_pack(d)
    message = str(exc_info.value)
    assert "specialty.toml" in message
    assert "minor_or_corse_set" in message


def test_load_pack_raises_on_wildcard_missing_required_field(tmp_path):
    """A dept_capped wildcard missing cap_credits used to load and apply
    cleanly, then raise a bare KeyError at audit time instead of at load
    time."""
    d = tmp_path / "gc"
    (d / "rules").mkdir(parents=True)
    (d / "pack.toml").write_text('name = "Graphic Communications"\nprograms = ["GC, BS"]\n')
    (d / "rules" / "specialty.toml").write_text(
        'slot_type = "Specialty Area Requirement"\n\n'
        '[[wildcards]]\ntype = "dept_capped"\ndepts = ["BIOL"]\n')

    with pytest.raises(ValueError) as exc_info:
        load_pack(d)
    message = str(exc_info.value)
    assert "specialty.toml" in message
    assert "cap_credits" in message


def test_load_pack_raises_naming_the_file_on_missing_pack_name(tmp_path):
    d = tmp_path / "gc"
    d.mkdir(parents=True)
    (d / "pack.toml").write_text('programs = ["GC, BS"]\n')

    with pytest.raises(ValueError) as exc_info:
        load_pack(d)
    message = str(exc_info.value)
    assert "pack.toml" in message
    assert "name" in message


def test_load_pack_raises_naming_the_file_on_missing_slot_type(tmp_path):
    d = tmp_path / "gc"
    (d / "rules").mkdir(parents=True)
    (d / "pack.toml").write_text('name = "Graphic Communications"\nprograms = ["GC, BS"]\n')
    (d / "rules" / "specialty.toml").write_text('evaluator = "credit_set"\n')

    with pytest.raises(ValueError) as exc_info:
        load_pack(d)
    message = str(exc_info.value)
    assert "specialty.toml" in message
    assert "slot_type" in message


# ---------------------------------------------------------------------------
# INSERT-path year scoping (final-review I3) and the NULL-credits guard (M5).
# ---------------------------------------------------------------------------

def _seed_two_years(tmp_path, program="GC, BS", slot="Business Requirement",
                    credits=3):
    """Two catalog years of the SAME program, each with a plan carrying `slot`
    but NO requirement_rule — the shape apply_pack's INSERT path exists for."""
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    pids = {}
    for i, label in enumerate(("2025-2026", "2026-2027")):
        con.execute("INSERT INTO catalog_year(label, catoid) VALUES(?,?)", (label, 40 + i))
        cy = con.execute("SELECT id FROM catalog_year WHERE label=?", (label,)).fetchone()["id"]
        con.execute("INSERT INTO program(catalog_year_id, poid, name, kind) VALUES(?,?,?,?)",
                    (cy, 1, program, "major"))
        pid = con.execute("SELECT id FROM program WHERE catalog_year_id=?", (cy,)).fetchone()["id"]
        con.execute("INSERT INTO requirement_group(program_id, label, kind, ordering) "
                    "VALUES(?,?,?,?)", (pid, "Freshman/First Semester", "term", 0))
        gid = con.execute("SELECT id FROM requirement_group WHERE program_id=?",
                          (pid,)).fetchone()["id"]
        con.execute("INSERT INTO plan_item(group_id, kind, slot_type, credits, ordering) "
                    "VALUES(?,?,?,?,?)", (gid, "slot", slot, credits, 0))
        pids[label] = pid
    con.commit()
    return con, pids


def test_apply_pack_heals_a_single_year_whose_rule_was_deleted(tmp_path):
    """A single-year re-ingest deletes only THAT year's requirement_rule rows
    (build_requirement_rules is per program_id). The old name-wide existence
    check meant the INSERT branch fired only when NO year had the rule, so the
    surviving sibling year permanently masked the hole and re-applying the pack
    could never heal it. Scoped per program-year, it heals."""
    con, pids = _seed_two_years(tmp_path)
    slot = "Business Requirement"
    pack = Pack(name="Accounting", programs=["GC, BS"],
                rules={slot: {"wildcards": [{"type": "dept_any", "dept": "ACCT"}]}})

    apply_pack(con, pack, added_on="2026-08-25")
    have = {r["program_id"] for r in con.execute(
        "SELECT program_id FROM requirement_rule WHERE slot_type=?", (slot,))}
    assert have == set(pids.values()), "first apply did not create both years"

    # Simulate a single-year re-ingest: drop 2026-2027's rule only.
    con.execute("DELETE FROM requirement_rule WHERE program_id=?", (pids["2026-2027"],))
    con.commit()

    apply_pack(con, pack, added_on="2026-08-25")
    have = {r["program_id"] for r in con.execute(
        "SELECT program_id FROM requirement_rule WHERE slot_type=?", (slot,))}
    assert have == set(pids.values()), \
        "re-applying the pack did not restore the re-ingested year's rule"
    restored = json.loads(con.execute(
        "SELECT rule FROM requirement_rule WHERE program_id=?",
        (pids["2026-2027"],)).fetchone()["rule"])
    assert restored["wildcards"] == [{"type": "dept_any", "dept": "ACCT"}]
    assert restored["total_credits"] == 3, "credits not re-summed from that year's plan"


def test_apply_pack_still_updates_the_year_that_kept_its_rule(tmp_path):
    """Per-year scoping must not turn an UPDATE into a duplicate INSERT."""
    con, pids = _seed_two_years(tmp_path)
    slot = "Business Requirement"
    pack = Pack(name="Accounting", programs=["GC, BS"],
                rules={slot: {"wildcards": [{"type": "dept_any", "dept": "ACCT"}]}})
    apply_pack(con, pack, added_on="2026-08-25")
    apply_pack(con, pack, added_on="2026-08-25")
    n = con.execute("SELECT count(*) AS c FROM requirement_rule WHERE slot_type=?",
                    (slot,)).fetchone()["c"]
    assert n == 2, f"expected one rule per program-year, got {n}"


def test_apply_pack_raises_rather_than_writing_a_zero_credit_rule(tmp_path):
    """A NULL plan-credits SUM used to become total_credits: 0, and a 0-credit
    credit_set rule is satisfied by ANY single matching course
    (_slot_status_rule falls back to `bool(counted)` when need is falsy) —
    a silent wrong-`met`. Fail loudly, naming program and slot, instead."""
    con, _ = _seed_two_years(tmp_path, credits=None)
    slot = "Business Requirement"
    pack = Pack(name="Accounting", programs=["GC, BS"],
                rules={slot: {"wildcards": [{"type": "dept_any", "dept": "ACCT"}]}})
    with pytest.raises(ValueError) as e:
        apply_pack(con, pack, added_on="2026-08-25")
    assert "GC, BS" in str(e.value) and slot in str(e.value)
    assert con.execute("SELECT count(*) AS c FROM requirement_rule").fetchone()["c"] == 0
