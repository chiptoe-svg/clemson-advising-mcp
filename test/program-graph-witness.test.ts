// test/program-graph-witness.test.ts
// The published plan is a witness: Clemson's own semester sequence must never
// schedule a course before a prerequisite it cannot be taken alongside. The
// flat code list (course.prereq_parsed) FAILS this — that is the proof the
// check can see a real violation — and the reviewed expressions must pass it.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { loadGraphInputs, planOrderViolations } from "../src/program-graph.ts";

const db = new Database(
  path.resolve(import.meta.dirname, "../core/db/catalog.db"),
  { readonly: true },
);
const programYears = db
  .prepare(
    `SELECT DISTINCT y.label AS year, p.name AS program
       FROM program p JOIN catalog_year y ON y.id = p.catalog_year_id
       JOIN requirement_group g ON g.program_id = p.id
       JOIN plan_item i ON i.group_id = g.id
      ORDER BY y.label, p.name`,
  )
  .all() as { year: string; program: string }[];

test("there are published plans to check", () => {
  assert.ok(programYears.length >= 41, `only ${programYears.length}`);
});

test("the flat code list DOES contradict published plans (the check has teeth)", () => {
  const v = programYears.flatMap(({ year, program }) =>
    planOrderViolations(loadGraphInputs(db, year, program), "flat"),
  );
  assert.ok(v.length > 0);
});

test("the reviewed expressions contradict no published plan", () => {
  const v = programYears.flatMap(({ year, program }) =>
    planOrderViolations(loadGraphInputs(db, year, program), "parsed"),
  );
  assert.deepEqual(v, []);
});
