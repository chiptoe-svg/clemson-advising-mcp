#!/usr/bin/env python3
"""Would reading the HTML have avoided the text parser's corrections?

    PYTHONPATH=src .venv/bin/python scripts/retro_program_readers.py \\
        --pages ../state/catalog-html

For each past parser fix, the parser as it was just before and just after the
fix is extracted from git (CUassistant read-only, `git archive`) and run in
its own subprocess on the SAVED text scrape of every page. What the fix
changed is then checked against the HTML reader's reading of the same page:
`avoided` (the HTML reader agrees with the final corrected reading on that
item, without the fix) or `not avoided`; items the REACH / Social Science
layout-artifact repair changed are `not a reading problem` (the page prints
them so). A
reading that reuses a text-parser decision is marked `carried`, so the
verdict is not circular. Only pages whose text today equals the saved scrape
are scored. Writes <pages>/retrospective.md; old trees go under
<pages>/retro/. Nothing is written to catalog.db or either repository.
"""
import argparse
import dataclasses
import io
import json
import os
import subprocess
import sys
import tarfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from gc_advisor.ingest.compare_programs import LAYOUT_ARTIFACT, _key, diff_programs, pre_business_html  # noqa: E402
from gc_advisor.ingest.parse_program import _choice_is_layout_artifact  # noqa: E402
from gc_advisor.ingest.parse_program_html import HtmlReading, read_program_html  # noqa: E402
from gc_advisor.models import Footnote, ParsedGroup, ParsedItem, ParsedProgram  # noqa: E402

CUASSISTANT = Path("/Users/admin/projects/CUassistant")
HERE = ROOT.parent

# (repo, prefix holding gc_advisor, before, after, what the fix was)
FIXES = [
    (CUASSISTANT, "src", "5dabf2e", "6fb27dc", "capture bare Elective slots and trim footnote boilerplate"),
    (CUASSISTANT, "src", "d2321bd", "0702224", "generalize the program parser for a 2nd major (Marketing)"),
    (CUASSISTANT, "src", "0702224", "43cba05", "Pre-Business program + parser fixes for that area"),
    (CUASSISTANT, "src", "138c61d", "47a27ee", "kill the STAT 2300 Social Science artifact and duplicate block slots"),
    (CUASSISTANT, "src", "47a27ee", "4b2a90a", "revert the artifact-slot dedupe (it deleted genuine requirements)"),
    (CUASSISTANT, "src", "4b2a90a", "1e54849", "emit BOTH requirements from a merged two-column cell"),
    (HERE, "core/src", "bcd3826", "1f70448", "stop parse_program dropping plan items in silence"),
    (HERE, "core/src", "1f70448", "cf0f3ea", "canonicalize the slot-name variant GENERIC_SLOT_RE creates"),
    (HERE, "core/src", "cf0f3ea", "47f762c", "ship the re-ingest: plan fixes"),
]


@dataclass
class Verdict:
    group: str
    change: str  # "added" | "removed" | "changed"
    item: str
    verdict: str  # "avoided" | "wrong item not produced" | "old parser did not read this term" | "not avoided" | "not a reading problem"
    carried: bool = False


def _show(it: ParsedItem) -> str:
    if it.kind == "fixed_course":
        s = it.course_code
    elif it.kind == "slot":
        s = f"slot {it.slot_type!r}"
    else:
        s = "choice " + " | ".join(it.one_of + ([f"slot {it.slot_type!r}"] if it.slot_type else []))
    return f"{s} ({it.credits} cr)"


def _carried(group: str, it: ParsedItem, notes: list[str]) -> bool:
    names = [it.course_code] if it.course_code else list(it.one_of)
    if it.slot_type:
        names.append(it.slot_type)
    for n in notes:
        if not n.startswith(f"{group}:"):
            continue
        if any(x and x in n for x in names) or (it.kind == "choice" and "and-pair" in n):
            return True
    return False


def score(before: ParsedProgram, after: ParsedProgram, html: HtmlReading,
          final: ParsedProgram) -> list[Verdict]:
    """A verdict for each item the fix changed: does the HTML reader agree
    with the FINAL corrected reading (today's parser) on that item? Judged
    against the final reading, not the fix's own output, because several
    fixes left output that later fixes corrected again."""
    h_items = {g.label: g.items for g in html.program.groups}
    f_items = {g.label: g.items for g in final.groups}
    b_terms = {g.label for g in before.groups}

    def state(items, key):
        return sorted((x.credits or 0, tuple(sorted(x.footnote_refs))) for x in items if _key(x) == key)

    out = []
    for d in diff_programs(before, after):
        it = d.html_item or d.text_item
        change = {"only_html": "added", "only_text": "removed"}.get(d.kind, "changed")
        key = _key(it)
        same = state(h_items.get(d.group, []), key) == state(f_items.get(d.group, []), key)
        printed_choice = any(
            h.kind == "choice" and _choice_is_layout_artifact(h.slot_type or "")
            and it.course_code in h.one_of
            for h in h_items.get(d.group, [])
        )
        in_final = bool(state(f_items.get(d.group, []), key))
        if d.label == LAYOUT_ARTIFACT or printed_choice:
            # The page itself prints these cells as a choice (REACH / Social
            # Science): the HTML reads them as printed, the fix corrects the
            # page. Not something a better reader would have avoided.
            v = "not a reading problem"
        elif d.group not in b_terms:
            # The old parser produced nothing for this term: the fix made
            # the page readable at all, item by item it is not a correction.
            v = "old parser did not read this term"
        elif same and not in_final:
            # A wrong item the fix removed, which the HTML never had: the
            # other half of a correction, counted apart, not twice.
            v = "wrong item not produced"
        else:
            v = "avoided" if same else "not avoided"
        out.append(Verdict(d.group, change, _show(it), v, _carried(d.group, it, html.carried)))
    return out


_RUNNER = r"""
import dataclasses, json, sys
jobs = json.load(sys.stdin)
out = {}
for j in jobs:
    try:
        text = open(j["path"], encoding="utf-8").read()
        if j["pre_business"]:
            from gc_advisor.ingest.pre_business import parse_pre_business
            prog = parse_pre_business(text)
        else:
            from gc_advisor.ingest.parse_program import parse_program
            prog = parse_program(text, j["kind"], j["degree"])
        out[j["key"]] = dataclasses.asdict(prog)
    except Exception as e:
        out[j["key"]] = f"{type(e).__name__}: {e}"
json.dump(out, sys.stdout)
"""


def _program(d: dict) -> ParsedProgram:
    def pick(cls, raw):
        names = {f.name for f in dataclasses.fields(cls)}
        return cls(**{k: v for k, v in raw.items() if k in names})
    p = pick(ParsedProgram, {k: v for k, v in d.items() if k not in ("groups", "footnotes")})
    p.groups = [
        dataclasses.replace(pick(ParsedGroup, {k: v for k, v in g.items() if k != "items"}),
                            items=[pick(ParsedItem, i) for i in g.get("items", [])])
        for g in d.get("groups", [])
    ]
    p.footnotes = [pick(Footnote, f) for f in d.get("footnotes", [])]
    return p


def run_parser(tree: Path, jobs: list[dict]) -> dict:
    """Run an old parser (its gc_advisor package under `tree`) in its own
    process. Each job's result is a ParsedProgram, or the error as text."""
    env = {**os.environ, "PYTHONPATH": str(tree)}
    proc = subprocess.run([sys.executable, "-c", _RUNNER], input=json.dumps(jobs),
                          capture_output=True, text=True, env=env, cwd=str(tree))
    if proc.returncode != 0:
        err = (proc.stderr.strip().splitlines() or ["failed"])[-1]
        return {j["key"]: f"parser process failed: {err}" for j in jobs}
    raw = json.loads(proc.stdout)
    return {k: (_program(v) if isinstance(v, dict) else v) for k, v in raw.items()}


def pages_to_score(pages_dir: Path, raw_dir: Path) -> tuple[list[dict], list[dict]]:
    """(pages whose text today equals the saved scrape, pages that changed)."""
    scored, changed = [], []
    for p in json.loads((pages_dir / "manifest.json").read_text()):
        fresh = (pages_dir / p["year"] / f"{p['poid']}.txt").read_text()
        saved = raw_dir / p["year"] / f"{p['poid']}.txt"
        (scored if saved.exists() and saved.read_text().strip() == fresh.strip() else changed).append(p)
    return scored, changed


def _extract(repo: Path, prefix: str, sha: str, dest: Path) -> Path:
    tree = dest / sha
    if not (tree / prefix / "gc_advisor").exists():
        blob = subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", sha, f"{prefix}/gc_advisor"],
                              capture_output=True, check=True).stdout
        tree.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(blob)) as t:
            t.extractall(tree, filter="data")
    return tree / prefix


def _packs_section() -> list[str]:
    out = ["\n## Correction packs (core/packs)\n"]
    for d in sorted((ROOT / "packs").iterdir()):
        log = subprocess.run(["git", "-C", str(HERE), "log", "--format=%h %ad %s", "--date=short", "--", f"core/packs/{d.name}"],
                             capture_output=True, text=True).stdout.strip().splitlines()
        label = ("see the report's layout-artifact group (REACH / Social Science)"
                 if d.name in ("reach-act", "social-science") else "not a reading problem (department policy)")
        out.append(f"- {d.name}: {label}; {len(log)} commit(s) here" + (f", latest {log[0]}" if log else ""))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pages", default=str(HERE / "state" / "catalog-html"))
    ap.add_argument("--raw", default=str(ROOT / "data" / "raw"))
    a = ap.parse_args()
    pages_dir, raw_dir = Path(a.pages), Path(a.raw)
    scored, changed = pages_to_score(pages_dir, raw_dir)

    jobs, readings, names = [], {}, {}
    for p in scored:
        key = f"{p['name']}|{p['year']}"
        html = (pages_dir / p["year"] / f"{p['poid']}.html").read_text()
        degree = p["name"].rsplit(", ", 1)[-1] if ", " in p["name"] else None
        path = str(raw_dir / p["year"] / f"{p['poid']}.txt")
        jobs.append({"key": key, "path": path, "kind": "major", "degree": degree, "pre_business": False})
        readings[key] = read_program_html(html, "major", degree)
        if p["name"] == "Marketing, BS":
            pkey = f"Pre-Business|{p['year']}"
            jobs.append({"key": pkey, "path": path, "kind": "pre_business", "degree": None, "pre_business": True})
            readings[pkey] = pre_business_html(html)

    final = run_parser(ROOT / "src", jobs)
    lines = ["# Retrospective: would the HTML reader have avoided the corrections?\n",
             f"Pages scored: {len(jobs)} program-years ({len(scored)} pages; text today equals the saved scrape). "
             f"Not scored (page changed since the scrape): {len(changed)}.\n"]
    totals = Counter()
    for repo, prefix, before_sha, after_sha, what in FIXES:
        before = run_parser(_extract(repo, prefix, before_sha, pages_dir / "retro"), jobs)
        after = run_parser(_extract(repo, prefix, after_sha, pages_dir / "retro"), jobs)
        counts, detail, failed = Counter(), [], []
        for j in jobs:
            b, f = before[j["key"]], after[j["key"]]
            if isinstance(b, str) or isinstance(f, str):
                failed.append(f"  - {j['key'].replace('|', ' ')}: {b if isinstance(b, str) else f}")
                continue
            for v in score(b, f, readings[j["key"]], final[j["key"]]):
                counts[v.verdict] += 1
                totals[v.verdict] += 1
                if v.carried:
                    counts["carried"] += 1
                detail.append(f"  - {j['key'].replace('|', ' ')}, {v.group}: {v.change} {v.item} — "
                              f"**{v.verdict}**{' (carried over)' if v.carried else ''}")
        lines.append(f"\n## {before_sha} → {after_sha}: {what}\n")
        lines.append("- " + (", ".join(f"{k} {n}" for k, n in counts.most_common()) or "the fix changed nothing on these pages"))
        lines += detail
        if failed:
            lines.append(f"- old parser failed on {len(failed)} page(s):")
            lines += failed
    lines.insert(2, "Totals over all fixes: " + (", ".join(f"{k} {n}" for k, n in totals.most_common()) or "none") + ".\n")
    lines += _packs_section()
    out = pages_dir / "retrospective.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(out, dict(totals))
    return 0


if __name__ == "__main__":
    sys.exit(main())
