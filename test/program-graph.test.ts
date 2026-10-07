// The program graph, from hand-built inputs (no DB). A major x catalog year:
// requirement nodes, course nodes, prerequisite edges from reviewed
// expressions. Properties under test: chain bounds and the critical path; a
// stale expression is never used; status is eligible / conditional /
// not_eligible / undetermined with its reasons; grade minimums and standing;
// requirement fallback when Degree Works has no import; and the published-plan
// witness.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  buildProgramGraph,
  planOrderViolations,
  type CourseFacts,
  type GraphInputs,
  type Standing,
  type StudentState,
} from "../src/program-graph.ts";

const hash = (s: string) =>
  crypto.createHash("sha256").update(s, "utf8").digest("hex");

function facts(code: string, expr: string | null = null): CourseFacts {
  return {
    code,
    title: `${code} title`,
    prereqText: expr,
    expr,
    exprHash: expr === null ? null : hash(expr),
    flatPrereq: [],
    coreqs: [],
  };
}

/** Keep prereqText, expr and exprHash consistent (not "stale"). */
function setExpr(inp: GraphInputs, code: string, expr: string, text = expr) {
  const f = inp.courses.get(code) ?? facts(code);
  f.expr = expr;
  f.prereqText = text;
  f.exprHash = hash(text);
  inp.courses.set(code, f);
}

const item = (over: Record<string, unknown>) => ({
  kind: "fixed_course",
  course_code: null,
  one_of: [],
  slot_type: null,
  credits: 3,
  footnote_refs: [],
  ...over,
});

function inputs(): GraphInputs {
  const courses = new Map<string, CourseFacts>();
  for (const f of [
    facts("GC 1020"),
    facts("GC 1040", "GC 1020"),
    facts("GC 1050"),
    facts("GC 3400", "GC 1020 & GC 1040"),
    facts("STAT 2300"),
    facts("STAT 3300", "(MATH 3020 | STAT 2300>=C)"),
    facts("MATH 3020"),
  ])
    courses.set(f.code, f);
  return {
    program: "Graphic Communications, BS",
    catalogYear: "2026-2027",
    registrar: { audit_date: null, requirements: [] },
    courses,
    plan: {
      name: "Graphic Communications, BS",
      total_credits: 120,
      description: null,
      source_url: null,
      footnotes: [],
      groups: [
        {
          label: "Freshman/Fall",
          kind: "term",
          credit_total: null,
          items: [item({ course_code: "GC 1020" })],
        },
        {
          label: "Freshman/Spring",
          kind: "term",
          credit_total: null,
          items: [
            item({ course_code: "GC 1040" }),
            item({ course_code: "GC 1050" }),
            item({ kind: "choice", one_of: ["STAT 2300", "STAT 3300"] }),
          ],
        },
        {
          label: "Sophomore/Fall",
          kind: "term",
          credit_total: null,
          items: [
            item({ course_code: "GC 3400" }),
            item({ kind: "slot", slot_type: "Elective" }),
          ],
        },
      ],
    } as GraphInputs["plan"],
  };
}

const student = (
  done: Record<string, string | null>,
  standing?: Standing,
): StudentState => ({
  completed: new Map(Object.entries(done)),
  ...(standing ? { standing } : {}),
});

const course = (g: ReturnType<typeof buildProgramGraph>, code: string) =>
  g.courses.find((x) => x.code === code)!;

test("chain, required_by / one_way_into and critical path", () => {
  const g = buildProgramGraph(inputs());
  assert.equal(course(g, "GC 3400").min_prior_terms, 2);
  assert.equal(course(g, "GC 1020").required_by, 2);
  assert.equal(course(g, "STAT 2300").required_by, 0);
  assert.equal(course(g, "STAT 2300").one_way_into, 1);
  assert.deepEqual(g.critical_path, ["GC 1020", "GC 1040", "GC 3400"]);
});

test("a stale expression is not used", () => {
  const inp = inputs();
  inp.courses.get("GC 3400")!.prereqText =
    "GC 1020 and GC 1040 and junior standing";
  const c = course(buildProgramGraph(inp), "GC 3400");
  assert.equal(c.parse, "stale");
  assert.equal(c.prereq, null);
  assert.equal(c.prereq_text, "GC 1020 and GC 1040 and junior standing");
  assert.equal(c.min_prior_terms, 0);
});

test("status: eligible / not_eligible, completed courses carry none", () => {
  const g = buildProgramGraph(inputs(), student({ "GC 1020": null }));
  assert.equal(course(g, "GC 1040").status, "eligible");
  assert.equal(course(g, "GC 3400").status, "not_eligible");
  assert.equal(course(g, "GC 1020").status, undefined);
});

test("conditional: coursework met, a non-course condition remains", () => {
  const inp = inputs();
  setExpr(inp, "GC 3400", "GC 1020 & GC 1040 & [consent:instructor]");
  const c = course(
    buildProgramGraph(inp, student({ "GC 1020": null, "GC 1040": null })),
    "GC 3400",
  );
  assert.equal(c.status, "conditional");
  assert.deepEqual(c.unresolved, ["[consent:instructor]"]);
});

test("undetermined only when the rule itself cannot be read", () => {
  const inp = inputs();
  setExpr(inp, "GC 3400", 'GC 1020 & ?"six credits of 4000-level GC courses"');
  const c = course(
    buildProgramGraph(inp, student({ "GC 1020": null })),
    "GC 3400",
  );
  assert.equal(c.status, "undetermined");
  assert.deepEqual(c.unresolved, ['?"six credits of 4000-level GC courses"']);
});

test("same-term prerequisite: eligible with take_with, not undetermined", () => {
  const inp = inputs();
  setExpr(inp, "GC 3400", "GC 1020 & ~GC 1040");
  const c = course(
    buildProgramGraph(inp, student({ "GC 1020": null })),
    "GC 3400",
  );
  assert.equal(c.status, "eligible");
  assert.deepEqual(c.take_with, ["GC 1040"]);
});

test("grade minimums: a known low grade blocks, an unknown grade is an explicit assumption", () => {
  const inp = inputs();
  setExpr(inp, "GC 1040", "GC 1020>=C");
  const low = course(
    buildProgramGraph(inp, student({ "GC 1020": "D" })),
    "GC 1040",
  );
  assert.equal(low.status, "not_eligible");
  const unk = course(
    buildProgramGraph(inp, student({ "GC 1020": null })),
    "GC 1040",
  );
  assert.equal(unk.status, "eligible");
  assert.deepEqual(unk.assumes, ["C or better in GC 1020"]);
});

test("standing: resolved when given, a timing floor from plan labels either way", () => {
  const inp = inputs();
  setExpr(inp, "GC 3400", "GC 1020 & [standing:sophomore]");
  assert.equal(course(buildProgramGraph(inp), "GC 3400").min_prior_terms, 2);
  const g1 = buildProgramGraph(inp, student({ "GC 1020": null }, "freshman"));
  assert.equal(course(g1, "GC 3400").status, "not_eligible");
  const g2 = buildProgramGraph(inp, student({ "GC 1020": null }));
  assert.equal(course(g2, "GC 3400").status, "conditional");
});

test("no Degree Works import falls back to plan slots and choices, and says so", () => {
  const g = buildProgramGraph(inputs());
  assert.equal(g.requirement_source, "catalog_plan");
  assert.ok(g.requirements.some((r) => r.name === "Elective"));
  assert.ok(g.requirements.some((r) => r.courses.includes("STAT 3300")));
  assert.ok(g.notes.some((n) => /No Degree Works import/.test(n)));
});

test("Degree Works requirements become nodes, and courses point at them", () => {
  const inp = inputs();
  inp.registrar = {
    audit_date: "2026-09-01",
    requirements: [
      {
        display_name: "Statistics",
        need: 1,
        unit: "classes",
        courses: ["STAT 2300", "STAT 3300"],
        wildcards: [],
        alternatives: [],
      },
    ],
  };
  const g = buildProgramGraph(inp);
  assert.equal(g.requirement_source, "degree_works");
  assert.deepEqual(course(g, "STAT 3300").requirements, ["Statistics"]);
});

test("a referenced course with no catalog row and a cycle neither crash", () => {
  const inp = inputs();
  setExpr(inp, "GC 1040", "GC 1020 & MKT 4200"); // MKT 4200: no course row
  setExpr(inp, "GC 1020", "GC 3400"); // cycle GC 1020 -> GC 3400 -> GC 1020
  const g = buildProgramGraph(inp);
  assert.ok(
    g.notes.some((n) => /MKT 4200 is not in the course catalog/.test(n)),
  );
  assert.ok(g.notes.some((n) => /cycle broken/.test(n)));
});

test("the witness finds an ordering violation; a same-term concurrent leaf is fine", () => {
  const before = inputs();
  setExpr(before, "GC 1020", "GC 1040"); // Fall needs a Spring course
  assert.equal(planOrderViolations(before, "parsed").length, 1);

  const same = inputs();
  setExpr(same, "GC 1050", "GC 1040"); // same term, not concurrent
  assert.equal(planOrderViolations(same, "parsed").length, 1);
  setExpr(same, "GC 1050", "~GC 1040"); // same term, may be taken alongside
  assert.equal(planOrderViolations(same, "parsed").length, 0);
});

test("the critical path is the longest prerequisite CHAIN, not a standing floor", () => {
  // Real case (GC 2026-27): GC 4800 needs only senior standing, so its floor
  // (the first Senior term) beat every real chain and the path was just
  // ["GC 4800"]. A floor is a timing bound, not a chain of courses.
  const inp = inputs();
  inp.plan.groups.push({
    label: "Senior/Fall",
    kind: "term",
    credit_total: null,
    items: [item({ course_code: "GC 4800" })],
  } as GraphInputs["plan"]["groups"][number]);
  setExpr(inp, "GC 4800", "[standing:senior]");
  const g = buildProgramGraph(inp);
  assert.equal(course(g, "GC 4800").min_prior_terms, 3);
  assert.deepEqual(g.critical_path, ["GC 1020", "GC 1040", "GC 3400"]);
});
