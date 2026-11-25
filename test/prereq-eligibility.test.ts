// Prerequisite eligibility for find-alternatives (Cob_advisor T10g,
// 2026-11-25): three-valued, never a silent pass. "undetermined" is a real
// answer — the rule cannot be decided from what is known — and an in-progress
// prerequisite makes a course undetermined (pending), never a yes or a no.
import assert from "node:assert/strict";
import test from "node:test";

import {
  prereqEligibility,
  type CourseRuleFacts,
  type StudentCourses,
} from "../src/prereq-eligibility.ts";

const student = (
  completed: string[],
  inProgress: string[] = [],
  sameTerm: string[] = [],
): StudentCourses => ({
  completed: new Set(completed),
  inProgress: new Set(inProgress),
  sameTerm: new Set(sameTerm),
});
const flat = (
  text: string | null,
  codes: string[] | null,
): CourseRuleFacts => ({
  prereqText: text,
  flat: codes,
  reviewed: null,
});
const reviewed = (text: string, expr: string): CourseRuleFacts => ({
  prereqText: text,
  flat: null,
  reviewed: expr,
});

// T10g, with the catalog's own wording for the three courses.
const T10G = student(["GC 1010", "GC 1020", "GC 1040", "GC 1050", "GC 2070"]);

test("T10g: GC 3730 needs GC 3700 she has not taken", () => {
  assert.deepEqual(prereqEligibility(flat("GC 3700", ["GC 3700"]), T10G), {
    prereq_eligibility: "not_eligible",
    missing: ["GC 3700"],
    prereq_text: "GC 3700",
  });
});

test("T10g: GC 3460 needs GC 2070 she has finished", () => {
  assert.deepEqual(prereqEligibility(flat("GC 2070", ["GC 2070"]), T10G), {
    prereq_eligibility: "eligible",
  });
});

test("T10g: GC 3450 — being enrolled in GC 3400 this term is not having it", () => {
  const s = student([...T10G.completed], ["GC 3400"], ["GC 3400"]);
  assert.deepEqual(prereqEligibility(flat("GC 3400", ["GC 3400"]), s), {
    prereq_eligibility: "not_eligible",
    missing: ["GC 3400"],
    prereq_text: "GC 3400",
  });
});

test("an in-progress prerequisite from an earlier term is pending, not a yes or a no", () => {
  const s = student(["GC 1020"], ["GC 3400"]);
  assert.deepEqual(prereqEligibility(flat("GC 3400", ["GC 3400"]), s), {
    prereq_eligibility: "undetermined",
    pending: ["GC 3400"],
    reason: "eligible if GC 3400 is passed",
    prereq_text: "GC 3400",
  });
});

test("one prerequisite in progress and one never taken is a no, naming only the untaken one", () => {
  const s = student([], ["GC 1020"]);
  const r = prereqEligibility(
    flat("GC 1020 and GC 1040", ["GC 1020", "GC 1040"]),
    s,
  );
  assert.equal(r.prereq_eligibility, "not_eligible");
  assert.deepEqual(r.missing, ["GC 1040"]);
});

test("no stated prerequisite is eligible; stated but unparsed is undetermined", () => {
  assert.equal(
    prereqEligibility(flat(null, null), T10G).prereq_eligibility,
    "eligible",
  );
  const r = prereqEligibility(flat("Sophomore standing", null), T10G);
  assert.equal(r.prereq_eligibility, "undetermined");
  assert.equal(r.prereq_text, "Sophomore standing");
});

test("flat text with OR / grade / standing wording is undetermined, not a no", () => {
  const r = prereqEligibility(
    flat("GC 3400 or GC 3700", ["GC 3400", "GC 3700"]),
    T10G,
  );
  assert.equal(r.prereq_eligibility, "undetermined");
});

test("reviewed rule: an OR is met by either branch", () => {
  const r = prereqEligibility(
    reviewed("GC 3400 or GC 2070", "GC 3400 | GC 2070"),
    T10G,
  );
  assert.deepEqual(r, { prereq_eligibility: "eligible" });
});

test("reviewed rule: a concurrent leaf is met by a same-term course", () => {
  const s = student([], [], ["ACCT 2010"]);
  assert.deepEqual(
    prereqEligibility(
      reviewed("ACCT 2010 (may be concurrent)", "~ACCT 2010"),
      s,
    ),
    { prereq_eligibility: "eligible" },
  );
});

test("reviewed rule: a standing gate it cannot see is undetermined with the reason", () => {
  const r = prereqEligibility(
    reviewed(
      "Junior standing and consent of instructor",
      "[standing:junior] & [consent:instructor]",
    ),
    T10G,
  );
  assert.equal(r.prereq_eligibility, "undetermined");
  assert.match(r.reason ?? "", /Junior standing and consent/);
});

test("reviewed rule: a missing course outweighs an unknown condition", () => {
  const r = prereqEligibility(
    reviewed("GC 3700 and junior standing", "GC 3700 & [standing:junior]"),
    T10G,
  );
  assert.equal(r.prereq_eligibility, "not_eligible");
  assert.deepEqual(r.missing, ["GC 3700"]);
});

test("reviewed rule: a grade minimum on a completed course is assumed and said", () => {
  const r = prereqEligibility(
    reviewed("ACCT 2010 with a C or better", "ACCT 2010>=C"),
    student(["ACCT 2010"]),
  );
  assert.equal(r.prereq_eligibility, "eligible");
  assert.deepEqual(r.assumes, ["C or better in ACCT 2010"]);
});
