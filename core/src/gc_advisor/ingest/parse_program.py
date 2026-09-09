import re
from gc_advisor.models import ParsedProgram, ParsedGroup, ParsedItem, Footnote

YEARS = ("Freshman", "Sophomore", "Junior", "Senior")
TERMS = ("First Semester", "Second Semester", "Summer")

# Trailing footnote refs after "N Credits": bare "5", asterisked "1*", or
# comma-separated multiples "1*, 3*" / "5*,6*" (asterisk = a distinct footnote
# block, e.g. Marketing's pre-business block vs. its major block).
_FN_TRAILER = r"(?:\s+(\d[\d*,\s]*))?"

# An "or" the page prints at the END of a course line instead of on a line of
# its own. Both forms appear, sometimes on the same page. Anchoring on `$`
# without this made every trailing-or line fail COURSE_RE and vanish, leaving
# only the LAST alternative — which then parsed as a REQUIRED course (GC
# 2021-2022 senior: "must take PSYC 3680" when MGT 3070 also satisfies it).
_OR_TRAILER = r"(\s+or)?"

# Matches: SUBJ 1234 - Title text N Credit[s]  (optional trailing footnote refs)
COURSE_RE = re.compile(
    r"^([A-Z]{2,5})\s+(\d{4})\s+-\s+(.+?)\s+(\d+)\s+Credits?"
    + _FN_TRAILER
    + _OR_TRAILER
    + r"$"
)
# A course line stripped of its title and credits — "PKSC 4050 2" (code plus
# footnote ref) as printed by Packaging Science 2024-2025. A page defect, but
# dropping the line loses a real requirement (DegreeWorks lists PKSC 4050 for
# that year), so parse it and let credit inference below restore the number.
# Deliberately strict: the WHOLE line must be a code plus optional footnote
# digits, so ordinary prose cannot reach it.
BARE_COURSE_RE = re.compile(r"^([A-Z]{2,5})\s+(\d{4})" + _FN_TRAILER + _OR_TRAILER + r"$")
# Matches slot/requirement lines: must NOT contain ' - ' (which marks a course line)
# Captures: slot description, credits, optional footnote refs
# "Req." because the page abbreviates ("Graphic Communication Technical Req.
# 6 Credits"), and six credits disappeared for want of four letters.
SLOT_RE = re.compile(
    r"^(.*?(?:Requirements?|Req\.|Electives?))\s+(\d+)\s+Credits?"
    + _FN_TRAILER
    + _OR_TRAILER
    + r"$"
)
# LAST-RESORT slot form: any non-course line inside a term that states credits.
# The named form above misses cells the page titles without either keyword —
# "South Carolina REACH Act 3 Credits" (Accounting 2026-2027, current year).
# Such a line used to match nothing and be skipped in silence, which also left
# a pending "or" dangling so it swept into the NEXT or-group and merged two
# distinct requirements into one choice. Inside a term group, a line that
# states credits and is not a course IS a requirement cell; reading it as one
# is the honest interpretation.
GENERIC_SLOT_RE = re.compile(
    r"^(.+?)\s+(\d+)\s+Credits?" + _FN_TRAILER + _OR_TRAILER + r"$"
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


# "(A and B) or (C and D)" — a choice between PAIRS, printed with the "and" at
# the end of the first line of each pair:
#
#     CH 2010 - Survey of Organic Chemistry 3 Credits and
#     CH 2020 - Survey of Organic Chemistry Laboratory 1 Credits
#     or
#     CH 2230 - Organic Chemistry 3 Credits and
#     CH 2270 - Organic Chemistry Laboratory 1 Credit
#
# The lecture lines end in "and", failed COURSE_RE, and were dropped — six
# credits gone from Packaging Science 2022-2023's sophomore fall alone, with
# the surviving lab lines left as a bogus 1-credit choice.
#
# THE REGISTRAR'S OWN MODEL is position-wise, not paired — DegreeWorks encodes
# the block above as two independent requirements, "1 Class in CH 2010 or 2230"
# and "1 Class in CH 2020 or 2270" — so that is what we emit. Doing it as a
# PRE-PASS over the lines, rewriting the block into the plain alternating form
# the main loop already handles correctly, keeps this out of the loop's
# carefully-tuned choice/slot interaction entirely.
_COURSE_HEAD_RE = re.compile(r"^([A-Z]{2,5})\s+(\d{4})\s+-\s+.+?\s+\d+\s+Credits?")
_AND_SUFFIX_RE = re.compile(r"^(.*)\s+and$")


def _split_and_suffix(line: str) -> tuple[str, bool]:
    """('CH 2010 - X 3 Credits and') -> ('CH 2010 - X 3 Credits', True)."""
    m = _AND_SUFFIX_RE.match(line.strip())
    return (m.group(1), True) if m else (line.strip(), False)


def _read_alternative(lines: list[str], i: int) -> tuple[list[str], int]:
    """One alternative: consecutive course lines chained by a trailing 'and'.
    Returns ([course lines without their 'and'], index after it)."""
    out: list[str] = []
    n = len(lines)
    while i < n:
        body, has_and = _split_and_suffix(lines[i])
        if not _COURSE_HEAD_RE.match(body):
            break
        out.append(body)
        i += 1
        if not has_and:
            break
        while i < n and lines[i].strip() == "":  # blanks inside a pair
            i += 1
    return out, i


def _regroup_and_pairs(lines: list[str]) -> list[str]:
    """Rewrite "(A and B) or (C and D)" blocks into position-wise or-groups.

    Only fires when an alternative actually contains an 'and' chain; a plain
    "X or Y" is left exactly as it was, so the main loop's existing behaviour
    (and every test guarding it) is untouched.
    """
    out: list[str] = []
    i, n = 0, len(lines)
    while i < n:
        alts: list[list[str]] = []
        j = i
        while True:
            alt, j2 = _read_alternative(lines, j)
            if not alt:
                break
            alts.append(alt)
            k = j2
            while k < n and lines[k].strip() == "":
                k += 1
            if k < n and lines[k].strip() == "or":
                k += 1
                while k < n and lines[k].strip() == "":
                    k += 1
                j = k
                continue
            j = j2
            break
        if len(alts) > 1 and any(len(a) > 1 for a in alts):
            for pos in range(max(len(a) for a in alts)):
                opts = [a[pos] for a in alts if pos < len(a)]
                for idx, opt in enumerate(opts):
                    out.append(opt)
                    if idx < len(opts) - 1:
                        out.extend(["", "or", ""])
                out.append("")
            i = j
            continue
        out.append(lines[i])
        i += 1
    return out


def _canonicalize_slot_names(prog) -> None:
    """Merge a bare slot name into the program's own "... Requirement" form.

    GENERIC_SLOT_RE reads a cell's name verbatim, so the Accounting page's
    "South Carolina REACH Act 3 Credits" cell arrives as "South Carolina REACH
    Act" while the SAME requirement appears elsewhere on the page as "South
    Carolina REACH Act Requirement". Two names for one requirement is not a
    cosmetic problem: requirement_rules are keyed by slot_type, so the variant
    split the footnote-to-slot mapping and DROPPED rules that had resolved
    before (Accounting 2026-2027 lost both its Business and REACH rules).

    Only fires on a genuine collision — a bare name is renamed only when this
    same program also carries that name plus " Requirement" — so a slot the
    page really does title without the word is left exactly as printed.
    """
    names = {
        it.slot_type
        for g in prog.groups
        for it in g.items
        if it.slot_type
    }
    rename = {n: f"{n} Requirement" for n in names if f"{n} Requirement" in names}
    # ALSO canonicalize a layout-artifact family when this program prints
    # ONLY the bare form. The page cell reads "South Carolina REACH Act";
    # Degree Works, the requirement packs and every other program call it
    # "South Carolina REACH Act Requirement" — and requirement_rule is keyed
    # by slot_type, so the bare name silently missed the reach-act pack and
    # the access layer served NO REACH rule for five 2025-2026 programs.
    # Caught by tests/test_reach_act.py before it reached anyone. Scoped to
    # the families _choice_is_layout_artifact already governs, so it cannot
    # rename a slot the page genuinely titles without the word.
    rename.update(
        {
            n: f"{n} Requirement"
            for n in names
            if _choice_is_layout_artifact(n) and not n.endswith("Requirement")
        }
    )
    if not rename:
        return
    for g in prog.groups:
        for it in g.items:
            if it.slot_type in rename:
                it.slot_type = rename[it.slot_type]


def _infer_missing_credits(group) -> None:
    """Restore the credits of a single item the page printed without them.

    ARITHMETIC, NOT GUESSWORK, and only in the one case where it is forced:
    the page states the term's total ("Credit Hours: 15") and every item but
    one carries printed credits, so the shortfall IS the missing item's value.
    With two or more unknowns the split is genuinely ambiguous — leave them
    None and let the credit invariant report the group instead of inventing a
    number. Never runs when the totals already agree.
    """
    if group.credit_total is None:
        return
    unknown = [i for i in group.items if i.credits is None]
    if len(unknown) != 1:
        return
    shortfall = group.credit_total - sum(i.credits or 0 for i in group.items)
    if shortfall > 0:
        unknown[0].credits = shortfall


def parse_program(text: str, kind: str, degree: str | None = None) -> ParsedProgram:
    lines = _regroup_and_pairs([l.rstrip() for l in text.splitlines()])
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
        nonlocal cur_group, pending_choice, pending_choice_credits, pending_choice_fn
        if cur_group and cur_group.items:
            _infer_missing_credits(cur_group)
            prog.groups.append(cur_group)
        cur_group = None
        # A choice left pending at a term boundary belongs to THIS term and must
        # never survive into the next one. Leaking it is what merged Accounting
        # 2026-2027's two separate or-groups into a single three-way choice.
        pending_choice = []
        pending_choice_credits = None
        pending_choice_fn = []

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

            # "or" printed at the end of THIS line (see _OR_TRAILER): identical
            # meaning to an "or" on the next line, so take the same branch.
            if cm.group(6):
                pending_choice.append(code)
                pending_choice_credits = credits
                pending_choice_fn.extend(code_fn)
                i += 1
                continue

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

        # ── Course line stripped of its title/credits ─────────────────────
        # Before the slot branch: "PKSC 4050 2" is a COURSE, not a requirement
        # cell, and must not be read as one.
        if " - " not in line:
            bm = BARE_COURSE_RE.match(line)
            if bm:
                cur_group.items.append(
                    ParsedItem(
                        kind="fixed_course",
                        course_code=f"{bm.group(1)} {bm.group(2)}",
                        credits=None,  # restored by _infer_missing_credits
                        footnote_refs=_fn_refs(bm.group(3)),
                    )
                )
                i += 1
                continue

        # ── Slot line ─────────────────────────────────────────────────────
        # Guard: skip if line contains ' - ' (would be a malformed course)
        if " - " not in line:
            sm = SLOT_RE.match(line) or GENERIC_SLOT_RE.match(line)
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
    _canonicalize_slot_names(prog)
    return prog
