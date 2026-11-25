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

// Hostile review, 2026-11-25.
test("review 1: every listed course done but a consent / standing / major gate left is undetermined", () => {
  for (const text of [
    "GC 3500 and consent",
    "Senior standing and AGRB 2080",
    "ED 3000 and admission to the professional level",
  ]) {
    const codes = text.match(/[A-Z]{2,5} \d{4}/g)!;
    const r = prereqEligibility(flat(text, codes), student(codes));
    assert.equal(r.prereq_eligibility, "undetermined", text);
    assert.match(r.reason ?? "", /cannot check/, text);
  }
});

test("review 1: a grade minimum on finished courses is eligible, with the assumption said", () => {
  const text = "AGRB 2080 with a grade of C or higher";
  const r = prereqEligibility(
    flat(text, ["AGRB 2080"]),
    student(["AGRB 2080"]),
  );
  assert.equal(r.prereq_eligibility, "eligible");
  assert.deepEqual(r.assumes, [`grade minimum met: ${text}`]);
});

test("review 2: a course missing from the catalog is undetermined, never eligible", () => {
  const r = prereqEligibility(null, T10G);
  assert.equal(r.prereq_eligibility, "undetermined");
  assert.match(r.reason ?? "", /not in the catalog/);
});

test("review 3: alternatives written without 'or' are undetermined, not a no", () => {
  const text =
    "ART 1510 and ART 1530 and ART 3060 (Visual Arts majors); ART 1030 (non- Art Majors)";
  const r = prereqEligibility(
    flat(text, ["ART 1510", "ART 1530", "ART 3060", "ART 1030"]),
    student(["ART 1030"]),
  );
  assert.equal(r.prereq_eligibility, "undetermined");
});

test("review 4: an OR that fails says one way is enough", () => {
  const r = prereqEligibility(
    reviewed("GC 1010 or GC 1020 and GC 1040", "GC 1010 | (GC 1020 & GC 1040)"),
    student(["GC 1020"]),
  );
  assert.equal(r.prereq_eligibility, "not_eligible");
  assert.match(r.reason ?? "", /one of the ways/);
});

test("review 6: missing lists each course once", () => {
  const r = prereqEligibility(flat("GC 3700", ["GC 3700", "GC 3700"]), T10G);
  assert.deepEqual(r.missing, ["GC 3700"]);
});

test("every listed course done meets a pure OR of courses", () => {
  const text =
    "AGRB 2020 with a grade of C or higher or ECON 2110 with a grade of C or higher";
  const r = prereqEligibility(
    flat(text, ["AGRB 2020", "ECON 2110"]),
    student(["AGRB 2020", "ECON 2110"]),
  );
  assert.equal(r.prereq_eligibility, "eligible");
  // A partial match on the same OR is still undecidable from the list.
  const p = prereqEligibility(
    flat(text, ["AGRB 2020", "ECON 2110"]),
    student(["AGRB 2020"]),
  );
  assert.equal(p.prereq_eligibility, "undetermined");
});
