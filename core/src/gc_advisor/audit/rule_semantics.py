"""Rule vocabulary shared by the audit engine and the DB access layer.

These three concerns — which evaluator a rule routes to, which gen-ed category
a slot name maps onto, and whether a rule is bogus enough to ignore — are
needed by BOTH `audit.engine` (to walk a plan) and `db.access` (to serve
requirement rules to `scripts/query.py` and to CUassistant's MCP tools).
Keeping them here rather than in `engine` is what lets `access` apply the
bogus-rule filter without importing `engine`, which imports `access` (cycle).

`engine` re-exports `EVALUATORS`, `rule_evaluator` and `_match_gen_ed` so
existing imports keep working; the definitions live here.
"""

EVALUATORS = ("credit_set", "minor_or_course_set")


def rule_evaluator(rule: dict) -> str:
    """Which evaluator a rule routes to, from the rule itself.

    An explicit `evaluator` key wins (a pack may declare one). Otherwise a rule
    offering an approved-minor alternative — which requirement_rules.py derives
    from any footnote saying "select one" and mentioning a minor — routes to the
    minor-or-course-set path. So does a rule carrying a `dept_capped` wildcard,
    even with no minor alternative: the generic credit_set path
    (_slot_status_rule in engine.py) intentionally does not apply dept_capped
    aggregate capping, so a capped rule must go through evaluate_specialty
    regardless of satisfy_one_of, or its capped department's credits count at
    full value and its advisory flags never fire. GC's pre-2023 Specialty Area
    rule is exactly this case: no minor option was offered yet (no
    satisfy_one_of), but it already carried the dept_capped wildcard.
    Everything else is a plain credit set.
    """
    declared = rule.get("evaluator")
    if declared in EVALUATORS:
        return declared
    if "approved_minor" in (rule.get("satisfy_one_of") or []):
        return "minor_or_course_set"
    if any(w.get("type") == "dept_capped" for w in rule.get("wildcards") or []):
        return "minor_or_course_set"
    return "credit_set"


def match_gen_ed(slot_type: str, categories: list[dict]) -> dict | None:
    """Find the gen-ed category whose name (stem before ' with ') matches
    slot_type. Catalog categories are plural ("Social Sciences") while some
    programs name slots in the singular ("Social Science Requirement"), so a
    trailing 's' on the stem is optional when matching.

    The same category can match multiple plan slots (e.g. both A&H Literature
    and Non-Literature slots map to the single "Arts and Humanities" category);
    the waterfall consumed set in run_audit ensures each slot draws only from
    unconsumed credits.

    NOTE: in engine.run_audit this is only called for slots absent from the
    rules dict. It is ALSO called by the bogus-rule filter below, on slots that
    do have a rule — that is the point of the filter.
    """
    haystack = slot_type.lower()
    for cat in categories:
        stem = cat["name"].split(" with ")[0].strip()
        if not stem:
            continue
        needle = stem.lower()
        if needle in haystack:
            return cat
        if needle.endswith("s") and needle[:-1] in haystack:
            return cat
    return None


def is_bogus_rule(slot_type: str, rule: dict, gen_ed_categories: list[dict]) -> bool:
    # Prose-schema rules (minors/certificates: required_courses/elective_rules,
    # no raw_text) are a DIFFERENT contract this predicate cannot judge —
    # treating their missing explicit_courses as "vacuous" silently dropped
    # all 958 of them from the consumer surface (found 2026-08-25 when the
    # materialized flag count came back absurd). Derived and pack rules always
    # carry raw_text ("" for pack INSERTs); prose rules never do.
    if "required_courses" in rule or "raw_text" not in rule:
        return False

    """True when a requirement_rule asserts something the catalog never said
    and must be ignored, letting the slot fall through to gen-ed matching.

    Both tiers exist because `engine.run_audit` gives `slot_type in rules`
    absolute priority over gen-ed matching: if a slot has ANY rule row, gen-ed
    matching for it is never attempted, whatever the rule contains. A junk rule
    is therefore strictly WORSE for a student than no rule at all — `manual`
    tells an advisor to look, while a junk rule renders a confident, wrong
    verdict. Both tiers are footnote MIS-ASSOCIATION: the catalog's two-column
    layout drops a neighbouring column's footnote refs onto a gen-ed row, and
    derivation dutifully reads that prose.

    Tier 1, VACUOUS — a credit_set rule with no courses, no wildcards and no
    advisor entries can never be satisfied by anything, so the slot is unmet
    forever (Marketing's `Natural Science Requirement`, 2024-25 and 2026-27:
    total_credits 4 and nothing that could supply them, unmet even for a
    student holding 8 credits of lab science).

    Tier 2, GEN-ED-SHADOW — a credit_set rule that DOES name explicit courses,
    but has no wildcards, no advisor entries, and whose course list is wholly
    disjoint from the gen-ed category its slot maps onto. Motivating case:
    Management, BS 2025-2026 `Natural Science Requirement` =
    `explicit_courses: ["MGT 4150"]` (a management course, from the residency
    footnote beside it). That is not merely unsatisfiable — it ASSERTS a false
    requirement, telling a student the only way to finish their natural-science
    requirement is a management course. Same year's `Oral Communication
    Requirement` is the same single wrong course; GC 2021-2022's `Arts and
    Humanities (Non-Lit.) Requirement` derived `["ENSP 2000"]` off a footnote
    that says ENSP 2000 may NOT be used for it.

    Disjointness is the discriminator, and it is deliberately conservative: a
    rule that legitimately NARROWS a gen-ed category (Pre-Business's registrar
    Social Science list, ANTH 2010 / PSYC 2010 / SOC 2010, all inside the
    Social Sciences category) intersects it and is kept. Only a list with
    nothing at all in common with the category it claims to constrain is
    treated as mis-association.
    """
    if rule_evaluator(rule) != "credit_set":
        return False
    if rule.get("wildcards") or rule.get("advisor_courses"):
        return False
    explicit = rule.get("explicit_courses")
    if not explicit:
        return True  # tier 1: vacuous
    category = match_gen_ed(slot_type, gen_ed_categories)
    if category is None:
        return False  # not a gen-ed slot; a wrong list here is not ours to judge
    return not (set(explicit) & set(category.get("allowed_courses") or []))
