# `core/` — the catalog builder

This is the only Python in the repository, and **no request ever runs it**. It
builds `core/db/catalog.db` from Clemson's published online catalog; the
TypeScript servers then read that database in-process. A serving host needs
Node, SQLite, and a built database — not an interpreter.

The package is named `gc_advisor` and the database keeps that name. It began as
a Graphic Communications advising project and now covers seven College of
Business programs plus minors and certificates. The name is historical; nothing
in here is about the human advisors who use the system.

---

## Build time vs. request time

|                             | Build time (this package)                                         | Request time (the servers) |
| --------------------------- | ----------------------------------------------------------------- | -------------------------- |
| Runs                        | About once a year, by hand                                        | Per MCP call               |
| Needs network               | Yes — `catalog.clemson.edu`                                       | No                         |
| Needs Playwright + Chromium | Yes — the catalog is a JavaScript application                     | No                         |
| Needs an LLM endpoint       | Yes — minor and certificate requirements are extracted by a model | No                         |
| Writes                      | `core/db/catalog.db`, and refreshes `core/data/raw`            | Nothing                    |

One consequence worth stating for a reviewer: **there is no code path from an
MCP request into this package.** The tool that used to shell into it
(`audit-gc-progress`) was removed on 2026-08-28.

---

## Layout

```
src/gc_advisor/
  ingest/         the scraper and parsers — discovery, rendering, course pages,
                  program pages, gen-ed, corequisites, the LLM extractor
  db/             schema.sql, connection, and the read layer the audit uses
  audit/          the degree-audit engine (see "Not exposed over MCP" below)
  models.py       the shared record shapes
scripts/          one entry point per operation; rebuild_db.sh is the operator's
                  one-command path. `_capture_*.py` freeze test fixtures.
packs/            per-program overlay rules applied by apply_pack.py:
                  accounting, economics, gc, management, marketing,
                  reach-act, social-science
skills/           gc-advisor and gc-curriculum-lookup — Markdown documents the
                  CATALOG SERVER serves to clients over MCP. They live beside
                  the data they describe rather than being copied into src/.
catalogs.toml     catalog year label -> the catalog system's internal id
data/raw/         the page corpus (below)
db/               the built database. Not in git.
tests/            55 files; pytest
```

## The corpus in `data/raw` (committed, ~5.4 MB of text)

It travels with the code so this repository can rebuild its own database instead
of depending on a machine that already has one.

- **`courses/`** — 4,085 frozen course-detail pages.
- **`<year>/`** — nine catalog years of program pages, `<id>.txt`.
- **`_llm-cache/`** — 326 model extractions, **keyed on page content**: the
  cache hits only while a page is unchanged. This is why a rebuild is minutes
  rather than hours, and also why a rebuild still needs an LLM endpoint — a page
  Clemson edited misses the cache, and a changed page is precisely what you are
  rebuilding for.
- **`<year>/<id>.llm.json`** — 961 per-year copies of extraction output, kept
  as provenance beside the page they came from and used as a fallback seed when
  a content-keyed lookup misses. They duplicate cache entries on purpose: it is
  a few hundred KB, and it is what lets a page whose extraction was redacted
  during the repository extraction rebuild without a model call.

Nothing in the corpus is confidential — every byte of it is a public Clemson
catalog page. A rebuild refreshes these files in the working tree, so
`rebuild_db.sh` will leave tracked data modified; review that diff and commit it
as a data refresh, or discard it.

## Not exposed over MCP: `audit/`

The degree-audit engine is whole and working — `scripts/audit.py` runs it
against the built database and returns a full `gc-audit-v1` result (requirement
items, gen-ed progress, credits remaining, prereq-eligible next courses), and 38
tests cover it including golden fixtures. What was removed on 2026-08-28 is the
MCP tool that wrapped it, so no _request_ can reach it; the CLI still can.

```bash
echo '{"version":"gc-progress-v1","catalog_year":"2026-2027","program":"Graphic Communications, BS","passed":[]}' \
  | .venv/bin/python scripts/audit.py --db db/catalog.db
```

The `version` field is required; without it the CLI exits 2 with a JSON error
envelope rather than guessing at the payload's shape.

## What was deliberately withheld

`core/docs` is not in this repository. It held DegreeWorks-derived material —
student-record derivatives — and the extraction audit blocks it. Some test
docstrings and the fixture headers under `tests/fixtures/registrar/` still point
at those filenames; the fixtures themselves carry only the transcribed
requirement rule, which is public catalog policy, and never a student's data.

---

## Running it

```bash
python3 -m venv core/.venv && core/.venv/bin/pip install -e "core[dev]"
core/.venv/bin/python -m playwright install chromium
core/scripts/rebuild_db.sh          # network + LLM endpoint required
```

Tests, from the repository root:

```bash
npm run core:test        # core/.venv/bin/python -m pytest core/tests -q -rs -m "not integration"
```

With a built database present this reports **361 passed, 0 skipped**. Without
one, about twenty tests skip — they are the ones that read the real catalog, and
they are marked `skipif`, so a fresh clone reports a large skip count rather
than failures. As everywhere in this repository, the count is the gate, not the
colour. Tests marked `integration` hit the live catalog or a real browser and
are deselected by default.

`core/db/schema.sql` is the authority on the database shape; the TypeScript
readers are checked against this package for every program and catalog year by
`test/catalog-read-differential.test.ts`, which is what makes it an independent
oracle rather than a second opinion from the same author.
