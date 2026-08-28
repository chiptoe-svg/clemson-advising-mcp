"""Which evaluator a requirement rule routes to must come from the rule, not
from the slot's name. engine.py branched on the literal substring "Specialty
Area", so a department whose equivalent slot is called something else could
never reach the minor-or-course-set path."""
from gc_advisor.audit.engine import rule_evaluator


def test_rule_declaring_a_minor_alternative_uses_the_one_of_evaluator():
    rule = {"total_credits": 15,
            "satisfy_one_of": ["approved_minor", "course_set"]}
    assert rule_evaluator(rule) == "minor_or_course_set"


def test_plain_credit_rule_uses_the_credit_set_evaluator():
    assert rule_evaluator({"total_credits": 12, "explicit_courses": []}) == "credit_set"


def test_explicit_evaluator_key_overrides_inference():
    rule = {"total_credits": 12, "evaluator": "minor_or_course_set"}
    assert rule_evaluator(rule) == "minor_or_course_set"


def test_unknown_evaluator_falls_back_to_credit_set():
    assert rule_evaluator({"evaluator": "nonsense"}) == "credit_set"
