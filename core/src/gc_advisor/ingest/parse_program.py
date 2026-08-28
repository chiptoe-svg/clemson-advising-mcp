import re
from gc_advisor.models import ParsedProgram, ParsedGroup, ParsedItem, Footnote

YEARS = ("Freshman", "Sophomore", "Junior", "Senior")
TERMS = ("First Semester", "Second Semester", "Summer")

# Trailing footnote refs after "N Credits": bare "5", asterisked "1*", or
# comma-separated multiples "1*, 3*" / "5*,6*" (asterisk = a distinct footnote
# block, e.g. Marketing's pre-business block vs. its major block).
_FN_TRAILER = r"(?:\s+(\d[\d*,\s]*))?"

# Matches: SUBJ 1234 - Title text N Credit[s]  (optional trailing footnote refs)
COURSE_RE = re.compile(
    r"^([A-Z]{2,5})\s+(\d{4})\s+-\s+(.+?)\s+(\d+)\s+Credits?" + _FN_TRAILER + r"$"
)
# Matches slot/requirement lines: must NOT contain ' - ' (which marks a course line)
# Captures: slot description, credits, optional footnote refs
SLOT_RE = re.compile(
    r"^(.*?(?:Requirement|Elective))\s+(\d+)\s+Credits?" + _FN_TRAILER + r"$"
)


# Slot types whose plan cell the catalog's two-column page layout merges an
# adjacent fixed course into. The slot then parses as `kind='choice'` whose
# one_of is that neighbouring course rather than a real alternative, and
# `run_audit` satisfies a choice straight from its one_of — so the unrelated
# course wrongly satisfies the slot (wrong-`met`). Normalizing the choice back
# to a plain slot is what this tuple drives.
#
# Both entries are confirmed against DegreeWorks:
#   REACH          <- ACCT 2010. Registrar: "3 Credits in HIST 1010 or POSC 1010
#                     or 1030" (tests/fixtures/registrar/reach-act.txt), or an
#                     exemption. The page's own footnote 5* is the merge:
#                     "Students planning to major in Accounting or Financial
#                     Management should take ACCT 2010. All other students
#                     should select a course to fulfill the South Carolina
#                     REACH Act Requirement" — two different requirements
#                     sharing one printed cell, not one requirement with two
#                     options.
#   Social Science <- STAT 2300. Registrar files STAT 2300 under DEPARTMENTAL
#                     MATHEMATICS ("1 Class in MATH 1080 or 2070 or STAT 2300")
#                     and Social Sciences #2 under "3 Credits in ANTH 2010 or
#                     PSYC 2010 or SOC 2010". Separate requirements.
#
# NO TRADE IS MADE ANY MORE — both requirements are emitted. HISTORY, because
# the intermediate state is easy to re-invent: the first normalization DROPPED
# the merged course, on the belief that it always had another plan cell of its
# own. A full-catalog parse showed that was false in 9 of 13 cases, including
# both headline instances — Financial Management 2026-2027's ACCT 2010 (What-If:
# "Financial Accounting Concepts (3 Cr) Still needed: 1 Class in ACCT 2010") and
# Accounting 2025-2026's STAT 2300 (a DEPARTMENTAL MATHEMATICS requirement). So
# it traded a WRONG-`met` for a deleted requirement. The split below keeps the
# correction and loses nothing: the merged course becomes a requirement in its
# own right and the artifact slot goes to 0 credits, leaving group arithmetic at
# the printed totals (FM 2026-2027 still sums to its declared 120).
#
# FAIL-SAFE for a slot type NOT listed here. It is left alone: it keeps parsing
# as a choice, and any wrong-`met` it causes PERSISTS silently until someone
# adds it to this tuple. Absence from this list is therefore never evidence
# that a slot is clean — only that nobody has looked. New choice-kind slot
# types are worth auditing when they appear; the DB query that finds candidates
# is `SELECT DISTINCT slot_type FROM plan_item WHERE kind='choice' AND
# slot_type IS NOT NULL`.
#
# Adding a marker here silently rewrites plans, so verify a candidate against
# DegreeWorks first and check the contains-match cannot reach an unrelated slot
# (when `Social Science` was added, `Social Science Requirement` was the ONLY
# distinct choice-kind slot_type in the whole DB).
#
# NOTE for anyone adding a family: a 0-credit slot must still REQUIRE a course.
# `engine.run_audit`'s gen-ed branch once read `earned >= slot_need`, which for
# a 0-credit slot is `0 >= 0` — met for a student who has taken nothing. Both
# the rule path and the gen-ed path now read a falsy need as "any one matching
# course satisfies".
#
# DO NOT use this tuple to collapse repeated cells. A pass that kept only the
# first slot per family was tried and REVERTED: on a full-catalog parse exactly
# two program-years print an artifact slot twice for genuinely DISTINCT
# requirements — Financial Management 2026-2027 (freshman cell plus a
# standalone senior cell; parsed credits fell 120 -> 117 against a declared
# "Total Credits: 120") and Accounting 2025-2026 (footnote 3 has students take
# BOTH cells in either order; 114 -> 111). Deleting a requirement row tells a
# student they can graduate when they cannot, which is the one error direction
# never worth trading for. Guarded by
# tests/test_layout_artifact_slots.py::test_fm_2627_keeps_both_reach_cells_*
# and ::test_accounting_2526_keeps_both_social_science_cells.
CHOICE_LAYOUT_ARTIFACT_SLOTS = ("REACH", "Social Science")


def _choice_is_layout_artifact(slot_type: str) -> bool:
    """True when a course-or-slot 'choice' for this slot_type is a two-column
    layout merge rather than a real alternative, and must normalize to a plain
    slot. Substring match: catalog slot names vary in wording around the
    marker."""
    return any(m in (slot_type or "") for m in CHOICE_LAYOUT_ARTIFACT_SLOTS)


def _fn_refs(trailer: str | None) -> list[int]:
    """Footnote numbers from a trailer like '1*, 3*' -> [1, 3]; None/'' -> []."""
    return [int(n) for n in re.findall(r"\d+", trailer)] if trailer else []
TOTAL_RE = re.compile(r"^Total Credits:\s*(\d+)")
CREDITHOURS_RE = re.compile(r"^Credit Hours:\s*(\d+)")
FOOTNOTE_RE = re.compile(r"^\s*(\d+)\*?\s+(.*)$")  # allow "1* text" (pre-business footnotes)


def _name(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if (
            line
            and line not in ("a",)
            and "opens a new window" not in line
            and not line.startswith("Add to My Favorites")
            and "Print (" not in line
            and "Help (" not in line
            and not line.startswith("Return to:")
            and not line.startswith("[ARCHIVED CATALOG]")
        ):
            return line
    return ""


def parse_program(text: str, kind: str, degree: str | None = None) -> ParsedProgram:
    lines = [l.rstrip() for l in text.splitlines()]
    prog = ParsedProgram(name=_name(text), kind=kind, degree=degree)

    if "Program Description" in text:
        desc = text.split("Program Description", 1)[1]
        desc = re.split(r"\n(?:Policy on|Program Requirements|Change of Major)", desc, maxsplit=1)[0]
        prog.description = desc.strip()

    in_reqs = False
    cur_year: str | None = None
    cur_group: ParsedGroup | None = None
    in_footnotes = False
    footnotes_body_done = False
    pending_choice: list[str] = []
    pending_choice_credits: int | None = None
    pending_choice_fn: list[int] = []

    def flush_group() -> None:
        nonlocal cur_group
        if cur_group and cur_group.items:
            prog.groups.append(cur_group)
        cur_group = None

    def is_blank(s: str) -> bool:
        return s.strip() == ""

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # ── Footnotes section ──────────────────────────────────────────────
        if line == "Footnotes":
            flush_group()
            in_footnotes = True
            i += 1
            continue

        if in_footnotes:
            # Curriculum can resume after a footnote block (a shared pre-business
            # block, then "Additional Curriculum" + year headings). Exit footnote
            # mode and DROP the block just parsed: under the major-curriculum-only
            # scope the FINAL (major) footnote block wins, so an earlier block
            # with colliding numbers (pre-business "1*") is discarded here.
            if (
                line.endswith(" Curriculum")
                or any(line == f"{y} Year" for y in YEARS)
                or line in TERMS
            ):
                in_footnotes = False
                footnotes_body_done = False
                prog.footnotes = []
                # fall through to the normal heading handlers below (no continue)
            else:
                if "Return to:" in line:
                    footnotes_body_done = True
                m = FOOTNOTE_RE.match(lines[i])  # un-stripped to allow leading space
                if m and lines[i].lstrip()[0].isdigit():
                    prog.footnotes.append(
                        Footnote(number=int(m.group(1)), text=m.group(2).strip())
                    )
                elif (
                    not footnotes_body_done
                    and prog.footnotes
                    and line
                    and "Return to:" not in line
                    and "opens a new window" not in line
                ):
                    prog.footnotes[-1].text += " " + line
                i += 1
                continue

        # ── Program Requirements gate ──────────────────────────────────────
        if line == "Program Requirements":
            in_reqs = True
            i += 1
            continue
        if not in_reqs:
            i += 1
            continue

        # ── Total Credits ─────────────────────────────────────────────────
        tot = TOTAL_RE.match(line)
        if tot:
            flush_group()
            prog.total_credits = int(tot.group(1))
            i += 1
            continue

        # ── Year heading ──────────────────────────────────────────────────
        if any(line == f"{y} Year" for y in YEARS):
            cur_year = line.split(" Year")[0]
            i += 1
            continue

        # ── Curriculum section heading (e.g. "Pre-Business Freshman Curriculum",
        #    "Additional Curriculum") — sets the section/year context so terms
        #    that follow are labelled, and a bare "Additional Curriculum" that
        #    resumed the plan after a footnote block is consumed cleanly. ──
        if line.endswith(" Curriculum"):
            flush_group()
            cur_year = line[: -len(" Curriculum")].strip() or cur_year
            i += 1
            continue

        # ── Term heading ──────────────────────────────────────────────────
        if line in TERMS:
            flush_group()
            cur_group = ParsedGroup(label=f"{cur_year}/{line}", kind="term")
            i += 1
            continue

        # ── Credit Hours (end of term) ────────────────────────────────────
        ch = CREDITHOURS_RE.match(line)
        if ch and cur_group is not None:
            cur_group.credit_total = int(ch.group(1))
            flush_group()
            i += 1
            continue

        if cur_group is None:
            i += 1
            continue

        # ── Course line ───────────────────────────────────────────────────
        cm = COURSE_RE.match(line)
        if cm:
            code = f"{cm.group(1)} {cm.group(2)}"
            credits = int(cm.group(4))
            code_fn = _fn_refs(cm.group(5))

            # Look ahead past blanks for "or"
            j = i + 1
            while j < len(lines) and is_blank(lines[j]):
                j += 1

            if j < len(lines) and lines[j].strip() == "or":
                pending_choice.append(code)
                pending_choice_credits = credits
                pending_choice_fn.extend(code_fn)
                i = j + 1  # skip past "or"; next iteration picks up next course/blank
                continue

            if pending_choice:
                pending_choice.append(code)
                pending_choice_fn.extend(code_fn)
                cur_group.items.append(
                    ParsedItem(
                        kind="choice",
                        credits=pending_choice_credits,
                        one_of=list(pending_choice),
                        footnote_refs=sorted(set(pending_choice_fn)),
                    )
                )
                pending_choice = []
                pending_choice_credits = None
                pending_choice_fn = []
            else:
                cur_group.items.append(
                    ParsedItem(
                        kind="fixed_course",
                        course_code=code,
                        credits=credits,
                        footnote_refs=code_fn,
                    )
                )
            i += 1
            continue

        # ── Slot line ─────────────────────────────────────────────────────
        # Guard: skip if line contains ' - ' (would be a malformed course)
        if " - " not in line:
            sm = SLOT_RE.match(line)
            if sm:
                fn = _fn_refs(sm.group(3))
                slot_type = sm.group(1).strip()
                if pending_choice and not _choice_is_layout_artifact(slot_type):
                    # A course was pending an "or" and its alternative is a slot:
                    # represent as a choice — one_of course(s) OR the slot_type.
                    cur_group.items.append(
                        ParsedItem(
                            kind="choice",
                            credits=pending_choice_credits,
                            one_of=list(pending_choice),
                            slot_type=slot_type,
                            footnote_refs=sorted(set(pending_choice_fn) | set(fn)),
                        )
                    )
                    pending_choice = []
                    pending_choice_credits = None
                    pending_choice_fn = []
                elif pending_choice:
                    # Layout artifact, NOT a real alternative (see
                    # _choice_is_layout_artifact). The printed cell holds TWO
                    # requirements that the two-column layout collapsed into one
                    # row, so emit BOTH — never one, and never a choice between
                    # them:
                    #   1. the merged course, a requirement in its own right,
                    #      carrying the CELL'S credits. It is the cell's
                    #      arithmetic owner, so group totals stay at the
                    #      printed figures.
                    #   2. the artifact slot at ZERO credits. Its real credit
                    #      weight lives in the standalone block cell where the
                    #      page prints one (FM 2026-2027's senior REACH cell);
                    #      where it does not, a 0-credit rule means any one
                    #      registrar-listed course satisfies the slot, which is
                    #      the correct reading of a block the page never sized.
                    # Emitting them in page order (course then slot) keeps the
                    # plan reading like the printed grid.
                    cell_credits = pending_choice_credits or int(sm.group(2))
                    refs = sorted(set(pending_choice_fn) | set(fn))
                    if len(pending_choice) == 1:
                        cur_group.items.append(
                            ParsedItem(
                                kind="fixed_course",
                                course_code=pending_choice[0],
                                credits=cell_credits,
                                footnote_refs=refs,
                            )
                        )
                    else:
                        # Unobserved in the catalog to date (all 13 merged cells
                        # carry exactly one course). Preserve the alternatives
                        # rather than guessing which is required.
                        cur_group.items.append(
                            ParsedItem(
                                kind="choice",
                                credits=cell_credits,
                                one_of=list(pending_choice),
                                footnote_refs=refs,
                            )
                        )
                    cur_group.items.append(
                        ParsedItem(
                            kind="slot",
                            slot_type=slot_type,
                            credits=0,
                            footnote_refs=refs,
                        )
                    )
                    pending_choice = []
                    pending_choice_credits = None
                    pending_choice_fn = []
                else:
                    cur_group.items.append(
                        ParsedItem(
                            kind="slot",
                            slot_type=slot_type,
                            credits=int(sm.group(2)),
                            footnote_refs=fn,
                        )
                    )
                i += 1
                continue

        i += 1

    flush_group()
    return prog
