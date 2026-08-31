---
name: clemson-schedule-advising
description: Use when answering Clemson class-schedule, section, conflict-check, or degree-advising questions with the Clemson advising MCP tools. Indexes the schedule and catalog tools by purpose, gives the standard multi-tool workflows, and records the known limitations. Per-tool parameters live in each tool's own schema — this doc is for which tool to use when, and how they chain.
---

# Clemson Schedule & Advising

Two MCP servers publish Clemson course data. Both are read-only, both serve
published Clemson data, and **both require a bearer token** — there is no
anonymous access. Whoever runs your client has issued it one.

| Server            | Port | Serves                                           |
| ----------------- | ---- | ------------------------------------------------ |
| schedule (`8766`) | 8766 | Banner class schedule: sections, times, seats    |
| catalog (`8767`)  | 8767 | Degree catalog: plans, requirement rules, gen-ed |

A client may be connected to one or both. If a tool below is "not found", your
client is not connected to that server — not a sign the data does not exist.

**Parameters and return shapes are NOT repeated here.** Every tool arrives with
its own input schema (names, types, descriptions) — read that for the exact
arguments; it is always current. This document covers what a schema can't: which
tool to reach for, the order to call them in, and where the data lies to you.

**Term is optional on every schedule tool, and every one accepts a name.**
`"Fall 2026"`, `"fall"`, and `202608` all resolve; omit `term` and you get the
current registration term. A term the tool cannot parse is an **error** naming
the accepted forms — it is never reported as a term with no data.

---

## Schedule tools (8766)

| Tool                          | Use it to…                                                                                                             | Watch out for                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search-classes`              | Search by subject and/or course number, with instructor / building-room / days / time / open-seats filters             | **Must** scope by `subject` or `course_number` — an unscoped search is rejected. Snapshot-backed (refreshed ~05:00); pass `refresh: true` only for live seat counts, and only after scoping. Page with `offset` when `totalCount` exceeds what was returned. Instructor and room are filters here, not separate tools. |
| `get-course-details`          | Full detail for one course (`course_code`) or one section (`crn`): description, prereqs, coreqs, credits, restrictions | `course_code` and `crn` are different lookups with different fields. No parsed textbook list — Banner exposes only a bookstore URL.                                                                                                                                                                                    |
| `check-conflicts`             | Find time-overlapping pairs in a set of CRNs, or test `candidate_crns` against a fixed set                             | TBA/online sections (no meeting time) come back in `conflict_free` because there is no time to conflict — that is not a real compatibility guarantee.                                                                                                                                                                  |
| `find-alternatives`           | Sections that fit around a schedule the student is keeping, given `current_crns`                                       | Candidates are checked against every CRN in `current_crns`; it does not dedupe candidates against each other — pair with `check-conflicts` when assembling more than one new section.                                                                                                                                  |
| `find-conflict-free-schedule` | Which candidate CRNs fit around already-fixed CRNs, checked pairwise both ways                                         | Answers "what combination works", not "what exists".                                                                                                                                                                                                                                                                   |
| `get-sections-by-crn`         | Confirm CRNs you already have: authoritative rows and meetings straight from the snapshot                              | `not_found` is the load-bearing half — it means the snapshot was read and has no such CRN. `has_snapshot: false` means nothing was checked, and `not_found` is then empty rather than listing every CRN as fake.                                                                                                       |
| `resolve-crns`                | Get CRNs for course + section pairs, for schedule data that carries no CRNs                                            | Results align **by index** with the input. A null means no single match — none, or several. It never guesses between candidates.                                                                                                                                                                                       |
| `get-instructor-classes`      | Everything each listed instructor teaches; optional day/window filter for teaching conflicts                           | Statuses are explicit: `teaching`/`not_teaching` unfiltered, `busy`/`free` filtered. `not_teaching` is NOT free — the snapshot sees only teaching. Emails match exactly; ambiguous names return candidates.                                                                                                            |
| `get-schedule-freshness`      | How old the snapshot is for a term                                                                                     | Ask before trusting seat counts. `has_snapshot: false` means that term has not been ingested — it does not mean the term does not exist.                                                                                                                                                                               |
| `list-clemson-terms`          | Banner term codes                                                                                                      | Rarely needed — the search tools default their own term.                                                                                                                                                                                                                                                               |

## Catalog tools (8767)

| Tool                        | Use it to…                                                                                                            | Notes                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `list-gc-programs`          | See which programs the catalog covers                                                                                 | Start here when a program name is uncertain; names are the registrar's ("Marketing, BS").                                     |
| `list-gc-catalog-years`     | Get a valid `catalog_year`                                                                                            | Students are pinned to their matriculation year — never mix years.                                                            |
| `get-gc-program-plan`       | Full semester-by-semester degree plan                                                                                 | Groups → items (`fixed_course` / `choice` / `slot`) → footnotes. Includes `source_url`; cite it.                              |
| `get-gc-requirement-rules`  | Named requirement slots: lab science, specialty area, technical                                                       | The `slot_type` values here are what `find-requirement-sections` expects as `requirement`.                                    |
| `get-gc-gen-ed`             | Gen-Ed categories with minimum credits and allowed courses                                                            | Apply the `rules` constraint sentences (e.g. Social Sciences "two different fields").                                         |
| `get-gc-course`             | One course's catalog entry                                                                                            | Catalog prose, not a section. An unreadable catalog is an ERROR here, never `found: false`.                                   |
| `find-course-in-program`    | Whether a course appears anywhere in a program                                                                        | Searches **both** requirement stores and says so, which is what makes its `found: false` trustworthy.                         |
| `get-program-requirements`  | Requirement rules for a minor or certificate                                                                          | Partial or misspelled names return candidates.                                                                                |
| `find-requirement-sections` | **The advising join** — sections that fill a named requirement slot AND are offered this term AND are prereq-eligible | An unknown slot name returns the valid slot list inline, so retry from that list. Prereq check is AND-logic only (see below). |

Both servers also serve `list-skills` / `get-skill-docs` (catalog:
`list-gc-skills` / `get-gc-skill-docs`) — that is how you are reading this. The
catalog server's `gc-advisor` document is the advising playbook: degree-audit
logic, specialty-area approval, lab co-requisite pairs, transfer credit.

**Your host may add its own tools** — rendering a schedule, saving a document,
activating tool categories. Those are not from these servers, are not described
here, and their absence says nothing about the data.

---

## Standard workflows

**Open sections for a subject**
`search-classes { subject, open_seats_only }` → `get-course-details { crn }` for
any CRN needing full detail.

**Does a proposed schedule conflict?**
Collect CRNs (`search-classes` / `find-requirement-sections`) →
`check-conflicts { crns }`.

**Verify a schedule someone gave you**
`get-sections-by-crn { term, crns }` — check `not_found` before believing any
CRN a person or a model produced. If the schedule names courses and sections but
no CRNs, `resolve-crns` first.

**Find eligible sections for a requirement slot**
`find-requirement-sections { requirement, completed_courses, …constraints }` —
an unknown `requirement` returns the valid slot list inline, so this is usually
one call, two at most. Then `check-conflicts` against anything already fixed.

**Full advising session**
`get-gc-program-plan` (identify open slots) → `get-gc-requirement-rules`
(explicit courses and slot names for those slots) → `find-requirement-sections`
per open slot → `check-conflicts` on the candidate set. For lab pairs, confirm
**both** halves have seats and do not conflict.

---

## Known limitations

- **Prereq eligibility is AND-logic.** `find-requirement-sections` marks
  `prereqEligible` true only when **every** parsed prereq code is in
  `completed_courses`. A real "GC 1010 **or** GC 2010" prereq can be reported
  `false` when the student has only one. Always show `prereqText` for OR-logic
  courses so the student can verify.
- **TBA / async sections have no meeting rows.** They appear in searches but
  carry no meetings, so `check-conflicts` returns them `conflict_free` — not a
  guarantee of real compatibility.
- **Snapshot lag.** The schedule snapshot refreshes ~05:00; seat counts can be
  ~24h old. Fine for "what are the sections?"; for "is there a seat right now?"
  use `search-classes { refresh: true }` (scoped first). `find-requirement-sections`
  and `find-alternatives` have no live-refresh option — only `search-classes` does.
- **Day ordering is MTWRFSU.** Meeting days are always Monday-first: M T W R F S
  U (S = Saturday, U = Sunday). A MWF class is `"MWF"`, never `"FMW"`.
- **`find-requirement-sections` needs both data sets.** It joins the Banner
  snapshot to the catalog database, so a term with no snapshot yet (a newly
  opened term before the daily refresh) errors — retry after the next refresh.
  For programs whose rules it does not cover, use `search-classes` with course
  codes from `get-gc-program-plan` or `get-program-requirements`.
- **No standalone instructor or room tools.** They are `instructor` and
  `building_room` filters on `search-classes`; there is no "every section a
  faculty member teaches" or "free blocks for a room" call.
