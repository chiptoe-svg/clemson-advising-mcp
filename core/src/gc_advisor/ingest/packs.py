"""Department packs — the declarative form of per-department knowledge that is
not derivable from the catalog: wildcards, curated advisor courses, and rules
for slots the catalog does not describe.

Replaces the hand-authored Python constants in
scripts/backfill_advisor_and_wildcards.py. Every write is scoped to the pack's
own programs, so two departments sharing a slot name cannot overwrite each
other.

A pack rule OVERRIDES a catalog-derived rule where one exists; where none
was derived, it CREATES one — but only for programs whose plan actually
carries slot items of that slot_type (credits summed from the plan), so a
pack can never invent a requirement the catalog does not show.

PACK_RULE_KEYS is deliberately asymmetric with requirement_rules.PRESERVED_RULE_KEYS:

- `evaluator` is pack-authored knowledge with no catalog source, so it is both
  settable here AND preserved across a requirement_rules rebuild.
- `explicit_courses` is settable here but NOT preserved: the catalog is
  authoritative for it, so build_requirement_rules re-deriving it from
  footnotes on every rebuild is correct, not a bug worth "fixing" by adding
  it to PRESERVED_RULE_KEYS.
- `total_credits` is NOT in PACK_RULE_KEYS at all, and stays out on purpose.
  On the UPDATE path build_requirement_rules always writes an integer for it,
  so apply_pack's narrowed overwrite predicate (`rule.get(key) in
  (None, [], {})`) never treats it as empty and refuses to overwrite it. On
  the INSERT path it is summed from that program-year's own plan slot items —
  the plan, not the pack, is authoritative for how many credits a slot is
  worth, which is what stops a pack from inventing or resizing a requirement.
  A NULL sum raises rather than writing 0 (a 0-credit credit_set rule is
  satisfied by any single matching course). Omitting the key means load_pack
  raises its "unrecognized rule key" error if a pack tries to set it — a loud
  failure, consistent with this hand-authored surface's other validation.
"""
import json
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from gc_advisor.audit.engine import EVALUATORS
from gc_advisor.db import advisor

# Rule keys a pack may set on a catalog-derived rule. See the module
# docstring above for why total_credits is absent.
PACK_RULE_KEYS = ("wildcards", "evaluator", "explicit_courses")

# Wildcard types gc_advisor.audit.wildcards actually implements (from its
# _allows/_denies dispatch), and the fields each one requires. An unknown
# type or a missing required field would otherwise load and apply silently,
# then either raise a bare KeyError at audit time or — worse — just never
# match anything, so a capped/denied slot quietly stops being capped/denied.
WILDCARD_REQUIRED_FIELDS = {
    "dept_any": ("dept",),
    "dept_level_min": ("dept", "min"),
    "level_min": ("min",),
    "dept_capped": ("depts", "cap_credits"),
    "subject_pattern": ("subject", "number_glob"),
    "subject_nonrequired": ("subject",),
}


@dataclass
class Pack:
    name: str
    programs: list[str]
    rules: dict[str, dict] = field(default_factory=dict)
    advisor_courses: list[dict] = field(default_factory=list)


def load_pack(path: Path) -> Pack:
    """Read a pack directory into a Pack. Missing rules/ or advisor-courses.toml
    are allowed — a pack may carry only one kind of knowledge."""
    path = Path(path)
    meta_path = path / "pack.toml"
    meta = tomllib.loads(meta_path.read_text())
    try:
        name = meta["name"]
    except KeyError:
        raise ValueError(f"{meta_path}: missing required key 'name'") from None
    try:
        programs = list(meta["programs"])
    except KeyError:
        raise ValueError(f"{meta_path}: missing required key 'programs'") from None

    rules: dict[str, dict] = {}
    rules_dir = path / "rules"
    if rules_dir.is_dir():
        for f in sorted(rules_dir.glob("*.toml")):
            d = tomllib.loads(f.read_text())
            try:
                slot = d.pop("slot_type")
            except KeyError:
                raise ValueError(f"{f}: missing required key 'slot_type'") from None
            for key in d:
                if key not in PACK_RULE_KEYS:
                    raise ValueError(
                        f"{f}: unrecognized rule key {key!r} "
                        f"(valid keys: {', '.join(PACK_RULE_KEYS)})")
            if "evaluator" in d and d["evaluator"] not in EVALUATORS:
                raise ValueError(
                    f"{f}: unrecognized evaluator {d['evaluator']!r} "
                    f"(valid evaluators: {', '.join(EVALUATORS)})")
            for w in d.get("wildcards", []):
                wtype = w.get("type")
                if wtype not in WILDCARD_REQUIRED_FIELDS:
                    raise ValueError(
                        f"{f}: unrecognized wildcard type {wtype!r} "
                        f"(valid types: {', '.join(sorted(WILDCARD_REQUIRED_FIELDS))})")
                missing = [k for k in WILDCARD_REQUIRED_FIELDS[wtype] if k not in w]
                if missing:
                    raise ValueError(
                        f"{f}: wildcard type {wtype!r} missing required "
                        f"field(s) {', '.join(missing)}")
            rules[slot] = dict(d)
    courses: list[dict] = []
    ac = path / "advisor-courses.toml"
    if ac.is_file():
        courses = tomllib.loads(ac.read_text()).get("course", [])
    return Pack(name=name, programs=programs, rules=rules, advisor_courses=courses)


def apply_pack(con, pack: Pack, *, added_on: str) -> dict:
    """Apply a pack to the DB, scoped to its own programs. Idempotent: a rule
    key is only filled when it is absent or empty (None, [], {}) — a falsy-but-
    real value like total_credits: 0 is left alone — and duplicate advisor
    rows are ignored."""
    rules_updated = 0
    for program in pack.programs:
        for slot, overrides in pack.rules.items():
            # Scoped per PROGRAM-YEAR, never per program NAME. Rules are built
            # and destroyed one program_id at a time (build_requirement_rules
            # DELETEs by program_id), so a single-year re-ingest leaves a hole
            # in exactly one year. A name-wide existence check saw the sibling
            # years' surviving rows, took the UPDATE branch, and left that hole
            # permanently unhealable — re-applying the pack could never restore
            # it. (final review, I3)
            for prow in con.execute(
                    "SELECT id FROM program WHERE name=? ORDER BY id",
                    (program,)).fetchall():
                pid = prow["id"]
                row = con.execute(
                    "SELECT id, rule FROM requirement_rule "
                    "WHERE program_id=? AND slot_type=?", (pid, slot)).fetchone()
                if row is not None:
                    rule = json.loads(row["rule"])
                    changed = False
                    for key, value in overrides.items():
                        if rule.get(key) in (None, [], {}):
                            rule[key] = value
                            changed = True
                    if changed:
                        con.execute("UPDATE requirement_rule SET rule=? WHERE id=?",
                                    (json.dumps(rule), row["id"]))
                        rules_updated += 1
                    continue

                # No rule for THIS program-year. Create one — but ONLY if this
                # year's plan actually carries slot items of this slot_type (a
                # pack must never invent a requirement). total_credits is summed
                # from that year's own slot items. COUNT distinguishes "no such
                # slot in the plan" (skip) from "slot present but credits NULL"
                # (raise, below); a bare SUM returns NULL for both.
                planned = con.execute(
                    "SELECT COUNT(*) AS n, SUM(pi.credits) AS total "
                    "FROM plan_item pi "
                    "JOIN requirement_group g ON pi.group_id=g.id "
                    "WHERE g.program_id=? AND pi.slot_type=? AND pi.kind='slot'",
                    (pid, slot)).fetchone()
                if not planned["n"]:
                    continue
                if planned["total"] is None:
                    # Writing total_credits: 0 here would be silently unsafe:
                    # _slot_status_rule treats a falsy `need` as "any matching
                    # course satisfies the slot" (`bool(counted)`), so a
                    # 0-credit credit_set rule audits MET off one course. A
                    # plan slot with no credits is a parse defect — say so.
                    raise ValueError(
                        f"{pack.name}: cannot create a rule for {slot!r} in "
                        f"program {program!r} (program_id={pid}) — its plan "
                        f"slot items carry no credits (SUM is NULL). Writing "
                        f"total_credits=0 would make any single matching "
                        f"course satisfy the slot. Fix the plan ingest first.")
                rule = {"slot_type": slot, "total_credits": planned["total"],
                        "explicit_courses": [], "raw_text": ""}
                rule.update(overrides)
                con.execute(
                    "INSERT INTO requirement_rule(program_id, slot_type, rule) "
                    "VALUES(?,?,?)", (pid, slot, json.dumps(rule)))
                rules_updated += 1

    added = 0
    for program in pack.programs:
        for c in pack.advisor_courses:
            added += advisor.add_course(
                con, c["slot_type"], c["code"],
                action=c.get("action", "allow"),
                catalog_year=c.get("catalog_year"),
                note=c.get("note"), added_on=added_on, program=program)
    con.commit()
    # keep the materialized bogus flags in agreement with what we just wrote
    from gc_advisor.db.access import refresh_bogus_flags
    refresh_bogus_flags(con)
    return {"rules_updated": rules_updated, "advisor_added": added}
