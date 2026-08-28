# Specialty-area Approval

- **Auto-OK:** any course in the catalog list **or** the advisor standard list
  (`advisor_courses` on the Specialty rule), plus the wildcard rules
  (ENGR/CHE/ECE/IE/ME/MSE any; CPSC 2000+; GC 37XX; ≤4 cr BIOL/CH/PHYS).
- **Other courses:** the student must make a **strong argument** that it
  contributes to their career → **faculty vote**.
- **Obvious / precedented** additions: add them to the standard list so future
  students get them automatically —
  `scripts/manage_advisor_list.py add --slot specialty --code "DEPT NNNN" --note "faculty vote <date>"`.
  Adding is idempotent — a repeat `add` of the same course is a **no-op** (it
  reports "already present, no change"), so it's safe to re-run.
- **Maintaining the list** (`scripts/manage_advisor_list.py`, `--slot specialty|technical`):
  - `list` — show the current advisor layer for a slot.
  - `add` — allow a course (default); `deny` — subtract a course that would
    otherwise count (via catalog or a wildcard).
  - `remove` — delete an advisor row.
  - **To change a course's stance or note, `remove` it first, then re-add** — a
    bare re-`add` won't overwrite an existing entry (one advisor stance per
    slot/year/course). Changes are served to advising agents immediately (the
    skill reads live data via `get-gc-requirement-rules`).
- **Completed minor:** declaring and completing any minor allowed by the major
  satisfies the whole specialty area (a completed minor's courses count).
- **GC 3600 double-dip:** counts toward a Brand Comm minor **and** (Specialty
  **OR** GC Technical), never both. The audit engine consumes each course once;
  apply this allocation by hand.
