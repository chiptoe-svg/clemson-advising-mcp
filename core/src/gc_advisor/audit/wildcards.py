"""Pure wildcard/membership evaluation for requirement slots (spec §A.1/A.3).
No DB, no I/O — the audit engine and specialty evaluator feed it a SlotContext
built from the rule JSON + merged advisor entries."""
from dataclasses import dataclass, field


@dataclass
class SlotContext:
    explicit: set[str]                                   # catalog explicit_courses
    wildcards: list[dict]                                # rule["wildcards"]
    advisor_allow: set[str] = field(default_factory=set)
    advisor_deny: set[str] = field(default_factory=set)
    required_codes: set[str] = field(default_factory=set)  # plan-required (subject_nonrequired)


def _num_matches_glob(num: str, glob: str) -> bool:
    """'37XX' matches 3700-3799; X is any digit; lengths must match."""
    if len(num) != len(glob):
        return False
    return all(g == "X" or g == n for g, n in zip(glob, num))


def _denies(dept: str, num: str, code: str, w: dict) -> bool:
    t = w.get("type")
    if t == "subject_pattern" and not w.get("allow", True):
        return dept == w["subject"] and _num_matches_glob(num, w["number_glob"])
    if t == "subject_nonrequired" and dept == w["subject"]:
        if code in (w.get("deny") or []):
            return True
        ne = w.get("number_exclude")
        if ne and _num_matches_glob(num, ne):
            return True
    return False


def _allows(dept: str, num: str, code: str, w: dict, required: set[str]) -> bool:
    t = w.get("type")
    if t == "dept_any":
        return dept == w["dept"]
    if t == "dept_level_min":
        return dept == w["dept"] and num.isdigit() and int(num) >= w["min"]
    if t == "level_min":
        # any department at or above the level — DegreeWorks "@ N:4999"
        return num.isdigit() and int(num) >= w["min"]
    if t == "dept_capped":
        return dept in w["depts"]
    if t == "subject_pattern":
        return bool(w.get("allow", True)) and dept == w["subject"] and _num_matches_glob(num, w["number_glob"])
    if t == "subject_nonrequired":
        return dept == w["subject"] and code not in required
    return False


def counts(code: str, ctx: SlotContext) -> bool:
    """True if `code` counts toward the slot, per the precedence table (§A.3).
    Capping (dept_capped) is aggregate and handled by the caller via
    capped_depts(); this function only decides membership."""
    dept, _, num = code.partition(" ")
    if code in ctx.advisor_deny:
        return False
    if code in ctx.explicit or code in ctx.advisor_allow:
        return True
    for w in ctx.wildcards:                       # allow_except re-includes despite denies
        if code in (w.get("allow_except") or []):
            return True
    for w in ctx.wildcards:
        if _denies(dept, num, code, w):
            return False
    for w in ctx.wildcards:
        if _allows(dept, num, code, w, ctx.required_codes):
            return True
    return False


def capped_depts(ctx: SlotContext) -> tuple[set[str], int | None]:
    """Return (departments-under-cap, cap_credits) from any dept_capped
    wildcard, else (empty, None)."""
    for w in ctx.wildcards:
        if w.get("type") == "dept_capped":
            return set(w["depts"]), w["cap_credits"]
    return set(), None
