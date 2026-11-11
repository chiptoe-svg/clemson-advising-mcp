// Department PLANNING rules (when and with what a course may be taken):
// recorded in departments/<id>/rules.yaml, served by get-department-rules,
// and read by what-if-plan / get-program-graph, so the advisor and these
// tools apply one source. avoid_same_term is a warning only (Chip,
// 2026-11-11: GC 4060 + GC 4400 together is discouraged, not forbidden). The properties under test: every rule kind parses
// strictly (an unknown kind or a missing field is an error, never a rule
// silently skipped), GC's rules are what Chip recorded, and a department
// with none says so.
import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePlanningRules,
  planningRulesForProgram,
} from "../src/departments.ts";
import { __deptTools } from "../src/mcp-tools/department.ts";

const base = { text: "A sentence.", source: "Chip, 2026-11-11" };

test("each planning rule kind parses", () => {
  const rules = parsePlanningRules([
    { ...base, kind: "avoid_same_term", courses: ["GC 4060", "GC 4400"] },
    { ...base, kind: "same_term", courses: ["GC 4500", "COOP 2020"] },
    {
      ...base,
      kind: "at_most_in_season",
      season: "summer",
      n: 1,
      groups: [
        ["GC 3500", "COOP 2010"],
        ["GC 4500", "COOP 2020"],
      ],
    },
    { ...base, kind: "before", first: ["GC 3500"], then: ["GC 4500"] },
    {
      ...base,
      kind: "term_load",
      when_any: ["GC 3500"],
      not_counted: ["GC 3500"],
      max_other_credits: 6,
      preferred_other_credits: 3,
    },
    {
      ...base,
      kind: "term_excludes",
      when_any: ["GC 3500"],
      courses: ["GC 1040"],
    },
  ]);
  assert.deepEqual(
    rules.map((r) => r.kind),
    [
      "avoid_same_term",
      "same_term",
      "at_most_in_season",
      "before",
      "term_load",
      "term_excludes",
    ],
  );
  assert.equal(rules[0].text, "A sentence.");
  assert.equal(rules[0].source, "Chip, 2026-11-11");
});

test("an unknown kind is an error naming it — never skipped", () => {
  assert.throws(
    () => parsePlanningRules([{ ...base, kind: "same_week" }]),
    /planning rule 1: unknown kind "same_week"/,
  );
});

test("a rule without its sentence or its source is an error", () => {
  assert.throws(
    () =>
      parsePlanningRules([
        {
          kind: "avoid_same_term",
          source: "x",
          courses: ["GC 4060", "GC 4400"],
        },
      ]),
    /planning rule 1: text/,
  );
  assert.throws(
    () =>
      parsePlanningRules([
        { kind: "avoid_same_term", text: "x", courses: ["GC 4060", "GC 4400"] },
      ]),
    /planning rule 1: source/,
  );
});

test("a malformed field is an error, not a looser rule", () => {
  // A misspelt code would match nothing and quietly stop constraining.
  assert.throws(
    () =>
      parsePlanningRules([
        { ...base, kind: "avoid_same_term", courses: ["GC4060", "GC 4400"] },
      ]),
    /planning rule 1: courses/,
  );
  assert.throws(
    () =>
      parsePlanningRules([
        { ...base, kind: "avoid_same_term", courses: ["GC 4060"] },
      ]),
    /at least two/,
  );
  assert.throws(
    () =>
      parsePlanningRules([
        {
          ...base,
          kind: "at_most_in_season",
          season: "winter",
          n: 1,
          groups: [["GC 3500"], ["GC 4500"]],
        },
      ]),
    /planning rule 1: season/,
  );
  assert.throws(
    () =>
      parsePlanningRules([
        { ...base, kind: "before", first: ["GC 3500"], then: [] },
      ]),
    /planning rule 1: then/,
  );
  assert.throws(
    () =>
      parsePlanningRules([
        {
          ...base,
          kind: "term_load",
          when_any: ["GC 3500"],
          not_counted: [],
          max_other_credits: "six",
          preferred_other_credits: 3,
        },
      ]),
    /planning rule 1: max_other_credits/,
  );
  assert.throws(() => parsePlanningRules("rules"), /planning must be a list/);
});

test("absent planning is an empty list — a department with none recorded", () => {
  assert.deepEqual(parsePlanningRules(undefined), []);
});

test("GC's recorded planning rules are served with their sentences and sources", async () => {
  const res = await __deptTools.departmentRules.handler({ department: "gc" });
  assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]));
  const b = JSON.parse((res.content[0] as { text: string }).text) as {
    planning: {
      kind: string;
      text: string;
      source: string;
      courses?: string[];
      first?: string[];
      then?: string[];
    }[];
  };
  const kinds = b.planning.map((r) => r.kind).sort();
  assert.deepEqual(kinds, [
    "at_most_in_season",
    "avoid_same_term",
    "before",
    "before",
    "before",
    "same_term",
    "same_term",
    "term_excludes",
    "term_load",
  ]);
  for (const r of b.planning) {
    assert.ok(r.text.length > 10, `${r.kind} has a sentence`);
    assert.ok(r.source.length > 5, `${r.kind} names its source`);
  }
  const excl = b.planning.find((r) => r.kind === "term_excludes")!;
  assert.deepEqual([...excl.courses!].sort(), [
    "GC 1040",
    "GC 2070",
    "GC 3400",
    "GC 4060",
    "GC 4070",
    "GC 4400",
    "GC 4440",
  ]);
  const order = b.planning.filter((r) => r.kind === "before");
  assert.ok(
    order.some(
      (r) => r.first!.includes("GC 3500") && r.then!.includes("GC 4500"),
    ),
    "the first internship comes before the second",
  );
  assert.ok(
    order.some(
      (r) =>
        r.first!.includes("GC 4500") &&
        ["GC 4440", "GC 4480", "GC 4800"].every((c) => r.then!.includes(c)),
    ),
    "GC 4440, 4480 and 4800 come after the second internship",
  );
  assert.ok(
    order.some(
      (r) =>
        ["GC 4060", "GC 4400"].every((c) => r.first!.includes(c)) &&
        r.then!.includes("GC 4500"),
    ),
    "GC 4060 or GC 4400 comes before the second internship",
  );
});

test("a department with no planning rules says so", async () => {
  const res = await __deptTools.departmentRules.handler({
    department: "marketing",
  });
  const b = JSON.parse((res.content[0] as { text: string }).text) as {
    planning: unknown[];
    planning_note?: string;
  };
  assert.deepEqual(b.planning, []);
  assert.match(String(b.planning_note), /no planning rules/i);
});

test("planning rules are found by program name", () => {
  const gc = planningRulesForProgram("Graphic Communications, BS");
  assert.ok(gc.some((r) => r.kind === "avoid_same_term"));
  assert.deepEqual(planningRulesForProgram("Marketing, BS"), []);
});
