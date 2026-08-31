# Overview: from Clemson's published data to an answer

This is the one document that follows the data end to end — where it comes
from, how it is collected, where it rests, and what each tool on the two MCP
servers does with it. It is the second thing to read after `security.md`.

Every tool description in Part 2 is the text the servers actually send to a
client. A test (`test/docs-tool-inventory.test.ts`) fails if a tool is added,
removed, or renamed without this page changing, so the inventory here cannot
drift from what is served.

---

## Part 1 — The data, source to answer

Two independent pipelines feed two independent servers. They never share a
process, and neither pipeline runs on a request.

```
 SOURCE (Clemson)              COLLECTION                        REST                       SERVING
 ───────────────               ──────────                        ────                       ───────
 Banner "Browse Classes"  ──▶  refresh job, daily 05:00     ──▶  state/clemson/<term>.db  ──▶  schedule server  (8766)
 regssb.sis.clemson.edu        scripts/clemson-refresh.ts        one SQLite file per term       11 tools
 public JSON endpoints         one sweep per live term           sections · meetings ·
                                                                 instructors · meta

 catalog.clemson.edu      ──▶  rebuild, about once a year   ──▶  core/db/catalog.db    ──▶  catalog server   (8767)
 (Acalog; a JS app)            core/scripts/rebuild_db.sh        one SQLite file                11 tools
                               Playwright render → parsers       programs · plans · rules ·
                               → LLM extraction (minors)         courses · gen-ed · footnotes

 CuSectionOverview report ──▶  exported by hand, once       ──▶  data/clemson-room-capacity.json  (read by both; not served today)
```

### 1a. The class schedule

**Source.** Banner's Student Registration Self-Service, at
`regssb.sis.clemson.edu/StudentRegistrationSsb/ssb` — the same public,
unauthenticated JSON endpoints the "Browse Classes" web page calls
(`classSearch/getTerms`, `term/search`, `searchResults/searchResults`, and the
per-section detail endpoints). No login, no student data.

**Collection.** `npm run clemson:refresh`, installed as a launchd job at 05:00
daily. It asks Banner for its term list, keeps every term Banner does not label
"View Only" plus any future term numbered above them (so a term that has been
published but not yet opened for registration is captured from day one), and
sweeps each: pages of 500 sections, capped at 40 pages, 200–400 ms between
requests, 1 s between terms, at most three attempts, `Connection: close` on
every request so Banner's load balancer pins the session correctly, and a
`User-Agent` naming this service and repository. Today that is seven terms and
about 21,000 sections in under three minutes. A sweep that does not complete is
discarded; the previous snapshot stays in place and the job reports `FAILED`
for that term.

**Rest.** One SQLite file per term under `state/clemson/`, written atomically
(temp file, then rename) so a reader never sees a half-written snapshot. Four
tables: `sections` (CRN, course, section, title, credits, seats, enrolment),
`meetings` (day, start and end minute, building, room — one row per meeting
day), `instructors`, and `meta` (when it was fetched). ~3 MB per term.

**Serving.** The schedule server opens the term's file read-only per request.
Nine of its eleven tools read only the snapshot. Three reach Banner live:
`list-clemson-terms`, `get-course-details`, and `search-classes` when a caller
passes `refresh: true` for current seat counts. Every answer carries the
snapshot's `data as of` time.

### 1b. The curriculum catalog

**Source.** `catalog.clemson.edu`, Clemson's online catalog (Acalog). It is a
JavaScript application, so program pages do not exist as static HTML.

**Collection.** `core/scripts/rebuild_db.sh`, run by hand about once a year
when a new catalog year is published — never on the serving host. Eight steps:

1. The Graphic Communications BS across eight catalog years (page discovery and
   ingest).
2. Six more College of Business majors across four years — Accounting,
   Economics BA and BS, Financial Management, Management, Marketing.
3. Pre-Business.
4. The course catalog: 4,085 course pages, cached so only changed pages are
   re-fetched.
5. Minors and certificates: their requirements are prose, so a language model
   extracts them into structured rules. The extraction is cached by page
   content; a page Clemson has edited misses the cache and is re-extracted,
   which is why a rebuild needs an LLM endpoint even with a warm cache.
6. Requirement rules, General Education, and academic regulations for every
   year.
7. Corequisites and per-course source URLs.
8. Department "packs" — per-program overlay rules (which courses satisfy a
   Specialty Area slot, for instance) that the catalog states in prose or not
   at all.

Program pages are rendered with a headless browser (Playwright) and parsed;
every page fetched is kept under `core/data/raw/` and committed, so the
database can be rebuilt from this repository alone. `core/README.md` maps the
package.

**Rest.** One SQLite file, `core/db/catalog.db` (~5.7 MB), with tables for
catalog years, programs, plan items (the semester-by-semester plan), requirement
groups and rules, courses, gen-ed categories, footnotes, academic regulations,
and the source snapshot each row came from. Reference census: 997 programs (of
which 879 minors and 82 certificates), 4,085 courses, 1,057 effective rules.

**Serving.** The catalog server reads that file in-process, read-only. Nothing
spawns Python. Every catalog read is a SQLite query in Node; the Python that
built the database is checked against those reads by a differential test across
every program and catalog year.

### 1c. One hand-exported file

Banner's public feed carries no room capacity, so `data/clemson-room-capacity.json`
(435 rooms → seat count) was exported once from a report behind Clemson SSO.
`security.md` §1 names it as the one non-published input. It is loaded by both
servers, attached to meeting records internally, and — today — dropped before
anything is sent to a caller.

### 1d. What a client receives besides tool results

- A text preamble at `initialize`, describing the server.
- Skill documents — advising guidance for a model, served by `list-skills` /
  `get-skill-docs` (schedule) and `list-gc-skills` / `get-gc-skill-docs`
  (catalog). One document on the schedule server, two on the catalog server;
  anything else on disk is refused by name.
- A skills version in every result's `_meta`, so a client that caches those
  documents knows when to re-fetch.

---

## Part 2 — Every tool, as the servers describe it

Both servers require a bearer token, are read-only, and filter every listing
and every call by the caller's scope. "Snapshot" means the term's SQLite file;
"live" means a request to Banner at call time.

### Schedule server — `advising-mcp-schedule`, port 8766

Every tool that takes a `term` accepts a code (`202608`) or a name
(`"Fall 2026"`) and defaults to the current registration term. A term the
server cannot parse is an error; a valid term with no snapshot is reported as
`has_snapshot: false`, never as an error and never as "no such term".

#### `search-classes`

Search Clemson class sections by subject and/or course number, with optional
filters: instructor, building/room, days, earliest and latest meeting time,
open seats only. One of `subject` or `course_number` is required — an unscoped
whole-term search is refused. Large result sets return the top sections by open
seats plus a `needsNarrowing` summary. Reads the snapshot; `refresh: true`
forces a live Banner query for up-to-the-minute seats.

#### `get-course-details`

Details for one course (`course_code`, e.g. `GC 3010`: description,
prerequisites, corequisites, restrictions, credits) or one section (`crn`).
Corequisites come from the catalog's structured field; a course with none
listed returns an empty list rather than an inferred one. Not a search. Live
(reads Banner).

#### `check-conflicts`

Which CRNs in a set have time conflicts, pair by pair. Optional
`candidate_crns` tests whether adding sections would conflict with the fixed
set. Deterministic, from the snapshot. Sections with no meeting time cannot
conflict and are reported as such — that is not a compatibility guarantee.

#### `find-alternatives`

Sections that fit around a student's existing schedule (`current_crns`)
without time conflicts, with optional subject, credits, days, time-of-day,
excluded-day, and open-seats filters. When many fit, returns the top sections
by open seats plus a `needsNarrowing` summary. Snapshot.

#### `find-conflict-free-schedule`

Given `fixed_crns` (already committed) and `candidate_crns` (options), returns
which candidates can be added without conflicts — each candidate checked
against every fixed CRN and every other candidate — with details of the
conflicts for the rest. Snapshot.

#### `get-sections-by-crn`

What the snapshot records for one or more CRNs: course, section, title,
credits, and every meeting (day, start/end, building, room). For confirming
CRNs you already have. CRNs with no row come back in `not_found`, which is
authoritative: the snapshot was read and has no such CRN. A term with no
snapshot returns `has_snapshot: false` with `not_found` **empty** — nothing was
checked, so nothing is claimed. Snapshot.

#### `resolve-crns`

The CRN for each course + section pair, for schedule data that carries no CRNs
(a Navigator export, a typed-out schedule). Course codes match with or without
the space. Results align **by index** with the input; a `null` means no single
match — none, or several — and the tool never guesses between candidates.
Snapshot.

#### `get-schedule-freshness`

When the snapshot for a term was last ingested — the `data as of` behind every
seat count. Reads only the snapshot's metadata; no Banner load. `has_snapshot:
false` for a term not yet ingested.

#### `list-clemson-terms`

Banner's term codes and names. Only for discovering a valid term when none is
known — every other tool defaults its own term. Live.

#### `list-skills` · `get-skill-docs`

List the skill documents this server serves (name and description), and fetch
one by name. This server serves exactly one: `clemson-schedule-advising`.

### Catalog server — `advising-mcp-catalog`, port 8767

Program names are the registrar's, exactly as the catalog spells them
(`"Marketing, BS"`). There is no default program; `list-gc-programs` gives the
valid names. `catalog_year` is a label like `2026-2027`; students are pinned to
their matriculation year.

#### `list-gc-programs`

Every program this catalog can advise on, with the catalog years each exists
in. Majors with a semester-by-semester plan, plus Pre-Business. Minors and
certificates are not listed here — look those up by name with
`get-program-requirements`.

#### `list-gc-catalog-years`

The valid catalog-year labels. Only for discovering one when none is known.

#### `get-gc-program-plan`

The full semester-by-semester degree plan for a program in a catalog year:
required courses, one-of choice sets, requirement slots, per-term and total
credits, footnotes, and the catalog page it came from. This is the bulk of the
degree but not all of it — the named requirement slots carry their own rules in
`get-gc-requirement-rules`.

#### `get-gc-requirement-rules`

The named requirement slots for a program and year — lab science, specialty
area, technical requirement, REACH — with explicit course codes, credits, and
the footnote text they come from. Only part of a program's obligations: a
course absent here is **not** absent from the degree. Does not include General
Education.

#### `get-gc-gen-ed`

Clemson's General Education requirements for a catalog year: six categories
(Communication, Mathematics, Natural Sciences with Lab, Arts and Humanities,
Social Sciences, Global Challenges) with minimum credits, allowed courses,
constraint rules, and learning outcomes. University-wide; does not vary by
program.

#### `find-course-in-program`

Every place a course code or subject prefix appears in one program's catalog
year — searching **both** the semester plan and the named requirement rules.
The only tool that covers both stores, which is what makes its `found: false`
meaningful; a not-found from either of the two tools above alone is not
evidence of absence. This tool exists because an advisor once asked what the
PCID requirement was and was told, wrongly, that there wasn't one.

#### `get-gc-course`

One course's catalog entry — title, credits, description — by code. The
catalog entry, not a class section; for meeting times or seats use the
schedule server. An unreadable catalog is an error here, never `found: false`.

#### `get-program-requirements`

What a minor or certificate requires: total credits, required courses,
elective rules. Partial or misspelled names return candidates to choose from.

#### `find-requirement-sections`

The advising join: sections offered this term that fill a named requirement
slot **and** that the student is eligible for, with the same scheduling filters
as the schedule tools. Prerequisite eligibility is **three-valued** —
`eligible`, `not_eligible`, or `undetermined`. Undetermined means the stated
rule cannot be decided from structured data (it contains an OR, a grade
minimum, a standing or consent gate, or did not parse), and the caller is told
to read `prereqText` rather than report the student ineligible. Roughly a third
of Clemson courses with prerequisites fall in that class. An unknown
requirement name returns the valid slot list. `completed_courses` is the one
student-shaped input: course codes only, used for gating, never stored. Reads
both the catalog and the term snapshot.

#### `list-gc-skills` · `get-gc-skill-docs`

List and fetch this server's skill documents. It serves exactly two:
`gc-advisor` (the advising playbook) and `gc-curriculum-lookup`.

---

## What is deliberately not a tool

- **Anything that writes.** There is no write path to any Clemson system.
- **A degree audit.** The engine exists under `core/` and is CLI-reachable, but
  it is not exposed over MCP; that is an open decision, not a gap.
- **Anything that takes a student's identity.** No tool has a field for one.
