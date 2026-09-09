---
name: pre-business-advising
description: Advising the shared Pre-Business freshman year — the common first year for Accounting, Economics, Financial Management, Management, and Marketing. Covers the plan, the MATH-sequence choice, and major-declaration thresholds. Use with advising-method (the generic audit/planning method).
---

# Pre-Business Advising

Pre-Business is the shared freshman year for the five business majors
(Accounting, Economics, Financial Management, Management, Marketing). It is a
real program in the catalog: call `get-program-plan` with
`program: "Pre-Business"` for the student's catalog year. Casual inquiry — no
DegreeWorks or audit needed. The generic method lives in `advising-method`.

**NO STUDENT STARTS IN ONE OF THE FIVE MAJORS.** Accounting, Economics (BS),
Financial Management, Management and Marketing are not directly enterable:
every student is admitted as **Pre-Business**, completes the shared freshman
core, and declares the major on meeting the threshold below. So "a freshman in
Marketing" does not exist — that student is a Pre-Business freshman *heading
for* Marketing, and a first-year plan for them is the Pre-Business plan, not
the major's. Each of the five majors' own `get-program-plan` reflects this: its
freshman terms are labelled `Pre-Business Freshman/…`.

This applies to those five and no others. **Economics BA, Graphic
Communications and Packaging Science are direct-entry** — a freshman really is
in the major from day one, and none of them carries a Pre-Business block. Do
not generalize the rule beyond the five.

- **"What should a pre-business freshman take?"** → read the plan's two
  semesters (fixed courses, the MATH-sequence choice, the slots).
- **"Which MATH sequence?"** → the `MATH …` choice items carry `footnote_refs`
  to the sequence-rules footnote; quote it (Economics differs — see the
  footnote).
- **"When can I declare my major?"** → the program `description` carries the
  policy: freshman core complete + a Clemson GPA of **2.0** for Accounting /
  Economics / Financial Management / Management, **3.0** for Marketing;
  change-of-major needs 12 hrs, the approved MATH sequence, ECON 2110 or 2120,
  and a 2.5 GPA.
- A `choice` item may carry a **slot alternative** (e.g. "ACCT 2010 **or** the
  South Carolina REACH Act Requirement" — both `one_of` and a `slot_type`);
  present both options and quote the footnote.

**Always use the student's own catalog year** — the pre-business curriculum has
shifted across years (social-science and oral-communication requirements
changed). `Pre-Business` is stored for the last four catalog years.
