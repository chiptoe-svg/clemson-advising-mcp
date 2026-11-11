"""Read a catalog program page from its HTML structure.

The text parser (parse_program.py) rebuilds a plan from flattened text, and
most of it is repairs for line shapes: an "or" at the end of a line, a slot
name its regex did not expect, a choice leaking across a term. The page's
HTML carries that structure directly: each term is an `acalog-core` block
under a year heading, each course is an `li.acalog-course` whose link holds
Acalog's course id, each slot an `li.acalog-adhoc-list-item`, and an "or" or
"and" is either an `<em>` at the end of a course item or a list item of its
own. This reader is built to run BESIDE the text parser and be compared with
it (docs/superpowers/specs/2026-11-11-catalog-html-reader-design.md); it
does not feed catalog.db.

It reports what the page prints. It does NOT apply the text parser's repair
for the REACH / Social Science "layout artifacts"; the comparison report
labels that difference. Where it does reuse a text-parser decision, it says
so in `carried`: an "(A and B) or (C and D)" block is read position-wise, as
Degree Works reads it (the model cannot hold a pair), and a bare course code
printed in an ad-hoc cell is read as that course. Every list item is either
read or listed in `unread`; nothing is dropped.
"""
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

from gc_advisor.ingest.parse_program import (
    TERMS,
    YEARS,
    _canonicalize_slot_names,
    _fn_refs,
    _infer_missing_credits,
)
from gc_advisor.models import Footnote, ParsedGroup, ParsedItem, ParsedProgram


@dataclass(frozen=True)
class UnreadItem:
    group: str | None
    text: str


@dataclass
class HtmlReading:
    program: ParsedProgram
    unread: list[UnreadItem] = field(default_factory=list)
    course_ids: dict[str, int] = field(default_factory=dict)
    carried: list[str] = field(default_factory=list)


_CODE_RE = re.compile(r"^([A-Z]{2,5})\s+(\d{4})\b")
_BARE_CODE_RE = re.compile(r"^([A-Z]{2,5})\s+(\d{4})$")
_CREDITS_RE = re.compile(r"(\d+)\s+Credits?\b")
_SLOT_RE = re.compile(r"^(.+?)\s+(\d+)\s+Credits?$")
_TEXT_COURSE_RE = re.compile(r"^([A-Z]{2,5})\s+(\d{4})\s+-\s+.+?\s+(\d+)\s+Credits?$")
_COID_RE = re.compile(r"showCourse\(\s*'\d+'\s*,\s*'(\d+)'")
_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
_TEXT_FOOTNOTE_RE = re.compile(r"^(\d+)\*?\s+(.*)$")
_TOTAL_RE = re.compile(r"^Total Credits:\s*(\d+)")
_HOURS_RE = re.compile(r"^Credit Hours:\s*(\d+)")


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


@dataclass
class _Tok:
    kind: str  # "h" | "li" | "p"
    text: str = ""
    sup: str = ""
    classes: tuple[str, ...] = ()
    coid: int | None = None
    ems: list[str] = field(default_factory=list)


class _Tokenizer(HTMLParser):
    """Headings, list items and paragraphs, in document order. Text inside a
    <sup> goes to `sup` (footnote marks); text hidden with display:none is
    skipped; a <p> inside a list item belongs to the item."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.toks: list[_Tok] = []
        self.open: list[tuple[str, _Tok]] = []  # (tag, token) being captured
        self.sup = 0
        self.em: list[list[str]] = []
        self.hidden: list[str] = []

    def _cur(self) -> _Tok | None:
        return self.open[-1][1] if self.open else None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if self.hidden:
            # A void tag (<br>) never closes: pushing it would swallow the
            # hidden element's own end tag and hide what follows.
            if tag not in _VOID:
                self.hidden.append(tag)
            return
        if "display: none" in (a.get("style") or ""):
            self.hidden.append(tag)
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.open.append((tag, _Tok("h")))
        elif tag == "li":
            self.open.append((tag, _Tok("li", classes=tuple((a.get("class") or "").split()))))
        elif tag == "p" and not any(t == "li" for t, _ in self.open):
            self.open.append((tag, _Tok("p")))
        elif tag == "sup":
            self.sup += 1
        elif tag == "em":
            self.em.append([])
        elif tag == "a":
            cur = self._cur()
            m = _COID_RE.search(a.get("onclick") or "")
            if cur is not None and cur.kind == "li" and m and cur.coid is None:
                cur.coid = int(m.group(1))
        elif tag == "br":
            # Footnotes share a paragraph, split by <br> (Packaging Science
            # 2024-25: "...<br> <sup>6</sup> PHYS 1220 and ..."): a line break
            # in a paragraph starts a new one.
            if self.open and self.open[-1][0] == "p":
                _, tok = self.open.pop()
                tok.text, tok.sup = _clean(tok.text), _clean(tok.sup)
                self.toks.append(tok)
                self.open.append(("p", _Tok("p")))
            else:
                self.handle_data(" ")

    def handle_endtag(self, tag):
        if self.hidden:
            self.hidden.pop()
            return
        if tag == "sup":
            self.sup = max(0, self.sup - 1)
        elif tag == "em" and self.em:
            text = _clean("".join(self.em.pop()))
            cur = self._cur()
            if cur is not None and text:
                cur.ems.append(text)
        elif self.open and self.open[-1][0] == tag:
            _, tok = self.open.pop()
            tok.text, tok.sup = _clean(tok.text), _clean(tok.sup)
            self.toks.append(tok)

    def handle_data(self, data):
        if self.hidden:
            return
        cur = self._cur()
        if cur is None:
            return
        if self.sup:
            cur.sup += " " + data
            return
        cur.text += data
        for e in self.em:
            e.append(data)


def read_program_html(html: str, kind: str, degree: str | None = None) -> HtmlReading:
    tz = _Tokenizer()
    tz.feed(html)
    tz.close()
    toks = tz.toks

    name = next((t.text for t in toks if t.kind == "h" and t.text), "")
    reading = HtmlReading(program=ParsedProgram(name=name, kind=kind, degree=degree))
    prog = reading.program

    in_reqs = False
    in_footnotes = False
    in_desc = False
    desc: list[str] = []
    cur_year: str | None = None
    cur_group: ParsedGroup | None = None
    units: list[_Tok] = []

    def flush_group():
        nonlocal cur_group, units
        if cur_group is not None:
            _build_items(cur_group, units, reading)
            if cur_group.items:
                _infer_missing_credits(cur_group)
                prog.groups.append(cur_group)
        cur_group, units = None, []

    for t in toks:
        if t.kind == "h":
            h = t.text
            if h == "Program Description":
                in_desc = True
                continue
            if in_desc and re.match(r"(Policy on|Program Requirements|Change of Major)", h):
                in_desc = False
            if h == "Footnotes":
                flush_group()
                in_footnotes = True
                continue
            is_section = h.endswith(" Curriculum") or any(h == f"{y} Year" for y in YEARS) or h in TERMS
            if in_footnotes:
                if not is_section:
                    continue
                # Curriculum resumes after a footnote block (pre-business, then
                # "Additional Curriculum"): the final block wins, as in the text
                # parser.
                in_footnotes = False
                prog.footnotes = []
            if h == "Program Requirements":
                in_reqs = True
                continue
            if not in_reqs:
                continue
            if m := _TOTAL_RE.match(h):
                flush_group()
                prog.total_credits = int(m.group(1))
            elif any(h == f"{y} Year" for y in YEARS):
                cur_year = h.split(" Year")[0]
            elif h.endswith(" Curriculum"):
                flush_group()
                cur_year = h[: -len(" Curriculum")].strip() or cur_year
            elif h in TERMS:
                flush_group()
                cur_group = ParsedGroup(label=f"{cur_year}/{h}", kind="term")
            elif (m := _HOURS_RE.match(h)) and cur_group is not None:
                cur_group.credit_total = int(m.group(1))
                flush_group()
            continue

        if in_desc and t.kind == "p" and t.text:
            desc.append(t.text)
            continue
        if in_footnotes:
            body = t.text
            num = re.match(r"(\d+)", t.sup) if t.kind == "p" else None
            plain = _TEXT_FOOTNOTE_RE.match(body) if t.kind == "p" and not t.sup else None
            if num and t.sup.split()[0].rstrip("*").isdigit():
                prog.footnotes.append(Footnote(number=int(num.group(1)), text=body))
            elif plain:
                # A footnote whose number is printed as text, not in <sup>
                # (Pre-Business 2023-25: "4* See South Carolina REACH Act…").
                prog.footnotes.append(Footnote(number=int(plain.group(1)), text=plain.group(2)))
            elif prog.footnotes and body:
                prog.footnotes[-1].text += " " + body
            continue
        if not in_reqs or t.kind != "li":
            continue
        if cur_group is None:
            if t.text:
                reading.unread.append(UnreadItem(None, t.text))
            continue
        units.append(t)

    flush_group()
    prog.description = "\n".join(desc)
    if not prog.groups:
        reading.unread = [UnreadItem(None, "no program structure found")]
        return reading
    _canonicalize_slot_names(prog)
    return reading


def _build_items(group: ParsedGroup, units: list[_Tok], reading: HtmlReading) -> None:
    """Turn one term's list items into ParsedItems. An "or" (an <em> ending a
    course item, or an item of its own) joins alternatives; an "and" chains
    courses inside one alternative."""
    # 1. Read each item; connectors become markers on the item before them.
    read: list[dict] = []
    for t in units:
        text = t.text
        if not text:
            continue
        if text in ("or", "and") and "acalog-course" not in t.classes:
            if read:
                read[-1]["joiner"] = text
            continue
        refs = _fn_refs(t.sup)
        if "acalog-course" in t.classes:
            m = _CODE_RE.match(text)
            cm = _CREDITS_RE.search(text)
            if not m:
                reading.unread.append(UnreadItem(group.label, text))
                continue
            code = f"{m.group(1)} {m.group(2)}"
            if t.coid is not None:
                reading.course_ids[code] = t.coid
            joiner = t.ems[-1] if t.ems and t.ems[-1] in ("or", "and") else None
            read.append({"course": code, "credits": int(cm.group(1)) if cm else None,
                         "refs": refs, "joiner": joiner})
        elif "acalog-adhoc-list-item" in t.classes or (
            # Some pages print a slot in a plain ad-hoc item (Economics BA
            # 2023-24: "Minor Requirement 3 Credits").
            "acalog-adhoc" in t.classes and _SLOT_RE.match(text)
        ):
            bare = _BARE_CODE_RE.match(text)
            sm = _SLOT_RE.match(text)
            if bare:
                code = f"{bare.group(1)} {bare.group(2)}"
                reading.carried.append(f"{group.label}: bare course code in an ad-hoc cell read as {code}")
                read.append({"course": code, "credits": None, "refs": refs, "joiner": None})
            elif sm:
                read.append({"slot": sm.group(1).strip(), "credits": int(sm.group(2)),
                             "refs": refs, "joiner": None})
            else:
                reading.unread.append(UnreadItem(group.label, text))
        elif m := _TEXT_COURSE_RE.match(text):
            # A course printed as plain text with no course link (Packaging
            # Science 2022-23 summer: "COOP 1010 - Cooperative Education 0
            # Credit" in a bare <li>): read from its text, as the text parser
            # does, and say so.
            code = f"{m.group(1)} {m.group(2)}"
            reading.carried.append(f"{group.label}: course printed as text without a link read as {code}")
            joiner = t.ems[-1] if t.ems and t.ems[-1] in ("or", "and") else None
            read.append({"course": code, "credits": int(m.group(3)), "refs": refs, "joiner": joiner})
        elif not t.classes and (sm := _SLOT_RE.match(text)):
            # A requirement cell typed as a plain <li> (Economics 2023-27):
            # read from its text, and say so.
            reading.carried.append(f"{group.label}: plain list item read from its text as slot {sm.group(1).strip()}")
            read.append({"slot": sm.group(1).strip(), "credits": int(sm.group(2)),
                         "refs": refs, "joiner": None})
        else:
            reading.unread.append(UnreadItem(group.label, text))

    # 2. Alternatives (lists of units chained by "and"), grouped by "or".
    chains: list[list[list[dict]]] = []
    alt: list[dict] = []
    chain: list[list[dict]] = []
    for u in read:
        alt.append(u)
        if u["joiner"] == "and" and "course" in u:
            continue
        chain.append(alt)
        alt = []
        if u["joiner"] == "or":
            continue
        chains.append(chain)
        chain = []
    if alt:
        chain.append(alt)
    if chain:
        chains.append(chain)

    # 3. Items.
    for chain in chains:
        if len(chain) == 1:
            for u in chain[0]:
                group.items.append(_single(u))
            continue
        if any(len(a) > 1 for a in chain):
            reading.carried.append(f"{group.label}: an and-pair choice read position-wise")
            for pos in range(max(len(a) for a in chain)):
                opts = [a[pos] for a in chain if pos < len(a)]
                group.items.append(_choice(opts) if len(opts) > 1 else _single(opts[0]))
            continue
        group.items.append(_choice([a[0] for a in chain]))


def _single(u: dict) -> ParsedItem:
    if "course" in u:
        return ParsedItem(kind="fixed_course", course_code=u["course"], credits=u["credits"],
                          footnote_refs=u["refs"])
    return ParsedItem(kind="slot", slot_type=u["slot"], credits=u["credits"], footnote_refs=u["refs"])


def _choice(opts: list[dict]) -> ParsedItem:
    courses = [o for o in opts if "course" in o]
    slots = [o for o in opts if "slot" in o]
    # The text parser gives a choice the credits of its last "or"-ended course.
    lead = [o for o in opts[:-1] if "course" in o] or courses or opts
    return ParsedItem(
        kind="choice",
        credits=lead[-1]["credits"],
        one_of=[o["course"] for o in courses],
        slot_type=slots[0]["slot"] if slots else None,
        footnote_refs=sorted({r for o in opts for r in o["refs"]}),
    )


def parse_program_html(html: str, kind: str, degree: str | None = None) -> ParsedProgram:
    """The program, or ValueError when any list item was not read: a page
    read in part must never be loaded as if whole."""
    r = read_program_html(html, kind, degree)
    if r.unread:
        raise ValueError(
            "program page not fully read: "
            + "; ".join(f"{u.group or '(outside a term)'}: {u.text}" for u in r.unread)
        )
    return r.program
