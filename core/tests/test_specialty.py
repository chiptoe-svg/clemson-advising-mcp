from gc_advisor.audit.models import PassedCourse, Progress
from gc_advisor.audit.specialty import evaluate_specialty

RULE = {  # shape matches requirement_rule for Specialty Area (Plan C)
    "total_credits": 15,
    "explicit_courses": ["ART 1030", "COMM 1010", "GC 2510", "MKT 3020", "PKSC 2200"],
    "raw_text": "... any CPSC science at the 2000 level or higher, any CHE, ECE, ENGR, IE, ME, or MSE course ... maximum of four credits of BIOL, CH and PHYS ...",
    "satisfy_one_of": ["approved_minor", "course_set"],
    "wildcards": [
        {"type": "dept_any", "dept": "CHE"}, {"type": "dept_any", "dept": "ECE"},
        {"type": "dept_any", "dept": "ENGR"}, {"type": "dept_any", "dept": "IE"},
        {"type": "dept_any", "dept": "ME"}, {"type": "dept_any", "dept": "MSE"},
        {"type": "dept_level_min", "dept": "CPSC", "min": 2000},
        {"type": "dept_capped", "depts": ["BIOL", "CH", "PHYS"], "cap_credits": 4},
    ],
}

def _prog(passed, minor=None):
    return Progress(version="gc-progress-v1", catalog_year="2026-2027",
                    passed=passed, minor=minor)

def test_declared_complete_minor_satisfies():
    r = evaluate_specialty(RULE, _prog([], minor={"name": "Business Administration", "complete": True}),
                           valid_minors=["Business Administration", "Spanish Studies"])
    assert r["status"] == "met" and r["via"] == "minor"

def test_declared_incomplete_minor_is_in_progress():
    r = evaluate_specialty(RULE, _prog([], minor={"name": "Business Administration", "complete": False}),
                           valid_minors=["Business Administration"])
    assert r["status"] == "in_progress" and r["via"] == "minor"

def test_minor_not_in_catalog_is_flagged():
    r = evaluate_specialty(RULE, _prog([], minor={"name": "Underwater Basketry", "complete": True}),
                           valid_minors=["Business Administration"])
    assert any("not found" in f.lower() for f in r["flags"])

def test_course_set_path_counts_explicit_and_patterns():
    passed = [PassedCourse("ART 1030", credits=3), PassedCourse("COMM 1010", credits=3),
              PassedCourse("ME 2010", credits=3),          # pattern: any ME course
              PassedCourse("CPSC 2120", credits=3),        # pattern: CPSC >= 2000
              PassedCourse("CPSC 1010", credits=3)]        # below 2000 -> NOT counted
    r = evaluate_specialty(RULE, _prog(passed), valid_minors=[])
    assert r["credits_earned"] == 12
    assert r["status"] == "unmet"

def test_biol_ch_phys_capped_at_four():
    passed = [PassedCourse("BIOL 1030", credits=3), PassedCourse("CH 1010", credits=4),
              PassedCourse("ART 1030", credits=3)]
    r = evaluate_specialty(RULE, _prog(passed), valid_minors=[])
    assert r["credits_earned"] == 7   # 3 (ART) + capped 4 of the 7 science credits

def test_fifteen_credits_meets():
    passed = [PassedCourse(c, credits=3) for c in
              ["ART 1030", "COMM 1010", "GC 2510", "MKT 3020", "PKSC 2200"]]
    r = evaluate_specialty(RULE, _prog(passed), valid_minors=[])
    assert r["credits_earned"] == 15 and r["status"] == "met" and r["via"] == "course_set"

def test_ambiguous_minor_prefix_is_flagged():
    r = evaluate_specialty(RULE, _prog([], minor={"name": "Science", "complete": True}),
                           valid_minors=["Computer Science", "Political Science"])
    assert r["status"] == "met"           # record is authoritative
    assert any("verify manually" in f for f in r["flags"])

def test_prefix_abbreviation_matches_single_minor_without_flag():
    r = evaluate_specialty(RULE, _prog([], minor={"name": "Business", "complete": True}),
                           valid_minors=["Business Administration", "Spanish Studies"])
    assert r["flags"] == []

def test_duplicate_passed_codes_not_double_counted():
    passed = [PassedCourse("ART 1030", credits=3), PassedCourse("ART 1030", credits=3)]
    r = evaluate_specialty(RULE, _prog(passed), valid_minors=[])
    assert r["credits_earned"] == 3
    assert r["counted_courses"] == ["ART 1030"]

def test_advisor_allow_counts_toward_specialty():
    passed = [PassedCourse("MKT 4290", credits=3)]
    r = evaluate_specialty(RULE, _prog(passed), valid_minors=[],
                           advisor_allow={"MKT 4290"})
    assert "MKT 4290" in r["counted_courses"] and r["credits_earned"] == 3

def test_advisor_deny_removes_explicit():
    passed = [PassedCourse("ART 1030", credits=3)]
    r = evaluate_specialty(RULE, _prog(passed), valid_minors=[],
                           advisor_deny={"ART 1030"})
    assert "ART 1030" not in r["counted_courses"] and r["credits_earned"] == 0

def test_capped_flag_names_the_rule_s_own_departments():
    """The cap message must name the departments the rule caps, not GC's."""
    rule = {
        "total_credits": 12,
        "explicit_courses": [],
        "wildcards": [{"type": "dept_capped", "depts": ["ARTS", "MUSC"],
                       "cap_credits": 3}],
    }
    progress = Progress(version="gc-progress-v1", catalog_year="2026-2027",
                        program="Other Major, BS",
                        passed=[PassedCourse("ARTS 1010", "", 3),
                                PassedCourse("MUSC 1010", "", 3)])
    out = evaluate_specialty(rule, progress, valid_minors=[])
    joined = " ".join(out["flags"])
    assert "ARTS/MUSC" in joined
    assert "BIOL" not in joined
