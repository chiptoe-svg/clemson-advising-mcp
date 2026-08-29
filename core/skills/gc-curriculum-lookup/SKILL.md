---
name: gc-curriculum-lookup
description: Use when answering questions about the Clemson Graphic Communications BS curriculum — course requirements, the semester-by-semester degree plan, credit totals, gen-ed options, footnote rules, or what a requirement slot allows — for a specific catalog year. The authoritative, catalog-year-pinned data source other GC advising skills build on.
---

# GC Curriculum Lookup

Answer GC curriculum questions from the local catalog database — never from
memory or the live website. All data is pinned per catalog year.

## How to query

Use the catalog tools (their JSON output is your source of truth):

- List supported catalog years: `list-gc-catalog-years`
- List the programs the catalog holds: `list-gc-programs`
- Get a program's full degree plan: `get-gc-program-plan { program, catalog_year }`
  — `program` is the registrar's name, e.g. `"Graphic Communications, BS"` or
  `"Marketing, BS"` or a minor. The output includes `source_url`, the exact
  Clemson catalog page for that program.
- Look up a single course: `get-gc-course { code: "GC 1020" }`

## Rules

- Always resolve the student's **catalog year** first. If unknown, ask. If the
  year is not in the `list-gc-catalog-years` output, say so and list what is
  available — never guess.
- Credits and requirements come from `get-gc-program-plan` (catalog-year-pinned),
  not from `get-gc-course` (which holds current values only).
- Quote footnote text verbatim when a rule depends on it (e.g. the Specialty
  Area or advancement policy).
- For choice items (`one_of`) present all options; for `slot` items, state the
  slot type and credits and consult the relevant footnote for allowed courses.
- **Cite the source page.** Include the plan's `source_url` when you state a
  program's requirements so the reader can follow the link and verify. It works
  for any program, including a minor or certificate (returns `source_url` even
  though minors have no semester plan).
