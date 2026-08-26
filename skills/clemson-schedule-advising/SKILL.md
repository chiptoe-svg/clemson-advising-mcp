---
name: clemson-schedule-advising
description: Use when answering schedule, room-availability, conflict-check, or GC degree-advising questions using CUassistant's Clemson tools. Indexes the public Banner + gc_advisor catalog MCP tools by purpose, gives the standard multi-tool workflows, and records the known limitations. Per-tool parameters live in each tool's own schema — this doc is for which tool to use when, and how they chain.
---

# Clemson Schedule & Advising

CUassistant exposes two public MCP servers for Clemson data. Neither requires
credentials.

| Server | Port | Tool prefix (NanoClaw) |
|---|---|---|
| `cuassistant-public` | 8766 | `cuassistant-public__` |
| `cuassistant-catalog` | 8767 | `cuassistant-catalog__` |

All data is read-only. All Clemson content must be processed by **OpenAI or a
local model only** — never routed through Anthropic. This is a hard constraint
in `policy/action-policy.yaml`.

**Parameters and return shapes are NOT repeated here.** Every tool arrives with
its own input schema (names, types, descriptions) — read that for the exact
arguments; it is always current. This document covers what a schema can't: which
tool to reach for, the order to call them in, and where the data lies to you.

**Term is optional everywhere.** Every tool below defaults to the current
registration term when `term` is omitted, and accepts free text ("Spring 2027")
as well as a Banner code. Do not look up a term code before calling a tool that
doesn't strictly need one.

---

## Core tools — always active for the advisor

| Tool | Server | Use it to… | Watch out for |
|---|---|---|---|
| `search-classes` | 8766 | Search the class schedule by subject and/or course number, with instructor / building-room / days / time / open-seats filters | **Must** scope by `subject` or `course_number` — an unscoped search is rejected. Snapshot-backed (nightly ~05:00); pass `refresh:true` only for live seat counts, and only after scoping the search. Page with `offset` when `totalCount` exceeds what was returned. This tool folds in what used to be separate instructor- and room-lookup tools — use `instructor` / `building_room` filters instead of a dedicated call. |
| `find-alternatives` | 8766 | Sections that fit around a schedule the student is keeping, given `current_crns` | Candidates are checked against every CRN in `current_crns`; it does not also dedupe against itself — pair with `check-conflicts` if you're assembling more than one new section at once. |
| `check-conflicts` | 8766 | Find time-overlapping pairs in a set of CRNs, or test `candidate_crns` against a fixed set | TBA/online sections (no meeting time) come back in `conflict_free` because there's no time to conflict — that is not a real compatibility guarantee. |
| `get-course-details` | 8766 | Full detail for one course (`course_code`) or one section (`crn`): description, prereqs, coreqs, credits, restrictions | `course_code` and `crn` are different lookups with different fields — pass `course_code` for catalog facts (also returns lab coreqs), `crn` for a specific offered section. No parsed textbook list — Banner exposes only a bookstore URL. |
| `find-requirement-sections` | 8767 | **The advising join** — sections that fill a named GC requirement slot AND are offered this term AND are prereq-eligible (`completed_courses`), with the same scheduling filters as the tools above | Requires `requirement` — an unknown slot name returns the valid slot list for the resolved program/catalog year inline, so retry with a name from that list rather than round-tripping through `get-gc-requirement-rules`. Prereq check is AND-logic only (see Known limitations). GC program only. |
| `show-schedule-options` | host (advisor) | Render a few candidate sections as tabs over the student's current schedule | Two-step flow: call a finder first (`find-requirement-sections` / `find-alternatives` / `search-classes`), then pass its CRNs verbatim as `candidates` — do not re-derive times/rooms in prose instead of the second call. |
| `propose-schedule` | host (advisor) | Render one verified, printable schedule document | Parameters are the schedule itself — every CRN, course, credit, day/time, and room is checked against the snapshot and the call is refused on a mismatch. Look sections up first. |
| `load-tools` | host (advisor) | Activate a category of tail tools when one you need is reported "not found" | Categories: `curriculum-extras`, `outcomes`, `wiki`, `meta` (below). One call per category needed. |

## Tail tools — behind `load-tools`

Everything below is registered but inactive until `load-tools` is called with
the matching category. Outside the advisor (e.g. a direct NanoClaw integration
with no dynamic tool loading), these are simply always-available MCP tools —
`load-tools` is an advisor-only gate, not a server-side restriction.

**`curriculum-extras`** (8767 unless noted)

| Tool | Use it to… | Notes |
|---|---|---|
| `list-gc-catalog-years` | Get a valid catalog `year` | Students are pinned to their matriculation year — never mix years. |
| `get-gc-program-plan` | Full semester-by-semester GC degree plan | Groups → items (`fixed_course` / `choice` / `slot`) → footnotes. |
| `get-gc-requirement-rules` | Lab-science / specialty-area / technical slot rules | The `slot_type` values here are what `find-requirement-sections` expects as `requirement`. |
| `get-gc-gen-ed` | The six Gen-Ed categories with min credits + allowed courses | Apply the `rules` constraint sentences (e.g. Social Sciences "two different fields"). |
| `audit-gc-progress` | Deterministic degree audit on a sanitized ledger | Input is course codes + terms + credits only — no identity, no grades (and none accepted). |
| `get-program-requirements` | Requirement rules for a **minor or certificate** (not the full GC BS plan) | Partial/misspelled names return candidates. |
| `find-conflict-free-schedule` | 8766 — which candidate CRNs fit around already-fixed CRNs, checked pairwise both ways | Grouped here because it answers a curriculum-shaped "what combination works" question, not a bare lookup. |

**`outcomes`** — aggregate GC graduate-outcome data (gc_alumni): `about` (call
first — caveats and data provenance), `top_first_jobs`, `starting_salary`,
`top_skills`, `where_grads_work`, `common_next_step`.

**`wiki`** — curriculum wiki lookups (gc_curriculum_wiki): `list_wiki`,
`read_wiki`, `search_wiki`, `coverage_for_target`, `prereq_chain`,
`search_curriculum`.

**`meta`** — operational lookups: `list-skills`, `get-skill-docs` (advising
skill index — GC scheduling/tool workflows, requirement rules, how the
assistant works), `check-system-health` (pings each data source + the
inference backends), `get-schedule-freshness` (8766 — snapshot age for a term,
no Banner load; unlike the tools above, `term` is **required**, not defaulted),
`list-clemson-terms` (8766 — Banner term codes; rarely needed since every
other tool above defaults its own term).

For deeper GC advising domain rules — degree-audit logic, specialty-area
approval, lab co-requisite pairs, internships, transfer credit, scheduling
heuristics — consult the **`gc-advisor`** skill (`list-gc-skills` /
`get-gc-skill-docs` on 8767, or `list-skills` / `get-skill-docs` from the
advisor once `meta` is loaded). This document is the tool index + scheduling
workflows; `gc-advisor` is the advising playbook.

---

## Standard workflows

**Open sections for a subject**
`search-classes { subject, open_seats_only }` → `get-course-details { crn }`
for any CRN needing full detail.

**Does a proposed schedule conflict?**
Collect CRNs (`search-classes` / `find-requirement-sections`) →
`check-conflicts { crns }`.

**Show a student a few section choices side by side**
`find-alternatives { current_crns, subject/days/… }` (or `search-classes` /
`find-requirement-sections`) → `show-schedule-options { term, current_crns,
candidates }` with the finder's CRNs, verbatim.

**Find eligible sections for a requirement slot**
`find-requirement-sections { requirement, completed_courses, …constraints }` —
an unknown `requirement` name returns the valid slot list inline, so this is
usually one call, two at most. `check-conflicts` to confirm fit against
anything already fixed.

**Room or instructor lookup**
`search-classes { subject or course_number, building_room }` or
`search-classes { subject or course_number, instructor }` — both are filters
on the same tool now, not separate lookups.

**Full advising session**
`load-tools { category: "curriculum-extras" }` → `get-gc-program-plan`
(identify open slots) → `audit-gc-progress` (what's satisfied vs open) →
`get-gc-requirement-rules` (explicit courses / slot names for open slots) →
`find-requirement-sections` per open slot → `check-conflicts` on the candidate
set → `propose-schedule` on the final proposal. For lab pairs, confirm **both**
halves have seats and don't conflict.

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
  use `search-classes { refresh: true }` (scoped first) or Banner directly.
  `find-requirement-sections` and `find-alternatives` do not have a live-refresh
  option — only `search-classes` does.
- **Day ordering is MTWRFSU.** Meeting days are always Monday-first: M T W R F
  S U (S = Saturday, U = Sunday). A MWF class is `"MWF"`, never `"FMW"`.
- **`find-requirement-sections` is GC-only and needs a snapshot.** The join is
  between the Banner snapshot and `gc_advisor.db`, so only GC programs/rules are
  queryable, and a term with no snapshot yet (a newly opened term before ~05:00)
  errors — retry after the next daily refresh. For non-GC programs, use
  `search-classes` with course codes from `get-gc-program-plan` or
  `get-program-requirements`.
- **No standalone instructor/room tools.** What used to be dedicated
  instructor- and room-lookup tools are now `instructor` and `building_room`
  filters on `search-classes` — there is no separate "every section a faculty
  member teaches" or "busy/free blocks for a room" call.
