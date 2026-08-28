---
name: gc-curriculum-lookup
description: Use when answering questions about the Clemson Graphic Communications BS curriculum — course requirements, the semester-by-semester degree plan, credit totals, gen-ed options, footnote rules, or what a requirement slot allows — for a specific catalog year. The authoritative, catalog-year-pinned data source other GC advising skills build on.
---

# GC Curriculum Lookup

Answer GC curriculum questions from the local catalog database — never from
memory or the live website. All data is pinned per catalog year.

## How to query

Run the query CLI from the project root (its JSON output is your source of truth):

- List supported catalog years:
  `.venv/bin/python scripts/query.py years`
- Get a program's full degree plan (default name is the GC BS):
  `.venv/bin/python scripts/query.py program-plan --year 2026-2027`
  Pass `--name "..."` for any other program (e.g. `"Marketing, BS"` or a minor).
  The output includes `source_url` — the exact Clemson catalog page for that program.
- Look up a single course:
  `.venv/bin/python scripts/query.py course --code "GC 1020"`

## Rules

- Always resolve the student's **catalog year** first. If unknown, ask. If the
  year is not in `years` output, say so and list what is available — never guess.
- Credits and requirements come from `program-plan` (catalog-year-pinned), not
  from `course` (which holds current values only).
- Quote footnote text verbatim when a rule depends on it (e.g. the Specialty
  Area or advancement policy).
- For choice items (`one_of`) present all options; for `slot` items, state the
  slot type and credits and consult the relevant footnote for allowed courses.
- **Cite the source page.** Include the `program-plan` `source_url` when you state
  a program's requirements so the reader can follow the link and verify. It works
  for any `--name`, including a minor or certificate (returns `source_url` even
  though minors have no semester plan).
