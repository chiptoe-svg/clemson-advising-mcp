// test/prereq-expr.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  PrereqSyntaxError,
  courseCodes,
  evaluate,
  isComplete,
  minPriorTerms,
  parsePrereq,
  renderPrereq,
  requiredCodes,
  unresolved,
  type EvalCtx,
} from "../src/prereq-expr.ts";

test("parses a course with a grade minimum", () => {
  assert.deepEqual(parsePrereq("ACCT 2010>=C"), {
    t: "course",
    code: "ACCT 2010",
    concurrent: false,
    minGrade: "C",
  });
});

test("parses nested and/or with concurrency and conditions", () => {
  const e = parsePrereq(
    "GC 3500 & (GC 4060 | GC 4400) & ~COOP 2020 & [major:Graphic Communications]",
  );
  assert.equal(e.t, "and");
  assert.deepEqual(courseCodes(e), [
    "GC 3500",
    "GC 4060",
    "GC 4400",
    "COOP 2020",
  ]);
  const coop = (e as { of: unknown[] }).of[2];
  assert.deepEqual(coop, { t: "course", code: "COOP 2020", concurrent: true });
});

test("~ on a group marks every course leaf inside it concurrent", () => {
  const e = parsePrereq("~(MATH 1020 | STAT 2300)");
  assert.equal(renderPrereq(e), "~MATH 1020 | ~STAT 2300");
});

test("mixing & and | at one level is a syntax error, never a guessed precedence", () => {
  assert.throws(
    () => parsePrereq("GC 1010 & GC 1020 | GC 1040"),
    PrereqSyntaxError,
  );
});

test("rejects unknown condition kinds, trailing input and lowercase codes", () => {
  assert.throws(() => parsePrereq("[gpa:3.0]"), PrereqSyntaxError);
  assert.throws(() => parsePrereq("GC 1010 )"), PrereqSyntaxError);
  assert.throws(() => parsePrereq("gc 1010"), PrereqSyntaxError);
});

test("render round-trips", () => {
  for (const s of [
    "ACCT 2010>=C & (CPSC 2200 | MGT 2180)",
    "(MATH 1060>=C | MATH 1070>=C)",
    "[test:CMPT>=60] & (~MATH 1020 | ~STAT 2300)",
    '(?"Any MATH or STAT course" | [test:SAT Math>=620])',
    "[standing:junior]",
  ]) {
    assert.deepEqual(
      parsePrereq(renderPrereq(parsePrereq(s))),
      parsePrereq(s),
      s,
    );
  }
});

test("requiredCodes: a code inside an OR is not required unless every branch has it", () => {
  assert.deepEqual(
    requiredCodes(parsePrereq("GC 3500 & (GC 4060 | GC 4400)")),
    ["GC 3500"],
  );
  assert.deepEqual(
    requiredCodes(parsePrereq("(MATH 3020 | STAT 2300>=C)")),
    [],
  );
  assert.deepEqual(
    requiredCodes(
      parsePrereq("(PKSC 1020 & PKSC 2010) | (PKSC 1020 & FDSC 4170)"),
    ),
    ["PKSC 1020"],
  );
});

test("isComplete is false only when an unknown leaf is present", () => {
  assert.equal(isComplete(parsePrereq("GC 1020 & [standing:junior]")), true);
  assert.equal(
    isComplete(
      parsePrereq('MKT 3010 & ?"six credits of 4000-level marketing courses"'),
    ),
    false,
  );
});

const done = (codes: string[]): EvalCtx => ({
  course: (l) => (codes.includes(l.code) ? "T" : "F"),
  cond: () => "U",
  unknown: () => "U",
});

test("Kleene evaluation: an OR with one true branch is true despite unknowns", () => {
  const e = parsePrereq('(MATH 1020 | ?"Any MATH or STAT course")');
  assert.equal(evaluate(e, done(["MATH 1020"])), "T");
  assert.equal(evaluate(e, done([])), "U");
});

test("Kleene evaluation: an AND with one false branch is false despite unknowns", () => {
  const e = parsePrereq("GC 1020 & [standing:junior]");
  assert.equal(evaluate(e, done([])), "F");
  assert.equal(evaluate(e, done(["GC 1020"])), "U");
  assert.deepEqual(unresolved(e, done(["GC 1020"])), ["[standing:junior]"]);
});

test("minPriorTerms: AND takes the max, OR the min, concurrent adds no term", () => {
  const chain: Record<string, number> = {
    "GC 1040": 1,
    "GC 1020": 0,
    "STAT 2300": 0,
    "MATH 3020": 2,
  };
  const of = (c: string) => chain[c] ?? 0;
  assert.equal(minPriorTerms(parsePrereq("GC 1020 & GC 1040"), of), 2);
  assert.equal(minPriorTerms(parsePrereq("(MATH 3020 | STAT 2300>=C)"), of), 1);
  assert.equal(minPriorTerms(parsePrereq("~GC 1040"), of), 1);
  assert.equal(minPriorTerms(parsePrereq("[standing:senior]"), of), 0);
});
