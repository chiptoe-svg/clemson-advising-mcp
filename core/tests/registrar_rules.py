"""Parse committed registrar rule text (tests/fixtures/registrar/*.txt).

The DegreeWorks audits these lines come from are gitignored record
derivatives, so pack-vs-registrar assertions used to hardcode the expected
subject lists in each pack test. That made the single most valuable property
of a pack — that it says what the registrar says — untestable anywhere but
the one machine holding those files, and undetectable if a pack silently
drifted. Committing ONLY the rule line (no student data, What-If sourced
where possible) puts the comparison back in the repo.

Format: `#` comment lines are ignored; every other line is joined with a
space into one rule string, which is then parsed with the regexes below.
DegreeWorks' own wrapping is preserved verbatim in the fixtures, so the join
is what reassembles a wrapped option list.
"""
import re
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures" / "registrar"

# "ACCT 3000:4999" / "@ 3000:4999" — a subject (or @ = any subject) plus an
# inclusive course-number range. This is DegreeWorks' notation for what our
# wildcard vocabulary calls dept_level_min / level_min.
RANGE_RE = re.compile(r"(@|[A-Z]{2,5})\s+(\d{4}):(\d{4})")
# "Except ECON 3990" — an exclusion carved out of a preceding range.
EXCEPT_RE = re.compile(r"\bExcept\s+([A-Z]{2,5})\s+(\d{4})\b")
# "HIST 1010 or POSC 1010 or 1030" — an explicit option set. DegreeWorks
# elides a repeated subject, so a bare number inherits the previous subject.
OPTION_RE = re.compile(r"\b([A-Z]{2,5})\s+(\d{4})\b|\bor\s+(\d{4})\b")


def rule_text(name: str) -> str:
    """The registrar rule text from tests/fixtures/registrar/<name>.txt, with
    comments stripped and DegreeWorks' line wrapping rejoined."""
    path = FIXTURES / f"{name}.txt"
    lines = [l.strip() for l in path.read_text().splitlines()]
    body = " ".join(l for l in lines if l and not l.startswith("#"))
    if not body:
        raise ValueError(f"{path}: no rule text (only comments?)")
    return body


def still_needed(name: str) -> str:
    """Just the part after `Still needed:` — the rule proper, without the
    requirement's display name and credit count."""
    text = rule_text(name)
    if "Still needed:" not in text:
        raise ValueError(f"{name}: no 'Still needed:' line in the fixture")
    return text.split("Still needed:", 1)[1].strip()


def subject_ranges(name: str) -> set[tuple[str, int]]:
    """{(subject, low)} for every `SUBJ low:high` range. `@` (any subject) is
    returned as the literal "@" — callers map it onto the level_min wildcard.
    The high bound is dropped: our vocabulary has no upper bound, which is
    itself a documented gap (level_min is unbounded above 4999)."""
    return {(m.group(1), int(m.group(2))) for m in RANGE_RE.finditer(still_needed(name))}


def subjects(name: str) -> set[str]:
    """Just the subject codes from the ranges, ignoring level."""
    return {s for s, _ in subject_ranges(name)}


def excluded_courses(name: str) -> set[str]:
    """{"ECON 3990"} for a rule carrying `Except ECON 3990`."""
    return {f"{s} {n}" for s, n in EXCEPT_RE.findall(still_needed(name))}


def course_options(name: str) -> list[str]:
    """Explicit option set, expanding DegreeWorks' elided subjects:
    `3 Credits in HIST 1010 or POSC 1010 or 1030`
      -> ["HIST 1010", "POSC 1010", "POSC 1030"]."""
    out, subject = [], None
    for subj, num, bare in OPTION_RE.findall(still_needed(name)):
        if subj:
            subject = subj
            out.append(f"{subj} {num}")
        elif subject:
            out.append(f"{subject} {bare}")
    return out
