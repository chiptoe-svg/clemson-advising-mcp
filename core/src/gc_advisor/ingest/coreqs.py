"""Lecture/lab corequisite backfill (spec 2026-07-25, widened university-wide).

Courses come in lecture/lab pairs: a graded lecture (e.g. GC 4060) and a
non-credit lab corequisite (GC 4061) taken the same term. The only machine-
readable link is prose in the lab's description ("Non-credit laboratory to
accompany GC 4060."). This derives the pair from that prose and writes
coreq_text/coreq_parsed BIDIRECTIONALLY on both rows, so the corequisite is a
single structured source of truth instead of every consumer re-parsing prose.

Scope: ALL subjects (validated 2026-07-25 — 506 pairs; every match is a real
0-credit/Laboratory course, every captured lecture resolves to a real course,
0 dangling refs). Multi-code clauses ("accompany BIOL 1220 or BIOL 1230",
"EES 3030 and EES 3040") yield every listed lecture. Descriptions that say
"accompany" without a following course code are correctly excluded.

Deterministic, idempotent, and rebuild-safe (run after courses are loaded). Does
NOT clobber an existing non-empty coreq (so a real catalog coreq always wins)."""
import json
import re
import sqlite3

# "accompany <CODE>" and multi-code continuations ("<CODE> or/and/,// <CODE>").
_ACCOMPANY_RE = re.compile(
    r"accompany\s+([A-Z]{2,5}\s*\d{3,4}"
    r"(?:\s*(?:,|/|\bor\b|\band\b)\s*[A-Z]{2,5}\s*\d{3,4})*)",
    re.I,
)
_CODE_RE = re.compile(r"[A-Z]{2,5}\s*\d{3,4}")
_SPLIT_RE = re.compile(r"([A-Z]{2,5})\s*(\d{3,4})")

_EMPTY = ("", "[]")


def _norm(code: str) -> str:
    """Normalize 'GC4060' / 'gc 4060' -> 'GC 4060'."""
    m = _SPLIT_RE.match(code.strip().upper())
    return f"{m.group(1)} {m.group(2)}" if m else code.strip().upper()


def derive_lab_pairs(con: sqlite3.Connection) -> dict[str, list[str]]:
    """Map each lab course code -> its lecture code(s), from lab descriptions.
    A multi-code accompany clause yields more than one lecture."""
    pairs: dict[str, list[str]] = {}
    for r in con.execute(
        "SELECT code, description FROM course WHERE description LIKE '%accompany%'"
    ):
        m = _ACCOMPANY_RE.search(r["description"] or "")
        if m:
            pairs[r["code"]] = [_norm(c) for c in _CODE_RE.findall(m.group(1))]
    return pairs


def backfill_coreqs(con: sqlite3.Connection) -> int:
    """Populate coreq_text/coreq_parsed bidirectionally for every lecture/lab
    pair derived from lab descriptions. Returns the number of course rows
    updated. Idempotent: a course whose coreq_parsed is already non-empty is
    left untouched (this also protects a real catalog coreq from being
    clobbered)."""
    pairs = derive_lab_pairs(con)

    # Undirected edges: lab <-> lecture (a lab may accompany more than one).
    edges: dict[str, set[str]] = {}
    for lab, lectures in pairs.items():
        for lecture in lectures:
            edges.setdefault(lab, set()).add(lecture)
            edges.setdefault(lecture, set()).add(lab)

    updated = 0
    for code, partners in edges.items():
        row = con.execute(
            "SELECT coreq_parsed FROM course WHERE code=?", (code,)
        ).fetchone()
        if row is None:
            continue  # partner course not in the catalog — nothing to write
        if row["coreq_parsed"] and row["coreq_parsed"] not in _EMPTY:
            continue  # already populated (real catalog coreq, or a prior run)
        codes = sorted(partners)
        con.execute(
            "UPDATE course SET coreq_parsed=?, coreq_text=? WHERE code=?",
            (json.dumps(codes), ", ".join(codes), code),
        )
        updated += 1
    con.commit()
    return updated
