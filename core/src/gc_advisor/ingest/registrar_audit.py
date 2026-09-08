"""Parse requirement rules out of a Degree Works audit — the REGISTRAR as the
authority for what satisfies a requirement.

WHY THIS EXISTS (2026-09-08, Chip's call). Requirement rules were DERIVED from
the catalog: plan_item rows plus footnote prose, inferred by
`build_rules_for_catalog_year`. That inference is fragile in a way the plan
parse is not — a full re-parse of the catalog with a fixed parser moved the
plan_items correctly and, as a side effect, destroyed 34 major requirement
rules (REACH Act, Minor, Business) while gaining 4. Deriving the operative
gate from published prose is the wrong dependency.

Degree Works is the operative gate: it is what actually clears a student to
graduate, and it states each requirement in a small formal notation rather
than prose --

    3 Credits in HIST 1010 or POSC 1010 or 1030
    1 Class in CH 2010 or 2230
    3 Credits in @ @ with attribute = LIT
    3 Credits in @ @ with attribute = SOSC Except AGRB @ or ECON @
    12 Credits in ACCT 2010 or AGM 2050 or 4060 or ...

-- which is uniform across colleges, where catalog PAGES vary per college (the
source of every parser defect found on 2026-09-08). It also resolves shapes the
catalog leaves ambiguous: the catalog prints "(A and B) or (C and D)", and
Degree Works says plainly that those are two independent choices.

SCOPE, and the division of labour this does NOT change: the catalog stays
authoritative for the PLAN (the semester-by-semester sequence, credit totals,
course inventory), which Degree Works does not publish. This module supplies
RULES only.

PRIVACY. Input is a What-If audit run against no real student, put through the
advisor's document cleaner first. Even so, only the requirement lines are ever
extracted and stored: no name, no ID, no GPA, no course history, no term data.
That mirrors the rule already stated in tests/registrar_rules.py, whose
fixtures commit the rule line and nothing else. Extracted rules belong under
state/ (untracked), not in this public repository, unless Chip decides
otherwise.
"""
import re
from dataclasses import dataclass, field

# "SUBJ 1234" / "@ 1234" — a course reference. "@" is Degree Works' wildcard.
_CODE = r"(@|[A-Z]{2,5})\s+(\d{4})"
# "3 Credits in ..." / "1 Class in ..." — the requirement's size and its options.
NEED_RE = re.compile(r"(\d+)\s+(Credits?|Class(?:es)?)\s+in\s+", re.I)
# "SUBJ 3000:4999" / "@ 3000:4999" — an inclusive catalog-number range.
RANGE_RE = re.compile(rf"{_CODE}:(\d{{4}})")
# The whole exclusion CLAUSE — "Except ECON 3990", and the multi-subject form
# "Except AGRB @ or ECON @". Matching the clause and then pulling every course
# reference out of it, rather than anchoring one reference to the word
# "Except", is what makes the second form work: a per-reference pattern caught
# only "AGRB @" and silently kept ECON as an allowed subject. (A trailing \b
# after "@" also never matches — "@" and the following space are both
# non-word characters — so the original found nothing at all here.)
EXCEPT_CLAUSE_RE = re.compile(r"\bExcept\b(.*)$", re.S | re.I)
_EXCEPT_REF_RE = re.compile(r"\b([A-Z]{2,5})\s+(@|\d{4})")
# An explicit option set. Degree Works ELIDES a repeated subject, so a bare
# number inherits the subject that preceded it: "HIST 1010 or POSC 1010 or 1030"
# is three courses, the last of which is POSC 1030.
OPTION_RE = re.compile(r"\b([A-Z]{2,5})\s+(\d{4})\b|\bor\s+(\d{4})\b")
# "with attribute = LIT" — a gen-ed attribute rather than a course list.
ATTRIBUTE_RE = re.compile(r"with\s+attribute\s*=\s*([A-Z]{2,6})", re.I)
# "resident= Y" — must be taken at Clemson.
RESIDENT_RE = re.compile(r"resident\s*=\s*Y", re.I)

_STILL_NEEDED = "Still needed:"
# A new requirement block's display name: Degree Works prints these in caps
# ("GENERAL EDUCATION - ...", "BREADTH REQUIREMENT (OPTION 2 - "). Used only to
# stop a rule from swallowing the NEXT requirement's heading when the audit's
# line wrapping interleaves them.
_HEADING_RE = re.compile(r"^[A-Z][A-Z0-9 \-#()/&,.']{10,}$")
# Boilerplate that must never be read as a requirement.
_STOP_LINES = ("Legend", "Disclaimer", "Ellucian Degree Works", "Excess Electives")
# HARD block boundaries. Without these a rule ran on into the NEXT block's
# prose and stole its course codes: the REACH Act requirement ("3 Credits in
# HIST 1010 or POSC 1010 or 1030") absorbed the Packaging Science block's
# "Complete PKSC 1020, 2020, 2040 and 2060 with a grade of C or better",
# emerging with PKSC courses among its options. Degree Works ends a block with
# a status word and opens the next with its catalog year, so both are reliable
# stops — and unlike a "looks like rule text" test, they do not trip over the
# display-name fragments the audit interleaves INSIDE a wrapped rule.
_BLOCK_END_RE = re.compile(r"\b(INCOMPLETE|COMPLETE)\b|^Catalog year:", re.I)


@dataclass
class RegistrarRequirement:
    """One "Still needed:" requirement, as the registrar states it."""

    need: int
    #: "credits" or "classes" — Degree Works distinguishes them and so must we.
    unit: str
    courses: list[str] = field(default_factory=list)
    #: {"type": "dept_level_min", "dept": "ACCT", "min": 3000}
    wildcards: list[dict] = field(default_factory=list)
    excludes: list[str] = field(default_factory=list)
    attribute: str | None = None
    resident_required: bool = False
    raw: str = ""

    def is_empty(self) -> bool:
        """No way to satisfy it was stated — a prose requirement ("See advisor")
        rather than a machine-checkable one. Callers must not treat this as a
        requirement with zero options, which would be unsatisfiable."""
        return not (self.courses or self.wildcards or self.attribute)


def _expand_options(text: str) -> list[str]:
    """Explicit option set with Degree Works' elided subjects expanded.

    "3 Credits in HIST 1010 or POSC 1010 or 1030"
      -> ["HIST 1010", "POSC 1010", "POSC 1030"]
    """
    out: list[str] = []
    subject: str | None = None
    for subj, num, bare in OPTION_RE.findall(text):
        if subj:
            subject = subj
            code = f"{subj} {num}"
        elif subject:
            code = f"{subject} {bare}"
        else:
            continue
        if code not in out:
            out.append(code)
    return out


def parse_requirement(text: str) -> RegistrarRequirement | None:
    """One requirement from the text following "Still needed:"."""
    m = NEED_RE.search(text)
    if not m:
        return None
    need = int(m.group(1))
    unit = "credits" if m.group(2).lower().startswith("credit") else "classes"
    body = text[m.end():]

    # Exclusions first: their course codes must not also be read as options.
    clause = EXCEPT_CLAUSE_RE.search(body)
    excludes = (
        [f"{s} {n}" for s, n in _EXCEPT_REF_RE.findall(clause.group(1))]
        if clause
        else []
    )
    body_wo_except = EXCEPT_CLAUSE_RE.sub("", body)

    wildcards = [
        {"type": "dept_level_min", "dept": subj, "min": int(low)}
        if subj != "@"
        else {"type": "level_min", "min": int(low)}
        for subj, low, _high in RANGE_RE.findall(body_wo_except)
    ]
    # A range's own codes must not be re-read as explicit options.
    body_wo_ranges = RANGE_RE.sub(" ", body_wo_except)

    attr = ATTRIBUTE_RE.search(body_wo_ranges)
    # "@ @ with attribute = LIT" states an attribute, not a course list; the
    # bare "@" carries no number so _expand_options finds nothing anyway.
    courses = _expand_options(body_wo_ranges)

    return RegistrarRequirement(
        need=need,
        unit=unit,
        courses=courses,
        wildcards=wildcards,
        excludes=excludes,
        attribute=attr.group(1).upper() if attr else None,
        resident_required=bool(RESIDENT_RE.search(body)),
        raw=" ".join(text.split()),
    )


def _blocks(lines: list[str]) -> list[tuple[str, str]]:
    """Split an audit into (display name, requirement text) pairs.

    Degree Works wraps BOTH the display name and the rule, and interleaves
    them, so a rule's text can continue several lines below its own heading
    with a fragment of that heading in between. Everything from one
    "Still needed:" up to the next heading-or-"Still needed:" is therefore
    taken as the rule; interleaved name fragments carry no course codes and
    fall out harmlessly in the regexes above.
    """
    out: list[tuple[str, str]] = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        if _STILL_NEEDED not in line:
            i += 1
            continue
        head, _, tail = line.partition(_STILL_NEEDED)
        parts = [tail.strip()]
        j = i + 1
        while j < n:
            nxt = lines[j].strip()
            if not nxt or _STILL_NEEDED in nxt or _HEADING_RE.match(nxt):
                break
            if _BLOCK_END_RE.search(nxt):
                break
            if any(nxt.startswith(s) for s in _STOP_LINES):
                break
            parts.append(nxt)
            j += 1
        out.append((head.strip(), " ".join(parts)))
        i = j
    return out


def parse_audit(text: str) -> list[tuple[str, RegistrarRequirement]]:
    """Every machine-checkable requirement in a Degree Works audit.

    Returns (display name, requirement). Prose-only requirements — a block
    whose "Still needed:" states no credits/classes, e.g. "**Completion of an
    emphasis area or an approved minor is required." — are DROPPED rather than
    emitted empty: a rule nothing can satisfy would read as an unmeetable
    requirement, and silence about a requirement we cannot express is safer
    than a false one. Callers wanting to know they exist should diff the count
    of "Still needed:" occurrences against the length of this list.
    """
    lines = [l.rstrip() for l in text.splitlines()]
    out: list[tuple[str, RegistrarRequirement]] = []
    for name, body in _blocks(lines):
        req = parse_requirement(body)
        if req is not None and not req.is_empty():
            out.append((name, req))
    return out
