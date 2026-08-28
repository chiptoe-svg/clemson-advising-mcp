"""The GC pack must carry exactly the knowledge the backfill script held, so
replacing the script cannot silently drop a wildcard or a curated course."""
from pathlib import Path
from gc_advisor.ingest.packs import load_pack

PACK = Path(__file__).parent.parent / "packs" / "gc"


def test_gc_pack_declares_the_gc_program():
    assert load_pack(PACK).programs == ["Graphic Communications, BS"]


def test_specialty_wildcards_match_the_retired_constants():
    rules = load_pack(PACK).rules
    wc = rules["Specialty Area Requirement"]["wildcards"]
    assert {"type": "dept_any", "dept": "CHE"} in wc
    assert {"type": "dept_level_min", "dept": "CPSC", "min": 2000} in wc
    assert {"type": "dept_capped", "depts": ["BIOL", "CH", "PHYS"],
            "cap_credits": 4} in wc
    assert {"type": "subject_pattern", "subject": "GC",
            "number_glob": "37XX", "allow": True} in wc
    assert len(wc) == 9


def test_technical_wildcard_matches_the_retired_constant():
    wc = load_pack(PACK).rules["Graphic Communication Technical Requirement"]["wildcards"]
    assert wc == [{"type": "subject_nonrequired", "subject": "GC",
                   "number_exclude": "37XX", "deny": ["GC 3610"],
                   "allow_except": ["GC 3720"]}]


def test_all_seven_curated_advisor_courses_are_present():
    codes = {c["code"] for c in load_pack(PACK).advisor_courses}
    assert codes == {"MKT 4200", "MKT 4210", "MKT 4290", "COMM 3220",
                     "COMM 3550", "COMM 4260", "PKSC 3689"}
