import json
from gc_advisor.ingest import parse_prose_program as ppp

SYS_MARKER = "structured academic requirements"

def test_build_prompt_includes_name_and_prose():
    sys, user = ppp.build_prompt("Accounting Minor", "requires ACCT 2010 ...")
    assert SYS_MARKER in sys.lower()
    assert "Accounting Minor" in user and "ACCT 2010" in user

def test_extract_uses_cache_when_present(tmp_path, fixtures_dir, monkeypatch):
    raw = tmp_path
    (raw / "2026-2027").mkdir(parents=True)
    (raw / "2026-2027" / "16611.txt").write_text(
        (fixtures_dir / "accounting_minor_2026.txt").read_text())
    (raw / "2026-2027" / "16611.llm.json").write_text(
        (fixtures_dir / "accounting_minor_2026.llm.json").read_text())
    def boom(*a, **k): raise AssertionError("LLM should not be called when cache exists")
    monkeypatch.setattr(ppp.llm, "extract_json", boom)
    prog = ppp.extract_prose_program(raw, "2026-2027", 16611,
                                     name="Accounting Minor", kind="minor")
    assert prog.kind == "minor"
    assert prog.total_credits == 18
    assert "ACCT 2010" in prog.rule["required_courses"]
    assert "18 credits" in prog.description

def test_extract_calls_llm_and_freezes_when_no_cache(tmp_path, fixtures_dir, monkeypatch):
    raw = tmp_path
    (raw / "2026-2027").mkdir(parents=True)
    (raw / "2026-2027" / "16611.txt").write_text(
        (fixtures_dir / "accounting_minor_2026.txt").read_text())
    canned = json.loads((fixtures_dir / "accounting_minor_2026.llm.json").read_text())
    calls = {"n": 0}
    def fake(system, user, **k):
        calls["n"] += 1
        return canned
    monkeypatch.setattr(ppp.llm, "extract_json", fake)
    prog = ppp.extract_prose_program(raw, "2026-2027", 16611,
                                     name="Accounting Minor", kind="minor")
    assert calls["n"] == 1
    assert (raw / "2026-2027" / "16611.llm.json").exists()
    assert prog.total_credits == 18

def test_validate_handles_non_dict_input():
    assert ppp._validate(None) == {"required_courses": [], "total_credits": None,
                                   "elective_rules": [], "not_open_to": []}
    assert ppp._validate(["x"])["required_courses"] == []

def test_validate_rejects_bool_total_credits():
    assert ppp._validate({"total_credits": True})["total_credits"] is None
    assert ppp._validate({"total_credits": 18})["total_credits"] == 18

def test_validate_coerces_nonlist_fields():
    out = ppp._validate({"required_courses": "ACCT 2010",
                         "elective_rules": "garbage", "not_open_to": None})
    assert out["required_courses"] == []
    assert out["elective_rules"] == []
    assert out["not_open_to"] == []

def test_cross_year_content_reuse_skips_llm(tmp_path, fixtures_dir, monkeypatch):
    raw = tmp_path
    prose = (fixtures_dir / "accounting_minor_2026.txt").read_text()
    (raw / "2025-2026").mkdir(parents=True)
    (raw / "2025-2026" / "111.txt").write_text(prose)
    canned = json.loads((fixtures_dir / "accounting_minor_2026.llm.json").read_text())
    calls = {"n": 0}
    monkeypatch.setattr(ppp.llm, "extract_json", lambda s, u, **k: (calls.__setitem__("n", calls["n"] + 1), canned)[1])
    ppp.extract_prose_program(raw, "2025-2026", 111, name="Accounting Minor", kind="minor")
    assert calls["n"] == 1
    # same prose, different year+poid -> content-cache hit, NO new LLM call
    (raw / "2026-2027").mkdir(parents=True)
    (raw / "2026-2027" / "222.txt").write_text(prose)
    def boom(*a, **k):
        raise AssertionError("LLM must not be called on a content-cache hit")
    monkeypatch.setattr(ppp.llm, "extract_json", boom)
    prog = ppp.extract_prose_program(raw, "2026-2027", 222, name="Accounting Minor", kind="minor")
    assert prog.total_credits == 18

def test_boilerplate_differences_still_hit_cache(tmp_path, fixtures_dir, monkeypatch):
    raw = tmp_path
    base = (fixtures_dir / "accounting_minor_2026.txt").read_text()
    (raw / "2025-2026").mkdir(parents=True)
    (raw / "2025-2026" / "111.txt").write_text(base)
    canned = json.loads((fixtures_dir / "accounting_minor_2026.llm.json").read_text())
    monkeypatch.setattr(ppp.llm, "extract_json", lambda s, u, **k: canned)
    ppp.extract_prose_program(raw, "2025-2026", 111, name="Accounting Minor", kind="minor")
    # archived-style variant differing ONLY in chrome (banner/return/nav) must still hit
    variant = "[ARCHIVED CATALOG]\n" + base + "\nReturn to: Some College\na\n"
    (raw / "2018-2019").mkdir(parents=True)
    (raw / "2018-2019" / "999.txt").write_text(variant)
    def boom(*a, **k):
        raise AssertionError("normalization should make this a cache hit")
    monkeypatch.setattr(ppp.llm, "extract_json", boom)
    prog = ppp.extract_prose_program(raw, "2018-2019", 999, name="Accounting Minor", kind="minor")
    assert prog.total_credits == 18

def test_changed_requirements_miss_cache(tmp_path, fixtures_dir, monkeypatch):
    raw = tmp_path
    base = (fixtures_dir / "accounting_minor_2026.txt").read_text()
    (raw / "2025-2026").mkdir(parents=True)
    (raw / "2025-2026" / "111.txt").write_text(base)
    canned = json.loads((fixtures_dir / "accounting_minor_2026.llm.json").read_text())
    calls = {"n": 0}
    monkeypatch.setattr(ppp.llm, "extract_json", lambda s, u, **k: (calls.__setitem__("n", calls["n"] + 1), canned)[1])
    ppp.extract_prose_program(raw, "2025-2026", 111, name="Accounting Minor", kind="minor")
    # a real requirement change -> different normalized text -> cache MISS -> LLM called again
    changed = base + "\nNOTE: This minor is not open to Accounting majors.\n"
    (raw / "2026-2027").mkdir(parents=True)
    (raw / "2026-2027" / "222.txt").write_text(changed)
    ppp.extract_prose_program(raw, "2026-2027", 222, name="Accounting Minor", kind="minor")
    assert calls["n"] == 2
