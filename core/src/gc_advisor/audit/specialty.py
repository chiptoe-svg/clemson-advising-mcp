"""Specialty-Area evaluation (GC footnote 2): minor path OR >=15cr course set.
Counting rules (wildcards + 4cr science cap) come from rule['wildcards'];
advisor additions/removals come from the advisor_course layer (spec §A)."""
from gc_advisor.audit.models import Progress
from gc_advisor.audit.wildcards import SlotContext, counts, capped_depts


def _minor_match(name: str, valid_minors: list[str]) -> tuple[bool, bool]:
    norm = name.strip().lower()
    if any(m.lower() == norm for m in valid_minors):
        return True, False
    prefix = [m for m in valid_minors
              if m.lower().startswith(norm) or norm.startswith(m.lower())]
    if len(prefix) == 1:
        return True, False
    if len(prefix) > 1:
        return True, True
    return False, False


def evaluate_specialty(rule: dict, progress: Progress, valid_minors: list[str], *,
                       advisor_allow: frozenset[str] = frozenset(),
                       advisor_deny: frozenset[str] = frozenset()) -> dict:
    flags: list[str] = []
    if progress.minor:
        name = progress.minor.get("name", "")
        found, ambiguous = _minor_match(name, valid_minors)
        if not found:
            flags.append(f"Declared minor {name!r} not found in catalog minors for this year — verify manually")
        elif ambiguous:
            flags.append(f"Declared minor {name!r} matches multiple catalog minors — verify manually")
        status = "met" if progress.minor.get("complete") else "in_progress"
        return {"status": status, "via": "minor", "minor": name,
                "credits_earned": None, "flags": flags}

    total = rule.get("total_credits", 15)
    ctx = SlotContext(
        explicit=set(rule.get("explicit_courses", [])),
        wildcards=rule.get("wildcards", []),
        advisor_allow=set(advisor_allow),
        advisor_deny=set(advisor_deny),
    )
    capped, cap = capped_depts(ctx)

    seen: dict[str, float] = {}
    for c in progress.passed:
        cr = c.credits or 0
        if c.code not in seen or cr > seen[c.code]:
            seen[c.code] = cr

    capped_sum = 0.0
    other_sum = 0.0
    counted: list[str] = []
    for code, cr in seen.items():
        if not counts(code, ctx):
            continue
        if code.split(" ")[0] in capped:
            capped_sum += cr
        else:
            other_sum += cr
        counted.append(code)

    earned = other_sum + (min(capped_sum, cap) if cap is not None else capped_sum)
    dept_label = "/".join(sorted(capped))
    if cap is not None and capped_sum > cap:
        flags.append(f"{dept_label} credits capped at {cap} (had {capped_sum:g})")
    if capped_sum > 0:
        flags.append(f"{dept_label} credits accepted provisionally — confirm "
                     f"they satisfy the Natural Science with Lab gen-ed requirement")
    status = "met" if earned >= total else "unmet"
    return {"status": status, "via": "course_set", "minor": None,
            "credits_earned": earned, "counted_courses": sorted(counted),
            "credits_required": total, "flags": flags}
