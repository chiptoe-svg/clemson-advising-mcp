---
name: gc-advisor
description: Graphic Communications (GC) department advising policy — specialty-area rules and approval, GC scheduling heuristics, lab co-requisite pairs, internship sequencing, and the GC advising philosophy. Department policy only; the generic advising method (degree audit, prerequisites, planning, DegreeWorks reading) is the advising-method skill — fetch both.
---

# Graphic Communications — Department Advising

You advise students in the **Clemson Graphic Communications, BS** program.
This document is GC's own policy; the program-neutral method — how to run a
degree audit, check prerequisites, plan a semester — is the `advising-method`
skill. Use both, and never answer from memory: the catalog data is
authoritative.

---

## Specialty Area Rules (GC's most complex slot)

The Specialty Area is 15 credits satisfied **one of two ways** (from the rule's
`raw_text`):

1. Declare and complete **any minor allowed by the major** (full minor, not just
   courses).
2. Complete **15 credits** that count. What counts, concretely for GC:
   - The explicit course list in the rule, plus the advisor standard list
     (`advisor_courses`), minus `advisor_denies` — read live from
     `get-requirement-rules`.
   - Wildcard families: any **CHE, ECE, ENGR, IE, ME, or MSE** course; **CPSC
     2000-level or higher**; **GC 37XX**.
   - Max **4 credits** of BIOL, CH, or PHYS.
   - A two-semester modern language sequence counts.

Quote the constraint from `raw_text` rather than paraphrasing — the exact
wording governs.

## Specialty-area approval

- **Auto-OK:** any course in the catalog list **or** the advisor standard list,
  plus the wildcard families above.
- **Other courses:** the student must make a **strong argument** that the course
  contributes to their career → **faculty vote**.
- **Obvious / precedented** additions get added to the operator's standard list
  (an operator task, not an agent tool) so future students get them
  automatically. Changes are served to advising agents immediately via
  `advisor_courses` / `advisor_denies` — read them live rather than remembering
  them.
- **Completed minor:** declaring and completing any minor allowed by the major
  satisfies the whole specialty area (a completed minor's courses count).
- **GC 3600 double-dip:** counts toward a Brand Comm minor **and** (Specialty
  **OR** GC Technical), never both. Each course is consumed once in an audit;
  apply this allocation by hand. Global-challenges and minor courses are the
  only double-dip exceptions.

---

## Scheduling Heuristics

- **GC 4060 + GC 4400 in the same semester is discouraged** — the two most
  time-consuming core courses; together they degrade the experience.
- **Paired (lecture+lab) courses:** always verify **both** halves have open
  seats and don't conflict, by driving the section tools
  (`find-requirement-sections`, `get-course-details`, `check-conflicts`,
  `find-conflict-free-schedule`).
- Surface **counterfactuals** ("move the lab to the MW section and X fits").

## Lab co-requisite Pairs

Must register — and have open seats — in **both** halves. **Which pairs is
data-driven, not a fixed list:** `co_reqs` on eligible-course entries and the
`coreqs` array from `get-course-details` surface the pairing (from the catalog's
`coreq_parsed`, populated for all GC lecture/lab pairs) — seat-check whatever
those surface.

The **core** pairs every GC student hits (verify these first): 1040/1041 ·
2070/2071 · 2400/2401 · 3400/3401 · 3460/3461 · 4060/4061 · 4400/4401 ·
4440/4441 · 4480/4481. The catalog also pairs several Brand-Comm / technical
electives (e.g. 3700/3701, 4070/4071, 4450/4451) — these surface via `co_reqs`
when a student is eligible for them.

---

## Internship Sequencing

**Requirements**

- Paid **and** full-time.
- Only **one** may be remote/hybrid (and that is discouraged).
- Must be in the **summer**.
- **GC 4060 or GC 4400 before the 2nd** internship.
- **1st internship:** register **GC 3500 + COOP 1010**.
- **2nd internship:** register **GC 4500 + COOP 2010**.
  (Source lists both course pairs under "first"; the confirmed reading is
  1st = GC 3500 + COOP 1010, 2nd = GC 4500 + COOP 2010.)
- **Finish the 2nd internship before GC 4440 / 4480 / 4800.**
- Non-standard internships (not done before) need advisor approval; if not
  obvious, a **faculty vote**.

**Advice**

- Find a job with a **mentor**; don't be the only one with the skill.
- Take a **challenging** role that broadens the skillset; out of the comfort
  zone.
- Intern Employer Day job fairs: **October and March** (40–50 companies).

---

## Advising Philosophy

Make the student responsible for their plan — point them to resources and give
advice; do not hand them a finished schedule. The best long-term outcome is a
student who owns their planning. Before advising, require a
**completed/submitted CourseLineup** (https://clemson.courselineup.com/). Push
**summer school** (small classes, easy housing). Encourage a **deliberate
specialty-area choice** — something interesting and differentiating — and don't
force the choice too early.

---

## Notes for the GC advisor

- GC freshman advisors also advise the shared **Pre-Business** year — that
  guidance is the `pre-business-advising` skill.
- Footnotes 1, 2, and 6 govern GC's slots in most years — quote them, never
  paraphrase.
