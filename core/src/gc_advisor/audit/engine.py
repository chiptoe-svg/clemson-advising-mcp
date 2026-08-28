"""Deterministic degree audit: sanitized gc-progress-v1 vs the catalog-year-
pinned plan, requirement rules, and gen-ed categories. No LLM anywhere —
the agent's job is conversation on top of these results, never the audit
arithmetic itself (spec §3.6)."""
import json
from gc_advisor.db.access import CatalogAccess
from gc_advisor.audit.models import Progress
from gc_advisor.audit.specialty import evaluate_specialty
from gc_advisor.audit.rule_semantics import (
    EVALUATORS as _EVALUATORS,
    rule_evaluator as _rule_evaluator,
    match_gen_ed as _match_gen_ed_impl,
)

# Bump when the audit output dict's shape changes, so downstream consumers
# (CUassistant's audit-gc-progress) can detect a contract change instead of
# silently mis-reading a new shape. Pairs with the input's "gc-progress-v1".
AUDIT_SCHEMA_VERSION = "gc-audit-v1"


def _dedup_credits(passed) -> dict[str, float]:
    """Return {code: max_credits} deduplicating retakes by keeping the
    highest credit value seen.  Used for all credit summations so a
    repeated course never double-counts."""
    seen: dict[str, float] = {}
    for c in passed:
        cr = c.credits or 0.0
        if c.code not in seen or cr > seen[c.code]:
            seen[c.code] = cr
    return seen


# Rule vocabulary now lives in audit.rule_semantics so db.access can apply the
# bogus-rule filter without importing this module (engine imports access).
# Re-exported here because engine has been these names' import site all along.
EVALUATORS = _EVALUATORS
rule_evaluator = _rule_evaluator
_match_gen_ed = _match_gen_ed_impl


def _slot_status_rule(slot_type: str, rule: dict, progress: Progress,
                      valid_minors: list[str], deduped: dict[str, float],
                      consumed: set[str], *, advisor_allow, advisor_deny,
                      required_codes) -> dict:
    """Evaluate a named slot using its requirement_rule against UNCONSUMED
    credits only.  Rules routed by rule_evaluator() to "minor_or_course_set"
    delegate to evaluate_specialty (called once and cached by the caller);
    everything else is a wildcard-aware credit-set check via
    gc_advisor.audit.wildcards."""
    if rule_evaluator(rule) == "minor_or_course_set":
        # Caller builds a filtered Progress with consumed codes excluded.
        return evaluate_specialty(rule, progress, valid_minors,
                                  advisor_allow=advisor_allow, advisor_deny=advisor_deny)

    from gc_advisor.audit.wildcards import SlotContext, counts
    ctx = SlotContext(
        explicit=set(rule.get("explicit_courses", [])),
        wildcards=rule.get("wildcards", []),
        advisor_allow=set(advisor_allow), advisor_deny=set(advisor_deny),
        required_codes=set(required_codes),
    )
    unconsumed = {c: cr for c, cr in deduped.items()
                  if c not in consumed and counts(c, ctx)}
    # Generic rule slots intentionally do NOT apply dept_capped aggregate
    # capping here — every unconsumed matching credit counts at full value.
    # Only the Specialty path (specialty.py, via capped_depts) enforces a
    # per-department credit cap. A future rule that needs a cap must be
    # routed through the specialty-style evaluator, not this generic path.
    earned = sum(unconsumed.values())
    need = rule.get("total_credits", 0)
    counted = sorted(unconsumed.keys())
    status = "met" if (earned >= need if need else bool(counted)) else "unmet"
    return {
        "status": status,
        "credits_earned": earned,
        "credits_required": need,
        "counted_courses": counted,
        "flags": [],
    }


def run_audit(db_path: str, progress: Progress) -> dict:
    """Walk the catalog-year-pinned degree plan and produce a full audit
    report: per-item status, gen-ed progress, credits remaining,
    prereq-eligible next courses, and advisory flags.

    Uses a two-pass waterfall allocation so each course credit is consumed
    at most once:
      Pass 1 — fixed_course and choice items (plan order).
      Pass 2 — slot items (plan order); elective slots resolved last.

    Returns a plain dict ready for JSON serialisation.
    """
    acc = CatalogAccess(db_path)

    plan = acc.get_program_plan(progress.catalog_year, progress.program)
    # No filtering here. get_requirement_rules already drops bogus rules
    # (rule_semantics.is_bogus_rule) so that this engine and every other
    # consumer of the access layer — scripts/query.py, CUassistant's MCP
    # tools — see exactly the same rule set. The filter used to live here,
    # which meant the two entry points disagreed about what a program
    # requires.
    rules = {
        r["slot_type"]: r["rule"]
        for r in acc.get_requirement_rules(progress.catalog_year, progress.program)
    }
    gen_ed_cats = acc.get_gen_ed(progress.catalog_year)
    valid_minors = acc.get_minors(progress.catalog_year)

    # Dedup passed courses once; reuse for all credit arithmetic.
    deduped = _dedup_credits(progress.passed)
    passed_codes = set(deduped.keys())
    in_prog = set(progress.in_progress)

    # Allocation state shared across both passes.
    consumed: set[str] = set()

    flags: list[str] = list(progress.warnings)

    # Flag passed courses absent from the course catalog.  Sorted so the
    # flag order is stable across processes: passed_codes is a set, and its
    # iteration order varies with PYTHONHASHSEED, which made this list —
    # and therefore the whole audit payload — nondeterministic run to run.
    for code in sorted(passed_codes):
        if acc.get_course(code) is None:
            flags.append(f"{code}: not in course catalog — verify manually")

    # ------------------------------------------------------------------
    # Pre-flatten all plan items preserving group label for later.
    # ------------------------------------------------------------------
    all_items: list[tuple[dict, dict]] = []  # (group, item)
    for group in plan["groups"]:
        for it in group["items"]:
            all_items.append((group, it))

    # Plan-required set: fixed_course codes that are NOT derivation-eligible
    # for other slots' subject_nonrequired wildcards.
    # Defensive/semantic only: in practice these codes are already excluded
    # via the `consumed` waterfall by the time a wildcard slot is evaluated,
    # so this set has no additional observable effect on the audit (the
    # exclusion logic itself is unit-tested in test_wildcards.py).
    required_codes = {it["course_code"] for _, it in all_items
                      if it["kind"] == "fixed_course" and it["course_code"]}

    # ------------------------------------------------------------------
    # PASS 1: fixed_course and choice items.
    # ------------------------------------------------------------------
    entries: dict[int, dict] = {}  # idx -> entry dict

    for idx, (group, it) in enumerate(all_items):
        if it["kind"] not in ("fixed_course", "choice"):
            entries[idx] = None  # placeholder; filled in pass 2
            continue

        entry: dict = {
            "group": group["label"],
            "kind": it["kind"],
            "course_code": it["course_code"],
            "one_of": it["one_of"],
            "slot_type": it["slot_type"],
            "credits": it["credits"],
        }

        if it["kind"] == "fixed_course":
            code = it["course_code"]
            if code in passed_codes:
                entry["status"] = "met"
                consumed.add(code)
            elif code in in_prog:
                entry["status"] = "in_progress"
            else:
                entry["status"] = "unmet"

        else:  # choice
            # Consume the first passing option not yet consumed; other
            # passing options remain available for other slots.
            hit = [c for c in it["one_of"] if c in passed_codes]
            run = [c for c in it["one_of"] if c in in_prog]
            if hit:
                entry["status"] = "met"
                consumed.add(hit[0])
            elif run:
                entry["status"] = "in_progress"
            else:
                entry["status"] = "unmet"
            entry["satisfied_by"] = hit

        entries[idx] = entry

    # ------------------------------------------------------------------
    # PASS 2: slot items.
    # minor_or_course_set-routed slots are evaluated once and cached (see
    # _get_one_of_result, below); electives are collected and resolved at
    # the end after all other slots have consumed their credits.
    # ------------------------------------------------------------------

    # Cache minor-or-course-set evaluation results (minor path or course-set
    # path), keyed by slot_type so a program with more than one such slot
    # gets each slot's own result rather than sharing a single answer.
    # Build a filtered Progress that excludes consumed codes so that
    # evaluation only sees the credits BEYOND what the major required.
    _one_of_cache: dict[str, dict] = {}

    def _get_one_of_result(slot_type: str) -> dict:
        if slot_type in _one_of_cache:
            return _one_of_cache[slot_type]
        # Build a Progress view with consumed codes stripped from passed.
        filtered_passed = [c for c in progress.passed if c.code not in consumed]
        from gc_advisor.audit.models import Progress as Prog
        filtered_progress = Prog(
            version=progress.version,
            catalog_year=progress.catalog_year,
            program=progress.program,
            passed=filtered_passed,
            in_progress=progress.in_progress,
            minor=progress.minor,
            grade_checks=progress.grade_checks,
            warnings=progress.warnings,
        )
        # Reuse the advisor sets get_requirement_rules already merged onto the
        # rule (advisor_courses / advisor_denies) instead of re-querying the DB.
        spec_rule = rules.get(slot_type, {})
        _one_of_cache[slot_type] = evaluate_specialty(
            spec_rule, filtered_progress, valid_minors,
            advisor_allow=set(spec_rule.get("advisor_courses", [])),
            advisor_deny=set(spec_rule.get("advisor_denies", [])))
        return _one_of_cache[slot_type]

    # Slots whose indices and items will be resolved after other slots.
    elective_indices: list[tuple[int, dict, dict]] = []  # (idx, group, it)

    for idx, (group, it) in enumerate(all_items):
        if it["kind"] != "slot":
            continue

        entry: dict = {
            "group": group["label"],
            "kind": it["kind"],
            "course_code": it["course_code"],
            "one_of": it["one_of"],
            "slot_type": it["slot_type"],
            "credits": it["credits"],
        }

        st = it["slot_type"] or ""
        slot_need = it["credits"] or 0

        # -- Elective slots: defer to after all other slots. --
        is_elective = "Elective" in st and st not in rules
        if is_elective:
            # Check also that it's not a gen-ed match.
            cat_check = _match_gen_ed(st, gen_ed_cats)
            if cat_check is None:
                elective_indices.append((idx, group, it))
                entries[idx] = None  # placeholder
                continue

        if st in rules:
            if rule_evaluator(rules[st]) == "minor_or_course_set":
                detail = _get_one_of_result(st)
                entry.update(detail)
                flags.extend(detail.get("flags", []))
                # For specialty slots: consume counted_courses when met via
                # course_set path; minor path consumes nothing extra.
                if detail.get("status") == "met" and detail.get("via") == "course_set":
                    for code in detail.get("counted_courses", []):
                        consumed.add(code)
            else:
                rule_need = rules[st].get("total_credits", 0)
                # Reuse the advisor sets already merged onto the rule (no re-query).
                detail = _slot_status_rule(st, rules[st], progress, valid_minors,
                                           deduped, consumed,
                                           advisor_allow=set(rules[st].get("advisor_courses", [])),
                                           advisor_deny=set(rules[st].get("advisor_denies", [])),
                                           required_codes=required_codes)
                entry.update(detail)
                flags.extend(detail.get("flags", []))
                if detail.get("status") == "met":
                    # Greedily consume counted codes in sorted order until the
                    # rule's credit need is covered — same as gen-ed slots —
                    # so surplus eligible courses remain available for electives.
                    total = 0.0
                    for code in detail.get("counted_courses", []):
                        if rule_need and total >= rule_need:
                            break
                        consumed.add(code)
                        total += deduped.get(code, 0.0)
        else:
            cat = _match_gen_ed(st, gen_ed_cats)
            if cat:
                allowed = set(cat["allowed_courses"])
                unconsumed_allowed = [c for c in deduped
                                      if c in allowed and c not in consumed]
                got = sum(deduped[c] for c in unconsumed_allowed)
                # A 0-credit slot still requires a course. `got >= slot_need`
                # is `0 >= 0` for one, i.e. TRUE for a student who has taken
                # nothing — a wrong-`met`. 0-credit slots arrive from the
                # two-column artifact split in parse_program, where the merged
                # course owns the printed cell's credits and the artifact slot
                # carries 0. This mirrors _slot_status_rule, which has always
                # read a falsy need as "any one matching course satisfies".
                met = (got >= slot_need) if slot_need else bool(unconsumed_allowed)
                entry["status"] = "met" if met else "unmet"
                entry["credits_earned"] = got
                entry["gen_ed_category"] = cat["name"]
                if met:
                    # Greedily consume in iteration order until slot need covered.
                    total = 0.0
                    for c in unconsumed_allowed:
                        if total >= slot_need:
                            break
                        consumed.add(c)
                        total += deduped[c]
            else:
                entry["status"] = "manual"
                flags.append(
                    f"Slot {st!r}: no rule or gen-ed match — verify manually"
                )

        entries[idx] = entry

    # ------------------------------------------------------------------
    # Resolve elective slots last: absorb all unallocated credits.
    # ------------------------------------------------------------------
    unallocated = sum(cr for c, cr in deduped.items() if c not in consumed)

    for idx, group, it in elective_indices:
        entry: dict = {
            "group": group["label"],
            "kind": it["kind"],
            "course_code": it["course_code"],
            "one_of": it["one_of"],
            "slot_type": it["slot_type"],
            "credits": it["credits"],
        }
        slot_need = it["credits"] or 0
        if unallocated >= slot_need:
            entry["status"] = "met"
            unallocated -= slot_need
        else:
            entry["status"] = "unmet"
            flags.append(
                f"Elective slot ({slot_need}cr): only {unallocated:g} unallocated credits remain"
            )
        entries[idx] = entry

    # ------------------------------------------------------------------
    # Assemble ordered items list and accumulate credits_earned.
    # ------------------------------------------------------------------
    items: list[dict] = []
    credits_earned = 0.0

    for idx, (group, it) in enumerate(all_items):
        entry = entries[idx]
        if entry is None:
            # Should not happen — every slot is either filled or deferred.
            continue
        items.append(entry)
        if entry.get("status") == "met":
            credits_earned += it["credits"] or 0.0

    # ------------------------------------------------------------------
    # Gen-ed summary (independent of plan walk — uses full deduped credits).
    # ------------------------------------------------------------------
    gen_ed: list[dict] = []
    for cat in gen_ed_cats:
        allowed = set(cat["allowed_courses"])
        earned = sum(cr for code, cr in deduped.items() if code in allowed)
        gen_ed.append({
            "name": cat["name"],
            "min_credits": cat["min_credits"],
            "credits_earned": earned,
            "status": "met" if earned >= cat["min_credits"] else "unmet",
            "constraints": cat["rules"],
        })

    # ------------------------------------------------------------------
    # Eligible next: unmet fixed_course / choice items whose parsed prereqs
    # are all satisfied (or absent).
    # ------------------------------------------------------------------
    eligible: list[dict] = []
    for it in items:
        if it.get("status") != "unmet":
            continue
        candidates: list[str] = []
        if it["kind"] == "fixed_course" and it["course_code"]:
            candidates = [it["course_code"]]
        elif it["kind"] == "choice":
            candidates = list(it.get("one_of") or [])

        for code in candidates:
            course = acc.get_course(code)
            if course is None:
                continue
            raw = course.get("prereq_parsed")
            prereqs: list[str] = json.loads(raw) if raw else []
            missing = [p for p in prereqs if p not in passed_codes]

            coreq_raw = course.get("coreq_parsed")
            coreqs = json.loads(coreq_raw) if coreq_raw else []
            coreq_extra = {"co_reqs": coreqs} if coreqs else {}

            if not prereqs:
                eligible.append({"code": code, "prereq": "none listed",
                                 **coreq_extra})
            elif not missing:
                eligible.append({"code": code, "prereq": "all parsed prereqs passed",
                                 **coreq_extra})
            elif len(missing) < len(prereqs):
                eligible.append({
                    "code": code,
                    "prereq": (
                        f"partial — check prereq text "
                        f"(missing: {', '.join(missing)})"
                    ),
                    "prereq_text": course.get("prereq_text"),
                    **coreq_extra,
                })

    # Deduplicate flags preserving order.
    flags = list(dict.fromkeys(flags))

    # A program page without a "Total Credits:" line stores NULL. Report the
    # unknown rather than crashing — the per-slot audit is still useful.
    total = plan["total_credits"]
    remaining = None if total is None else max(0.0, total - credits_earned)
    return {
        "audit_version": AUDIT_SCHEMA_VERSION,
        "catalog_year": progress.catalog_year,
        "program": plan["name"],
        "source_url": plan.get("source_url"),
        "total_credits_required": total,
        "credits_earned": credits_earned,
        "credits_remaining": remaining,
        "items": items,
        "gen_ed": gen_ed,
        "eligible_next": eligible,
        "flags": flags,
    }
