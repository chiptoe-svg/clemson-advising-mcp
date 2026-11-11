"""Compare the HTML reader with the text parser for one program page.

Used by scripts/compare_program_readers.py and scripts/retro_program_readers.py
(docs/superpowers/specs/2026-11-11-catalog-html-reader-design.md). Items are
matched within a term by what they are: a course by its code, a slot by its
name, a choice by its options. A difference the text parser makes on purpose
(the REACH / Social Science layout-artifact split) carries a label, so it
neither hides a real finding nor clutters the rest. catalog.db is only read.
"""
import re
import sqlite3
from collections import Counter
from dataclasses import dataclass

from gc_advisor.ingest.parse_program import _choice_is_layout_artifact
from gc_advisor.ingest.parse_program_html import HtmlReading, read_program_html
from gc_advisor.ingest.pre_business import DESCRIPTION, PROGRAM_NAME
from gc_advisor.models import ParsedItem, ParsedProgram

LAYOUT_ARTIFACT = "layout artifact"
# Catalog years older than this have all graduated (Chip, 2026-11-11), so no
# capture is worth making for them. Move it forward as classes graduate.
OLDEST_CURRENT_YEAR = "2021-2022"


@dataclass
class ItemDiff:
    group: str
    kind: str  # "only_text" | "only_html" | "changed"
    text_item: ParsedItem | None
    html_item: ParsedItem | None
    label: str | None = None


def _key(it: ParsedItem) -> tuple:
    if it.kind == "fixed_course":
        return ("fixed_course", it.course_code)
    if it.kind == "slot":
        return ("slot", it.slot_type)
    return ("choice", tuple(sorted(it.one_of)), it.slot_type)


def _artifact_codes(items: list[ParsedItem]) -> set[str]:
    return {
        c
        for it in items
        if it.kind == "choice" and _choice_is_layout_artifact(it.slot_type or "")
        for c in it.one_of
    }


def diff_programs(text_prog: ParsedProgram, html_prog: ParsedProgram) -> list[ItemDiff]:
    """Item differences, term by term, in page order."""
    t_groups = {g.label: g.items for g in text_prog.groups}
    h_groups = {g.label: g.items for g in html_prog.groups}
    labels = [g.label for g in text_prog.groups] + [
        g.label for g in html_prog.groups if g.label not in t_groups
    ]
    out: list[ItemDiff] = []
    for label in labels:
        t_items, h_items = t_groups.get(label, []), h_groups.get(label, [])
        artifact = _artifact_codes(t_items) | _artifact_codes(h_items)

        def tag(it: ParsedItem) -> str | None:
            if _choice_is_layout_artifact(it.slot_type or "") or it.course_code in artifact:
                return LAYOUT_ARTIFACT
            return None

        h_left = list(h_items)
        for t in t_items:
            match = next((h for h in h_left if _key(h) == _key(t)), None)
            if match is None:
                out.append(ItemDiff(label, "only_text", t, None, tag(t)))
                continue
            h_left.remove(match)
            if (t.credits, sorted(t.footnote_refs)) != (match.credits, sorted(match.footnote_refs)):
                out.append(ItemDiff(label, "changed", t, match, tag(t) or tag(match)))
        for h in h_left:
            out.append(ItemDiff(label, "only_html", None, h, tag(h)))
    return out


def credit_checks(prog: ParsedProgram) -> list[str]:
    """A line per term whose items do not add up to its printed "Credit
    Hours", and one if the terms do not add up to "Total Credits"."""
    lines = []
    for g in prog.groups:
        if g.credit_total is None:
            continue
        got = sum(it.credits or 0 for it in g.items)
        unknown = sum(1 for it in g.items if it.credits is None)
        if got != g.credit_total:
            extra = f" ({unknown} item(s) without credits)" if unknown else ""
            lines.append(f"{g.label}: items add up to {got}, page prints {g.credit_total}{extra}")
    if prog.total_credits is not None:
        terms = sum(g.credit_total or 0 for g in prog.groups)
        if terms != prog.total_credits:
            lines.append(f"terms add up to {terms}, page prints Total Credits {prog.total_credits}")
    return lines


def registrar_lines(db_path, program_name: str, year: str, codes: list[str]) -> list[str]:
    """The registrar's rules (imported from Degree Works audits) for this
    program-year that mention any of `codes`. Opened read-only."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT r.display_name, r.need, r.unit, r.rule FROM registrar_requirement r "
            "JOIN program p ON p.id = r.program_id "
            "JOIN catalog_year cy ON cy.id = p.catalog_year_id "
            "WHERE p.name = ? AND cy.label = ? ORDER BY r.ordering",
            (program_name, year),
        ).fetchall()
    finally:
        con.close()
    return [
        f"{name}: {need} {unit} in {rule}"
        for name, need, unit, rule in rows
        if any(c in rule for c in codes)
    ]


_ADDITIONAL = re.compile(r"<h[1-6][^>]*>(?:(?!</h[1-6]).)*Additional Curriculum", re.S)


def pre_business_html(marketing_html: str) -> HtmlReading:
    """Pre-Business, read from a business major's page before its
    "Additional Curriculum" heading, as parse_pre_business does from text."""
    m = _ADDITIONAL.search(marketing_html)
    r = read_program_html(marketing_html[: m.start()] if m else marketing_html, "pre_business")
    r.program.name = PROGRAM_NAME
    r.program.description = DESCRIPTION
    return r


@dataclass
class Capture:
    """A Degree Works audit worth exporting for one program-year.
    Priority 1: something on the page or between the readers is in doubt.
    Priority 2: nothing is in doubt, but no audit is on file."""

    priority: int
    program: str
    year: str
    where: str
    detail: str
    settles: str


def _has_registrar_rules(db_path, program_name: str, year: str) -> bool:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return con.execute(
            "SELECT 1 FROM registrar_requirement r JOIN program p ON p.id = r.program_id "
            "JOIN catalog_year cy ON cy.id = p.catalog_year_id "
            "WHERE p.name = ? AND cy.label = ? LIMIT 1",
            (program_name, year),
        ).fetchone() is not None
    finally:
        con.close()


def _describe(it: ParsedItem | None) -> str:
    if it is None:
        return "nothing"
    if it.kind == "fixed_course":
        return it.course_code
    if it.kind == "slot":
        return f"slot {it.slot_type!r}"
    return " or ".join(it.one_of + ([f"slot {it.slot_type!r}"] if it.slot_type else []))


def captures_for(db_path, program_name: str, year: str,
                 diffs: list[ItemDiff], html_prog: ParsedProgram) -> list[Capture]:
    """The captures one program-year needs: each term where the readers
    disagree for no known reason and the registrar's rules name none of the
    courses; each printed total the page's own items do not reach; and, if
    neither applies, a program-year with no audit on file. None for a year
    older than OLDEST_CURRENT_YEAR."""
    if year < OLDEST_CURRENT_YEAR:
        return []
    out: list[Capture] = []
    open_groups: dict[str, list[ItemDiff]] = {}
    for d in diffs:
        if d.label is None:
            open_groups.setdefault(d.group, []).append(d)
    for group, ds in open_groups.items():
        codes = sorted({c for d in ds for it in (d.text_item, d.html_item) if it
                        for c in ([it.course_code] if it.course_code else it.one_of)})
        if codes and registrar_lines(db_path, program_name, year, codes):
            continue
        out.append(Capture(
            1, program_name, year, group,
            "; ".join(f"text reads {_describe(d.text_item)}, HTML reads {_describe(d.html_item)}" for d in ds),
            f"which reading Degree Works counts for {', '.join(codes) or 'this term'}",
        ))
    for line in credit_checks(html_prog):
        where, _, what = line.partition(": ") if ": " in line else ("credit totals", "", line)
        out.append(Capture(
            1, program_name, year, where, what or line,
            "the degree's real credit total" if where == "credit totals"
            else "which courses Degree Works requires here (the printed term total is the catalog's own)",
        ))
    if out and not _has_registrar_rules(db_path, program_name, year):
        for c in out:
            c.detail += " (no registrar audit on file for this year)"
    # Pre-Business has no audit of its own: its rules come with the audits of
    # the business majors that start students in it.
    elif not out and program_name != PROGRAM_NAME and not _has_registrar_rules(db_path, program_name, year):
        out.append(Capture(
            2, program_name, year, "whole program", "no registrar audit on file",
            "the registrar's rules; today this program-year's rules come from the catalog alone",
        ))
    return out
