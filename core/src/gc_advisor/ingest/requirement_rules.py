import json
import re

CODE_RE = re.compile(r"\b([A-Z]{2,5})\s+(\d{4})\b")

# Rule keys that are hand-authored (see ingest/packs.py, which applies
# department packs) rather than derived from the catalog, and so must survive
# a rebuild. Everything else — explicit_courses, total_credits, raw_text — is
# re-derived on purpose.
PRESERVED_RULE_KEYS = ("wildcards", "evaluator")

# Slot types whose catalog-derived rules are ALWAYS wrong and must never be
# derived. The catalog renders the SC REACH Act line in a two-column layout,
# so footnote refs from the adjacent column land on the REACH row and the
# derivation reads whatever prose sits beside it. Every derivation observed
# was a mis-association, none a real requirement: Pre-Business derived 15
# business courses (ACCT 2010/2020/3030/3110, CPSC 2200, ECON 3140, FIN
# 3060/3110, LAW 3220, MATH 3020, MGT 2010/2180, MKT 3010, STAT 2300/3090),
# Accounting derived ACCT 4100, Management derived MGT 4150, Economics BS
# derived FIN 3110. The registrar's actual rule is a fixed three-course
# option set (3 Credits in HIST 1010 or POSC 1010 or POSC 1030, or an
# AP/IB/dual-enrollment exemption) — see docs/degreeworks/
# freshman_accounting_blank_2627cleaned.md line 27, mirrored in
# tests/fixtures/registrar/reach-act.txt. It is supplied by packs/reach-act/
# instead, and a pack-authored rule is preserved below.
DERIVATION_SKIP = ("REACH",)


def _skipped(slot_type: str | None) -> bool:
    """True when no rule may be DERIVED for this slot type (see
    DERIVATION_SKIP). Substring match: catalog slot names vary in wording
    around the marker."""
    return any(marker in (slot_type or "") for marker in DERIVATION_SKIP)


def _pack_authored(rule: dict) -> bool:
    """A pack-INSERTed rule is identifiable by its empty raw_text: derivation
    always writes the joined footnote prose it extracted courses from, while
    packs.py's INSERT path writes raw_text="" because a pack has no catalog
    source text. Used to keep hand-authored rules for skipped slot types
    while dropping derived ones."""
    return rule.get("raw_text", None) == ""


def build_requirement_rules(con, program_id: int) -> int:
    """Derive requirement_rule rows from a program's footnotes + footnoted slots.
    Deterministic: explicit course codes + summed credits + raw footnote text.
    Skips pointer footnotes ('See General Education Requirements') and elective
    slots (no footnote). Idempotent (clears the program's rules first)."""
    fns = {r["number"]: r["text"] for r in
           con.execute("SELECT number, text FROM footnote WHERE program_id=?", (program_id,))}
    slots: dict[str, dict] = {}
    rows = con.execute(
        "SELECT pi.slot_type, pi.credits, pi.footnote_refs FROM plan_item pi "
        "JOIN requirement_group rg ON pi.group_id=rg.id "
        "WHERE rg.program_id=? AND pi.kind IN ('slot','choice')", (program_id,))
    for r in rows:
        st = r["slot_type"]
        refs = json.loads(r["footnote_refs"] or "[]")
        if not st or not refs or _skipped(st):
            continue
        s = slots.setdefault(st, {"credits": 0, "fns": set()})
        s["credits"] += r["credits"] or 0
        s["fns"].update(refs)

    # Snapshot hand-authored keys before the rebuild drops them — and keep
    # each rule's FULL body too: a pack-inserted rule for a footnote-less slot
    # re-derives to nothing, so without the full snapshot the rebuild would
    # destroy it outright (observed live: an Economics backfill wiped
    # Accounting's pack-inserted Business Requirement rules).
    curated: dict[str, dict] = {}
    snapshots: dict[str, dict] = {}
    for r in con.execute(
            "SELECT slot_type, rule FROM requirement_rule WHERE program_id=?",
            (program_id,)):
        d = json.loads(r["rule"])
        snapshots[r["slot_type"]] = d
        keep = {k: d[k] for k in PRESERVED_RULE_KEYS if k in d}
        if keep:
            curated[r["slot_type"]] = keep

    con.execute("DELETE FROM requirement_rule WHERE program_id=?", (program_id,))
    made = 0
    for st, info in slots.items():
        raw = " ".join(fns[n] for n in sorted(info["fns"]) if n in fns).strip()
        explicit = sorted({f"{a} {b}" for a, b in CODE_RE.findall(raw)})
        has_minor = "minor" in raw.lower()
        if not explicit and not has_minor:
            continue
        rule = {
            "slot_type": st,
            "total_credits": info["credits"],
            "explicit_courses": explicit,
            "raw_text": raw,
        }
        if has_minor and "select one" in raw.lower():
            rule["satisfy_one_of"] = ["approved_minor", "course_set"]
        rule.update(curated.get(st, {}))
        con.execute(
            "INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
            (program_id, st, json.dumps(rule)))
        made += 1

    # Re-insert snapshotted rules the derivation did not recreate, whole,
    # as long as the plan still carries slot items of that slot_type — a
    # hand-authored (pack-inserted) rule must survive the routine rebuild.
    derived = {r["slot_type"] for r in con.execute(
        "SELECT slot_type FROM requirement_rule WHERE program_id=?", (program_id,))}
    for st, body in snapshots.items():
        if st in derived:
            continue
        # The snapshot half needs the same skip-list as the derivation half,
        # or a bad REACH rule written by an OLDER build would outlive every
        # rebuild: derivation no longer recreates it, so the re-insert below
        # would faithfully restore it forever. Pack-authored rules for the
        # same slot are the whole point of the re-insert, so they survive.
        if _skipped(st) and not _pack_authored(body):
            continue
        still_planned = con.execute(
            "SELECT 1 FROM plan_item pi JOIN requirement_group g ON pi.group_id=g.id "
            "WHERE g.program_id=? AND pi.slot_type=? AND pi.kind='slot' LIMIT 1",
            (program_id, st)).fetchone()
        if still_planned:
            con.execute(
                "INSERT INTO requirement_rule(program_id, slot_type, rule) VALUES(?,?,?)",
                (program_id, st, json.dumps(body)))
            made += 1
    con.commit()
    return made


def build_rules_for_catalog_year(con, catalog_year_id: int) -> dict[int, int]:
    """Build requirement rules for every major AND pre-business program in a
    catalog year.

    Returns {program_id: rules_made}. Callers used to pick the year's major
    with a single fetchone(), which silently left every major but one without
    rules once a second department was ingested; the kind filter then also
    excluded Pre-Business, whose footnoted requirements derive real rules.
    """
    rows = con.execute(
        "SELECT id FROM program WHERE catalog_year_id=? "
        "AND kind IN ('major','pre_business') ORDER BY id",
        (catalog_year_id,)).fetchall()
    return {r["id"]: build_requirement_rules(con, r["id"]) for r in rows}
