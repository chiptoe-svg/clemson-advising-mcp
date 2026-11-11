#!/usr/bin/env python3
"""Compare the HTML reader with the text parser on every saved program page.

    PYTHONPATH=src .venv/bin/python scripts/compare_program_readers.py \\
        --pages ../state/catalog-html

Reads the pages saved by fetch_program_pages.py and writes <pages>/report.md:
a summary, then each program-year (Pre-Business read from the Marketing
page): whether today's text equals the original saved scrape, anything the
HTML reader could not read, item differences (labelled when a known
text-parser repair explains them), credit checks for both readers, the
registrar's rules for disputed courses, and finally the Degree Works captures
worth making (captures_for), most useful first. catalog.db is read only; nothing is written to it.
"""
import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from gc_advisor.ingest.compare_programs import (  # noqa: E402
    LAYOUT_ARTIFACT,
    captures_for,
    credit_checks,
    diff_programs,
    pre_business_html,
    registrar_lines,
)
from gc_advisor.ingest.parse_program import parse_program  # noqa: E402
from gc_advisor.ingest.parse_program_html import read_program_html  # noqa: E402
from gc_advisor.ingest.pre_business import parse_pre_business  # noqa: E402


def _item(it) -> str:
    if it is None:
        return "—"
    if it.kind == "fixed_course":
        s = it.course_code
    elif it.kind == "slot":
        s = f"slot {it.slot_type!r}"
    else:
        s = "choice " + " | ".join(it.one_of + ([f"slot {it.slot_type!r}"] if it.slot_type else []))
    return f"{s} ({it.credits} cr{', fn ' + ','.join(map(str, it.footnote_refs)) if it.footnote_refs else ''})"


def _codes(d) -> list[str]:
    out = []
    for it in (d.text_item, d.html_item):
        if it is not None:
            out += [it.course_code] if it.course_code else list(it.one_of)
    return sorted(set(out))


def compare_all(pages_dir: Path, db: Path, raw_dir: Path) -> tuple[str, dict]:
    manifest = json.loads((pages_dir / "manifest.json").read_text())
    rows = []
    for p in manifest:
        base = pages_dir / p["year"] / str(p["poid"])
        html, text = (base.with_suffix(".html")).read_text(), (base.with_suffix(".txt")).read_text()
        saved = raw_dir / p["year"] / f"{p['poid']}.txt"
        same = saved.exists() and saved.read_text().strip() == text.strip()
        degree = p["name"].rsplit(", ", 1)[-1] if ", " in p["name"] else None
        rows.append((p["name"], p["year"], same, parse_program(text, "major", degree),
                     read_program_html(html, "major", degree)))
        if p["name"] == "Marketing, BS":
            rows.append(("Pre-Business", p["year"], same, parse_pre_business(text),
                         pre_business_html(html)))

    stats = Counter()
    by_label = Counter()
    patterns: dict[tuple, list[str]] = defaultdict(list)
    captures = []
    body: list[str] = []
    for name, year, same, tprog, reading in rows:
        diffs = diff_programs(tprog, reading.program)
        unread = reading.unread
        if not reading.program.groups:
            stats["unreadable"] += 1
        elif diffs or unread:
            stats["differ"] += 1
        else:
            stats["match"] += 1
        body.append(f"\n## {name} — {year}\n")
        body.append(f"- Today's text {'equals' if same else 'DIFFERS FROM'} the original saved scrape.")
        if unread:
            body.append("- Not read by the HTML reader:")
            body += [f"  - {u.group or '(outside a term)'}: {u.text}" for u in unread]
        if reading.carried:
            body.append("- Text-parser decisions the HTML reader reused:")
            body += [f"  - {c}" for c in reading.carried]
        if not diffs and not unread:
            body.append("- **Match.**")
        for d in diffs:
            by_label[d.label or "unexplained"] += 1
            patterns[(name, d.group, d.kind, _item(d.text_item), _item(d.html_item))].append(year)
            body.append(f"- {d.kind} in {d.group}{f' [{d.label}]' if d.label else ''}: "
                        f"text {_item(d.text_item)} / html {_item(d.html_item)}")
        # Unexplained differences are judged per term, together: the two
        # halves of one difference (a slot only in the text, a choice only in
        # the HTML) share the courses that find the registrar's rule.
        open_groups: dict[str, list] = defaultdict(list)
        for d in diffs:
            if d.label is None:
                open_groups[d.group].append(d)
        for group, ds in open_groups.items():
            codes = sorted({c for d in ds for c in _codes(d)})
            reg = registrar_lines(db, name, year, codes) if codes else []
            if reg:
                body.append(f"- registrar, {group} ({', '.join(codes)}):")
                body += [f"  - {r}" for r in reg]
        captures += captures_for(db, name, year, diffs, reading.program)
        for who, prog in (("text", tprog), ("html", reading.program)):
            for line in credit_checks(prog):
                body.append(f"- credit check ({who}): {line}")

    head = [
        "# HTML reader vs text parser — comparison report\n",
        f"Program-years: {len(rows)}. Match: {stats['match']}. Differ: {stats['differ']}. "
        f"Unreadable: {stats['unreadable']}.\n",
        "Differences by cause: " + (", ".join(f"{k} {v}" for k, v in by_label.most_common()) or "none") + ".\n",
        "\n## Differences repeated across years\n",
    ]
    for (name, group, kind, t, h), years in sorted(patterns.items(), key=lambda kv: -len(kv[1])):
        if len(years) > 1:
            head.append(f"- {name}, {group}, {kind}: text {t} / html {h} — {len(years)} years ({', '.join(years)})")
    tail = ["\n## Degree Works captures worth making\n"]
    for priority, title in ((1, "Something is in doubt"), (2, "No audit on file")):
        rows_p = [c for c in captures if c.priority == priority]
        tail.append(f"\n### {priority}. {title} ({len(rows_p)})\n")
        tail += [f"- {c.program} {c.year}, {c.where}: {c.detail}. Would settle: {c.settles}."
                 for c in rows_p] or ["- None."]
    return "\n".join(head + body + tail) + "\n", dict(stats)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pages", default=str(ROOT.parent / "state" / "catalog-html"))
    ap.add_argument("--db", default=str(ROOT / "db" / "catalog.db"))
    ap.add_argument("--raw", default=str(ROOT / "data" / "raw"))
    a = ap.parse_args()
    report, stats = compare_all(Path(a.pages), Path(a.db), Path(a.raw))
    out = Path(a.pages) / "report.md"
    out.write_text(report, encoding="utf-8")
    print(out, stats)
    return 0


if __name__ == "__main__":
    sys.exit(main())
