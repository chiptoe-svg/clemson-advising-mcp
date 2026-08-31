---
name: advising-method
description: The department-neutral advising method for every College of Business program served by the Clemson advising MCP tools — how to run a degree audit by hand (with the counting rules that make it correct), check prerequisites, plan a semester, read a pasted DegreeWorks audit, answer gen-ed questions, and drive the tools efficiently. Department-specific policy lives in each department's own skill (e.g. gc-advisor); this document applies to all of them.
---

# Advising Method

How to answer advising questions from the catalog and schedule tools, for any
program they serve. Never answer from memory — the catalog data is
authoritative. Department policy (internship rules, approval workflows,
department scheduling lore) is deliberately NOT here: fetch the department's own
skill document alongside this one.

---

## MCP Tools

| Tool | Use for |
|---|---|
| `list-programs` | Which programs the catalog covers — the valid `program` values |
| `list-catalog-years` | Valid year strings — fallback when `catalog_year` isn't already resolved |
| `get-program-plan` | Full degree plan for a program + catalog year (groups → items → footnotes) |
| `get-requirement-rules` | Named requirement slots with explicit courses, advisor additions/denials, wildcards |
| `get-gen-ed` | 6 gen-ed categories with min credits and allowed course lists |
| `get-course` | One course's catalog entry (title, credits, description) |
| `get-program-requirements` | What a minor or certificate requires |
| `get-course-details` | (schedule server) catalog info incl. prereqs/coreqs by `course_code`, or one live section by `crn` |

The catalog tools take canonical **`program`** + **`catalog_year`** keys and echo
the resolved pair back in every response — check the echo. A call with no
resolvable `program` is an **error** listing the known programs (there is no
default program). The old `name`/`year` keys are deprecated aliases — never use
them.

---

## Data shapes

**`get-program-plan`** returns:
```
{
  name, total_credits,          // e.g. "Marketing, BS", 120
  groups: [{
    label,                      // e.g. "Freshman/First Semester"
    credit_total,
    items: [{
      kind,                     // "fixed_course" | "slot" | "choice"
      course_code,              // set for fixed_course, null otherwise
      one_of,                   // list of codes for "choice" items
      slot_type,                // e.g. "Approved Laboratory Science Requirement"
      credits,
      footnote_refs             // footnote numbers that govern this slot
    }]
  }],
  footnotes: [{ number, text }], // full prose for each footnote number
  source_url                     // exact Clemson catalog page — cite it
}
```

**`get-requirement-rules`** returns:
```
[{
  slot_type,                    // matches slot items in the program plan
  rule: {
    total_credits,
    explicit_courses,           // list of "DEPT NNNN" strings
    advisor_courses,            // faculty-approved additions (live data)
    advisor_denies,             // faculty subtractions (live data)
    wildcards,                  // wildcard families, possibly with credit caps
    raw_text,                   // verbatim footnote prose (quote when explaining)
    satisfy_one_of              // e.g. ["approved_minor","course_set"]
  }
}]
```

**`get-gen-ed`** returns:
```
[{
  name,                         // e.g. "Natural Sciences with Lab"
  min_credits,
  allowed_courses,
  rules,                        // constraint sentences (overlap/level restrictions)
  learning_outcome
}]
```

**`get-course-details`** with `course_code` returns `null` if the code isn't in
the DB. `prereq_parsed` is a list of `"DEPT NNNN"` codes extracted from
`prereq_text`. It adds a `coreqs` array; absent means none. Each coreq carries a
`source`: `catalog_coreq` is authoritative, `inferred_from_description` was
guessed from prose — say so rather than stating it as fact.

---

## Step 0 — confirm the governing catalog year

Every answer is pinned to a catalog year.
1. If the selected year may not be the student's, ask which **catalog year**
   governs their degree (typically the year they entered).
2. If the valid options are unknown, call `list-catalog-years`.
3. "Most recent" means the latest year from that list.
4. Use one year in **every** subsequent call. Do not mix years.

---

## Degree Audit

When a student shares their completed courses and asks what they still need:

1. Call `get-program-plan` for their program and catalog year.
2. Walk every item in every group:
   - **`fixed_course`**: satisfied if `course_code` is in the completed list.
   - **`choice`**: satisfied if **any** code in `one_of` is in the completed list.
   - **`slot`**: satisfied per the requirement rule for that `slot_type`.
3. Call `get-requirement-rules` and match rules to slot items by `slot_type`.
   **What counts toward a slot is more than `explicit_courses`**: apply
   `explicit_courses` + `advisor_courses` − `advisor_denies` + the rule's
   `wildcards` (which may carry per-family credit caps). Where a rule offers a
   minor path (`satisfy_one_of` includes `approved_minor`), verify the minor
   exists with `get-program-requirements` — do not take the name on trust. Quote
   `raw_text` when the student asks what qualifies.
4. Check gen-ed separately with `get-gen-ed`: each category needs
   ≥ `min_credits` from `allowed_courses`, plus any constraint sentences in
   `rules` (e.g. "two different fields").
5. Tally remaining credits. Report: what's done, what's still needed, and total
   credits remaining toward `total_credits`.

Three counting rules a hand walk gets wrong if applied naively:

- **Each course counts once across the whole audit.** A course that satisfied a
  plan item must not also fill a named slot. The only double-dip exceptions are
  global-challenges courses and minor courses (see the department skill for
  any department-specific allocation calls).
- **A retaken course counts once**, at its highest credit value — never summed.
- **Credit caps apply within wildcard families**, not just at the slot total.

---

## Prerequisite Check

1. Call `get-course-details` with `course_code` (format: `"MKT 3010"`).
2. If `prereq_parsed` is non-empty, check those codes against the completed list.
3. If `prereq_text` is set but `prereq_parsed` is empty, quote `prereq_text`
   verbatim — it may hold prose conditions (grade minimums, consent) that could
   not be auto-parsed. Do not report the student ineligible on an unparsed rule.
4. A `null` return means the code isn't in the DB — say so and ask the student
   to double-check the code.

---

## Course Planning ("What should I take next?")

1. Run a degree audit (above) to identify remaining requirements.
2. Check prereqs for each remaining course or slot candidate.
3. Identify what the student is **already eligible** for.
4. Suggest a next-semester slate that covers 15–16 credits, advances unmet
   requirements, and avoids courses whose prereqs aren't cleared.
5. Flag every slot where the student must choose, presenting options from
   `explicit_courses` / `allowed_courses` and quoting `raw_text` for
   prose-only constraints.

---

## Reading a DegreeWorks audit pasted into the conversation

You are the parser — no schema checks your reading. The common trap:

**A requirement header may carry no course codes at all.** Its options sit on
`-`-prefixed sub-bullet lines, each a separate way to satisfy the requirement:

```
GENERAL EDUCATION - Oral Communication  Still needed: Choose from 1 of the following:
(3 Cr)
-COMM Coursework   3 Credits in COMM 1500 or 2500 or HON 1950 or 2230
-AS Cluster        4 Classes in AS 3090 and 3100 and 4090 and 4100
-ML Cluster        2 Classes in ML 1010 and 1020
```

Read the sub-bullets as part of the requirement, and note the shapes differ: the
COMM line is **or**, the AS and ML lines are **and**. Reading only the header
silently drops the requirement; flattening the sub-bullets wrongly lets one AS
course satisfy it. Measured on a cleaned What-If corpus: 22 such lines across 19
of 29 records. Common, not an edge case.

---

## Gen-Ed Questions

1. Call `get-gen-ed` for the student's catalog year.
2. Present the 6 categories with min credits and, if asked, allowed courses.
3. Apply constraint sentences from `rules`.
4. If asked whether a specific course counts, check its code against
   `allowed_courses`; if absent, it does not satisfy that category per the
   catalog data.

---

## Academic Regulations

GPA requirements, academic standing, the REACH Act, advancement policy: these
live in the catalog's Academic Regulations (referenced by plan footnotes in some
years). State that the binding text is the catalog's, and direct policy
decisions (probation, exceptions) to an official advisor.

---

## Substitutions

Filed by the **student** through iRoar; auto-routes advisor → department chair →
college. Workflow only — nothing for the advisor to data-enter.

## Transfer Credit

- Send official transcripts to **esstranscripts@clemson.edu** and complete the
  **transfer-exemption-waiver** PDF
  (https://www.clemson.edu/registrar/documents/transfer-exemption-waiver.pdf).
- Only **6 hours of the last 43** hours before graduation may be transferred.
- Only **1000- and 2000-level** courses can transfer.
- Confirm acceptance via the registrar's transfer-equivalency site before the
  student enrolls elsewhere.

---

## Rules (never break these)

- **Catalog year pinning**: credits and requirements come from the
  catalog-year-pinned plan, never the current `course` table.
- **Null course**: a `null` from `get-course-details` means the code isn't in
  the DB — never treat it as "no prerequisites" or "no such requirement".
- **Never guess**: if data is missing, say so and direct the student to their
  official advisor for binding guidance.
- **Quote don't paraphrase footnotes** — the exact wording governs what
  satisfies a requirement.
- **Always cite the catalog year** in your answer.
- **Link the source page.** `get-program-plan` returns `source_url` for any
  program — including a minor or certificate (empty `groups`, real
  `source_url`). `get-course-details` returns one per course. Cite them.

---

## Tool-driving

`get-program-plan` / `get-requirement-rules` (find unmet + eligible) →
`find-requirement-sections` (candidate sections) → `check-conflicts` /
`find-conflict-free-schedule` (fit) → for paired lecture/lab courses, confirm
both halves via `get-course-details` (`crn`, one per half). The advisor course
list rides on each rule as `advisor_courses` / `advisor_denies` — read it live.

## Requirement + scheduling-constraint queries → ONE call, don't hand-filter

When a student asks for a course that BOTH satisfies a requirement slot AND fits
scheduling constraints, call `find-requirement-sections` ONCE with the
constraint parameters. Do NOT pull the full eligible list and filter by hand:
the eligible set can be ~60 courses, and cross-turn filtering is unreliable.
Pass: `requirement` (an unknown value returns the valid slot list), `program`,
`catalog_year`, `no_meeting_before`/`no_meeting_after` (HHMM), `exclude_days`,
`days`, `fits_around_crns`, `completed_courses` (prereq gating only),
`open_seats_only`. `term` defaults to the current registration term. Async
sections come back in `sections_without_meetings` — mention them. Never claim
"nothing fits" without having made this call.

## Links

- DegreeWorks — https://dash.sis.clemson.edu/Dashboard
- CU Navigate — https://clemson.campus.eab.com/home
- iRoar Faculty Self-Service — https://fss.sis.clemson.edu/FacultySelfService/ssb/facultyCommonDashboard
- Registrar student training — https://www.clemson.edu/registrar/student-menu/training-materials.html
- iRoar — https://iroar.app.clemson.edu/
