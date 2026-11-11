// test/plan-whatif.test.ts
// "What happens to graduation if the plan changes?" computed, not left to
// the model. Cob_advisor T8b (2026-10-20): every trial had the graph and still
// misread it (Spark 1/8, RCD 27B 5/8). Properties: pushes follow reviewed
// prerequisite expressions (& max, | min, ~ same term); corequisites move
// together; seasons are respected; summers are skipped for regular courses;
// skipped terms displace their courses; an earlier move is checked, never
// pushed; bad input is an error and bad data never hangs.
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { CATALOG_DB } from "../src/config-mcp.ts";
import { buildProgramGraph, loadGraphInputs } from "../src/program-graph.ts";

import {
  labelOf,
  slackTerms,
  slotOf,
  whatIf,
  type PlanChange,
  type SeasonLabels,
} from "../src/plan-whatif.ts";
import type { GraphCourse, ProgramGraph } from "../src/program-graph.ts";
import type { PlanningRule } from "../src/departments.ts";

// The prerequisite parser accepts only real course codes (SUBJ NNNN), so the
// letter names below are written as "D" -> "DD 1000", "DL" -> "DL 1000".
const code = (x: string) => `${x.length === 1 ? x + x : x} 1000`;
const back = (c: string) => {
  const s = c.replace(/ 1000$/, "");
  return s.length === 2 && s[0] === s[1] ? s[0] : s;
};
const codes = (p: string) => p.replace(/\b[A-Z]{1,2}\b/g, (t) => code(t));

function course(
  name: string,
  planned: string | null,
  prereq: string | null = null,
  extra: Partial<GraphCourse> = {},
): GraphCourse {
  return {
    code: code(name),
    title: name,
    planned,
    requirements: [],
    prereq: prereq === null ? null : codes(prereq),
    parse: prereq ? "complete" : "none",
    min_prior_terms: 0,
    required_by: 0,
    one_way_into: 0,
    ...extra,
    ...(extra.coreqs ? { coreqs: extra.coreqs.map(code) } : {}),
    ...(extra.prereq_text ? { prereq_text: codes(extra.prereq_text) } : {}),
  };
}

function graph(courses: GraphCourse[], critical: string[] = []): ProgramGraph {
  return {
    program: "Test, BS",
    catalog_year: "2026-2027",
    requirement_source: "catalog_plan",
    requirements: [],
    courses,
    critical_path: critical.map(code),
    critical_courses: critical.map(code),
    critical_paths: [critical.map(code)],
    critical_paths_total: 1,
    choices: [],
    notes: [],
  };
}

const TERMS = [
  "Freshman/First Semester",
  "Freshman/Second Semester",
  "Sophomore/First Semester",
  "Sophomore/Second Semester",
  "Junior/First Semester",
  "Junior/Second Semester",
  "Senior/First Semester",
  "Senior/Second Semester",
];

// Slots: Fr 0,1  So 3,4  Jr 6,7  Sr 9,10 (summers 2,5,8,11 unused).
const BASE = () =>
  graph(
    [
      course("A", "Freshman/First Semester"),
      course("B", "Sophomore/First Semester", "A"),
      course("C", "Senior/Second Semester", "B"),
      course("D", "Junior/First Semester", null, { coreqs: ["DL"] }),
      course("DL", "Junior/First Semester"),
      course("E", "Senior/First Semester", "D"),
      course("G", "Senior/Second Semester", "(D | A)"),
      course("H", "Senior/First Semester", "~D"),
    ],
    ["A", "B", "C"],
  );
const none = new Set<string>();
const run = (
  g: ProgramGraph,
  changes: PlanChange[],
  opts: {
    completed?: Set<string>;
    seasons?: Map<string, SeasonLabels>;
    terms?: string[];
  } = {},
) =>
  whatIf(
    g,
    opts.terms ?? TERMS,
    {
      changes: changes.map((c) =>
        "course" in c ? { ...c, course: code(c.course) } : c,
      ),
      completed: new Set([...(opts.completed ?? none)].map(code)),
    },
    opts.seasons &&
      new Map([...opts.seasons].map(([k, v]) => [code(k), v] as const)),
  );
const moved = (r: { moves: { code: string; to: string }[] }) =>
  Object.fromEntries(r.moves.map((m) => [back(m.code), m.to]));

test("slots: labels map to calendar order; Pre-Business is the same year; unknown labels are null", () => {
  assert.equal(slotOf("Freshman/First Semester"), 0);
  assert.equal(slotOf("Pre-Business Freshman/Second Semester"), 1);
  assert.equal(slotOf("Junior/Summer"), 8);
  assert.equal(slotOf("Senior/First Semester"), 9);
  assert.equal(slotOf("Fall 2026"), null);
  assert.equal(labelOf(12), "Fifth Year/First Semester");
});

test("delay off the critical path: dependents absorb it, corequisite moves along, graduation holds", () => {
  const r = run(BASE(), [{ course: "D", delayTerms: 2 }]);
  assert.deepEqual(moved(r), {
    D: "Senior/First Semester",
    DL: "Senior/First Semester",
    E: "Senior/Second Semester",
  });
  assert.equal(r.slips_graduation, false);
  assert.deepEqual(r.on_critical_path, []);
  assert.match(r.verdict, /does not slip/);
});

test("a delay that pushes a dependent past the last term slips graduation; ~ allows the same term; | is satisfied by the other option", () => {
  const r = run(BASE(), [{ course: "D", delayTerms: 3 }]);
  const m = moved(r);
  assert.equal(m.D, "Senior/Second Semester");
  assert.equal(m.E, "Fifth Year/First Semester");
  assert.equal(m.H, "Senior/Second Semester");
  assert.equal(m.G, undefined);
  assert.equal(r.slips_graduation, true);
  assert.equal(r.new_graduation_term, "Fifth Year/First Semester");
  assert.match(r.verdict, /slips/);
});

test("seasons: a dependent not offered in spring waits for fall", () => {
  const seasons = new Map<string, SeasonLabels>([
    [
      "E",
      { fall: "very likely", spring: "very unlikely", summer: "very unlikely" },
    ],
  ]);
  const r = run(BASE(), [{ course: "D", delayTerms: 2 }], { seasons });
  assert.equal(moved(r).E, "Fifth Year/First Semester");
  assert.equal(r.slips_graduation, true);
  assert.match(
    r.moves.find((x) => x.code === code("E"))!.because,
    /not usually offered in spring/,
  );
});

test("move_to a later term gives the same answer as the equivalent delay_terms", () => {
  const a = run(BASE(), [{ course: "D", delayTerms: 2 }]);
  const b = run(BASE(), [{ course: "D", moveTo: "Senior/First Semester" }]);
  assert.deepEqual(moved(a), moved(b));
});

test("moving earlier: allowed when prerequisites are met, nothing pushed", () => {
  const r = run(BASE(), [{ course: "E", moveTo: "Junior/Second Semester" }]);
  assert.deepEqual(moved(r), { E: "Junior/Second Semester" });
  assert.deepEqual(r.prereq_problems, []);
  assert.equal(r.slips_graduation, false);
});

test("moving earlier than a prerequisite allows is reported, never pushed back", () => {
  const r = run(BASE(), [{ course: "B", moveTo: "Freshman/First Semester" }]);
  assert.equal(moved(r).B, "Freshman/First Semester");
  assert.equal(r.prereq_problems.length, 1);
  assert.match(r.prereq_problems[0].problem, /needs A/);
  assert.match(r.verdict, /not possible as asked/i);
});

test("moving earlier into a season the course does not run is an error", () => {
  const seasons = new Map<string, SeasonLabels>([
    [
      "E",
      { fall: "very unlikely", spring: "very likely", summer: "very unlikely" },
    ],
  ]);
  assert.throws(
    () =>
      run(BASE(), [{ course: "E", moveTo: "Junior/First Semester" }], {
        seasons,
      }),
    /not usually offered in fall/,
  );
});

test("skipping a term displaces what was planned there", () => {
  const r = run(BASE(), [{ skipTerm: "Junior/First Semester" }]);
  assert.deepEqual(moved(r), {
    D: "Junior/Second Semester",
    DL: "Junior/Second Semester",
  });
  assert.match(
    r.moves.find((m) => m.code === code("D"))!.because,
    /Junior\/First Semester is skipped/,
  );
  assert.equal(r.slips_graduation, false);
});

test("skipping the last term slips graduation", () => {
  const r = run(BASE(), [{ skipTerm: "Senior/Second Semester" }]);
  assert.equal(moved(r).C, "Fifth Year/First Semester");
  assert.equal(r.slips_graduation, true);
});

test("skipping a term with nothing planned says so", () => {
  const r = run(BASE(), [{ skipTerm: "Sophomore/Second Semester" }]);
  assert.deepEqual(r.moves, []);
  assert.match(r.verdict, /nothing was planned in Sophomore\/Second Semester/i);
});

test("several changes at once", () => {
  const r = run(BASE(), [
    { course: "A", delayTerms: 1 },
    { course: "D", delayTerms: 2 },
  ]);
  const m = moved(r);
  assert.equal(m.A, "Freshman/Second Semester");
  assert.equal(m.E, "Senior/Second Semester");
  assert.equal(r.slips_graduation, false);
});

test("bad questions are errors", () => {
  assert.throws(() => run(BASE(), []), /changes is empty/);
  assert.throws(
    () => run(BASE(), [{ course: "D", moveTo: "Junior/First Semester" }]),
    /already planned in/,
  );
  assert.throws(
    () => run(BASE(), [{ course: "Z", delayTerms: 1 }]),
    /not in the/,
  );
  assert.throws(
    () =>
      run(BASE(), [{ course: "D", delayTerms: 1 }], {
        completed: new Set(["D"]),
      }),
    /already completed/,
  );
  assert.throws(
    () =>
      run(BASE(), [
        { course: "D", delayTerms: 1 },
        { course: "D", delayTerms: 2 },
      ]),
    /more than one change/,
  );
  assert.throws(() => run(BASE(), [{ course: "D" }]), /exactly one of/);
  assert.throws(
    () => run(BASE(), [{ skipTerm: "Fall 2026" }]),
    /not a recognised term/,
  );
});

test("a completed dependent never moves", () => {
  const r = run(BASE(), [{ course: "A", delayTerms: 2 }], {
    completed: new Set(["B"]),
  });
  assert.equal(moved(r).B, undefined);
});

test("unknown clauses on an affected course are reported, not guessed", () => {
  const g = BASE();
  g.courses.push(
    course("K", "Senior/First Semester", 'D & ?"department approval"'),
  );
  const r = run(g, [{ course: "D", delayTerms: 2 }]);
  assert.ok(
    r.unresolved.some((u) => /K/.test(u) && /department approval/.test(u)),
  );
});

test("an unreadable rule that names a moved course is reported", () => {
  const g = BASE();
  g.courses.push(
    course("U", "Senior/First Semester", null, {
      parse: "unparsed",
      prereq_text: "D or consent of instructor",
    }),
  );
  const r = run(g, [{ course: "D", delayTerms: 2 }]);
  assert.ok(
    r.unresolved.some((u) => /U/.test(u) && /could not be read/.test(u)),
  );
});

test("bad data (a prerequisite cycle) is an error, never a hang", () => {
  const g = graph([
    course("X", "Junior/First Semester", "Y"),
    course("Y", "Junior/Second Semester", "X"),
  ]);
  assert.throws(
    () => run(g, [{ course: "X", delayTerms: 1 }]),
    /could not place/,
  );
});

test("regular courses skip summers; summer-planned courses may use them", () => {
  const g = graph([
    course("R", "Junior/Second Semester"),
    course("I", "Junior/Summer"),
  ]);
  const terms = [...TERMS.slice(0, 6), "Junior/Summer", ...TERMS.slice(6)];
  assert.equal(
    moved(run(g, [{ course: "R", delayTerms: 1 }], { terms })).R,
    "Senior/First Semester",
  );
  assert.equal(
    moved(run(g, [{ course: "I", delayTerms: 1 }], { terms })).I,
    "Senior/First Semester",
  );
});

test("an unrecognised plan term label is an error, not a guess", () => {
  assert.throws(
    () =>
      run(BASE(), [{ course: "D", delayTerms: 1 }], {
        terms: [...TERMS, "Fall 2026"],
      }),
    /not a recognised term/,
  );
});

test("with no offering history, the every-fall-and-spring assumption is stated", () => {
  const r = run(BASE(), [{ course: "D", delayTerms: 2 }]);
  assert.ok(r.assumptions.some((a) => /every fall and spring/.test(a)));
  assert.match(r.caveat, /published/);
});

test("a choice option that moves is flagged and does not decide the verdict", () => {
  const g = graph([
    course("D", "Junior/First Semester"),
    course("J", "Senior/Second Semester", "D", { choice: true }),
  ]);
  const r = run(g, [{ course: "D", delayTerms: 3 }]);
  assert.equal(r.moves.find((m) => m.code === code("J"))!.only_if_chosen, true);
  assert.equal(r.slips_graduation, false);
  assert.match(r.verdict, /only if chosen/i);
});

test("slack: terms a course can slip before graduation does (cap 4)", () => {
  const g = BASE();
  const slack = (c: string) => slackTerms(g, TERMS, code(c), none);
  assert.equal(slack("C"), 0); // last term, on the critical path
  assert.equal(slack("E"), 1); // Senior/First -> Senior/Second only
  assert.equal(slack("D"), 2); // a third term pushes E past the end
  assert.equal(slack("A"), 4); // 4 = four or more
});

// Cob_advisor's T8b on the committed catalog.db: GC 3400 Junior fall -> the
// following fall (2 regular terms). Hand-checked 2026-10-20: GC 3400 is off
// the critical path; its only plan dependent is GC 4440, which moves Senior
// fall -> Senior spring.
test("T8b on real data: delaying GC 3400 two terms does not slip graduation", () => {
  const db = new Database(CATALOG_DB, { readonly: true, fileMustExist: true });
  try {
    const inp = loadGraphInputs(db, "2026-2027", "Graphic Communications, BS");
    const g = buildProgramGraph(inp);
    const r = whatIf(
      g,
      inp.plan.groups.map((x) => x.label),
      {
        changes: [{ course: "GC 3400", delayTerms: 2 }],
        completed: new Set(),
      },
    );
    const m = Object.fromEntries(r.moves.map((x) => [x.code, x.to]));
    assert.deepEqual(r.on_critical_path, []);
    assert.equal(m["GC 3400"], "Senior/First Semester");
    assert.equal(m["GC 4440"], "Senior/Second Semester");
    assert.equal(r.slips_graduation, false);
  } finally {
    db.close();
  }
});

// --- Final hostile review fixes (2026-10-21) ---------------------------------

const fallOnly: SeasonLabels = {
  fall: "very likely",
  spring: "very unlikely",
  summer: "very unlikely",
};

test("review 1: changing both members of a corequisite pair keeps them together, in either order", () => {
  // BIOL 1030 + BIOL 1050 each one term later put the lab two terms later.
  for (const changes of [
    [
      { course: "D", delayTerms: 1 },
      { course: "DL", delayTerms: 1 },
    ],
    [
      { course: "DL", delayTerms: 1 },
      { course: "D", delayTerms: 1 },
    ],
  ]) {
    const m = moved(run(BASE(), changes));
    assert.equal(m.D, "Junior/Second Semester", JSON.stringify(changes));
    assert.equal(m.DL, "Junior/Second Semester", JSON.stringify(changes));
  }
});

test("review 2: a corequisite carried along must be offered in the term it lands", () => {
  // BIOL 1060 (fall: very unlikely) was dragged into a fall term with BIOL 1040.
  const seasons = new Map<string, SeasonLabels>([["DL", fallOnly]]);
  const bothSpringOff = new Map<string, SeasonLabels>([
    [
      "DL",
      { fall: "very unlikely", spring: "very likely", summer: "very unlikely" },
    ],
  ]);
  const r = run(BASE(), [{ course: "D", delayTerms: 2 }], {
    seasons: bothSpringOff,
  });
  // D wants Senior/First (fall); DL is spring-only, so the pair goes together
  // to the first term both can use: Senior/Second.
  assert.equal(moved(r).D, "Senior/Second Semester");
  assert.equal(moved(r).DL, "Senior/Second Semester");
  assert.ok(seasons); // fallOnly fixture used below
});

test("review 3: move_to a later term the course cannot use is an error, not a silent relabel", () => {
  assert.throws(
    () => run(BASE(), [{ course: "D", moveTo: "Junior/Summer" }]),
    /cannot move to Junior\/Summer/,
  );
  assert.throws(
    () =>
      run(BASE(), [
        { skipTerm: "Senior/First Semester" },
        { course: "D", moveTo: "Senior/First Semester" },
      ]),
    /cannot move to Senior\/First Semester/,
  );
  const seasons = new Map<string, SeasonLabels>([["D", fallOnly]]);
  assert.throws(
    () =>
      run(BASE(), [{ course: "D", moveTo: "Junior/Second Semester" }], {
        seasons,
      }),
    /not usually offered in spring/,
  );
});

test("review 4: moving earlier than a class-standing rule allows is reported", () => {
  const g = BASE();
  g.courses.push(
    course("S", "Senior/Second Semester", null, {
      standing_floor: "Senior/First Semester",
    }),
  );
  const r = run(g, [{ course: "S", moveTo: "Junior/First Semester" }]);
  assert.ok(
    r.prereq_problems.some((p) => /standing/.test(p.problem)),
    JSON.stringify(r.prereq_problems),
  );
  assert.match(r.verdict, /not possible as asked/i);
});

test("review 5: a plan that never reaches a senior year has no graduation to slip", () => {
  const g = graph([course("F", "Pre-Business Freshman/First Semester")]);
  const terms = [
    "Pre-Business Freshman/First Semester",
    "Pre-Business Freshman/Second Semester",
  ];
  assert.throws(
    () => run(g, [{ course: "F", delayTerms: 1 }], { terms }),
    /does not reach/,
  );
  assert.equal(slackTerms(g, terms, code("F"), none), undefined);
});

test("review 6: a course not offered recently does not sink the answer; the assumption is stated", () => {
  // ENGL 3040 (fall/spring unlikely, summer uncertain) made Accounting
  // 2024-2025 what-ifs throw and gave it a false slack of 0.
  const seasons = new Map<string, SeasonLabels>([
    ["E", { fall: "unlikely", spring: "unlikely", summer: "uncertain" }],
  ]);
  const r = run(BASE(), [{ course: "D", delayTerms: 2 }], { seasons });
  assert.equal(moved(r).E, "Senior/Second Semester");
  assert.ok(
    r.assumptions.some(
      (a) => /E/.test(a) && /not been offered recently/.test(a),
    ),
    JSON.stringify(r.assumptions),
  );
});

test("review 6: slack is absent, never 0, when the engine cannot answer", () => {
  const g = graph([
    course("X", "Junior/First Semester", "Y"),
    course("Y", "Junior/Second Semester", "X"),
  ]);
  assert.equal(slackTerms(g, TERMS, code("X"), none), undefined);
});

test("review 7: the quoted verdict says why a course jumped further, and names an uncertain season", () => {
  const off = run(BASE(), [{ course: "D", delayTerms: 1 }], {
    seasons: new Map([["D", fallOnly]]),
  });
  assert.equal(moved(off).D, "Senior/First Semester");
  assert.match(off.verdict, /not usually offered in spring/);
  const risky = run(BASE(), [{ course: "D", delayTerms: 1 }], {
    seasons: new Map([
      [
        "D",
        { fall: "very likely", spring: "uncertain", summer: "very unlikely" },
      ],
    ]),
  });
  assert.match(risky.verdict, /uncertain/);
});

// current_term (Cob_advisor 2026-11-10): a student behind the plan. Courses
// planned before now and not completed move to the first term they can use
// at or after now; slack and graduation are then measured from there.
const runNow = (
  now: string,
  done: string[],
  changes: PlanChange[] = [],
  seasons?: Map<string, SeasonLabels>,
) =>
  whatIf(
    BASE(),
    TERMS,
    {
      changes: changes.map((c) =>
        "course" in c ? { ...c, course: code(c.course) } : c,
      ),
      completed: new Set(done.map(code)),
      now,
    },
    seasons && new Map([...seasons].map(([k, v]) => [code(k), v] as const)),
  );

test("current term: overdue courses move to now, and graduation that holds reports no slip", () => {
  const r = runNow("Junior/Second Semester", ["A", "B"]);
  assert.deepEqual(
    Object.fromEntries(r.behind!.map((m) => [back(m.code), m.to])),
    { D: "Junior/Second Semester", DL: "Junior/Second Semester" },
  );
  assert.equal(r.graduation_slip_terms, 0);
  assert.equal(r.plan_graduation_term, "Senior/Second Semester");
  assert.equal(r.graduation_term, "Senior/Second Semester");
  assert.equal(r.slips_graduation, false);
  assert.deepEqual(r.moves, []);
});

test("current term: a student already behind gets the slip, counted in fall/spring terms", () => {
  // B (So fall) overdue -> Sr spring, so C (needs B) -> Fifth Year fall.
  const r = runNow("Senior/Second Semester", ["A"]);
  assert.equal(r.graduation_term, "Fifth Year/First Semester");
  assert.equal(r.plan_graduation_term, "Senior/Second Semester");
  assert.equal(r.graduation_slip_terms, 1);
  assert.match(r.verdict, /already 1 term behind/i);
});

test("current term: a further delay is measured from the rebased plan, not the published one", () => {
  // D is overdue (Jr fall) and lands in Jr spring; one more term puts it in
  // Sr fall and E (needs D) in Sr spring: still on time. Two more is late.
  const one = runNow(
    "Junior/Second Semester",
    ["A", "B"],
    [{ course: "D", delayTerms: 1 }],
  );
  assert.equal(one.slips_graduation, false);
  const two = runNow(
    "Junior/Second Semester",
    ["A", "B"],
    [{ course: "D", delayTerms: 2 }],
  );
  assert.equal(two.slips_graduation, true);
  assert.equal(two.new_graduation_term, "Fifth Year/First Semester");
});

test("current term: slack shrinks for a student behind the plan", () => {
  const g = BASE();
  const done = new Set([code("A"), code("B")]);
  assert.equal(slackTerms(g, TERMS, code("D"), done), 2);
  assert.equal(
    slackTerms(g, TERMS, code("D"), done, undefined, {
      now: "Junior/Second Semester",
    }),
    1,
  );
});

test("current term: an overdue summer course waits for the next summer it is offered", () => {
  const g = graph([
    course("A", "Freshman/First Semester"),
    course("X", "Sophomore/Summer"),
    course("Y", "Senior/First Semester", "X"),
    course("Z", "Senior/Second Semester"),
  ]);
  const r = whatIf(
    g,
    [...TERMS, "Sophomore/Summer"],
    {
      changes: [],
      completed: new Set([code("A")]),
      now: "Junior/Second Semester",
    },
    new Map([
      [
        code("X"),
        {
          summer: "very likely",
          fall: "very unlikely",
          spring: "very unlikely",
        },
      ],
    ]),
  );
  assert.deepEqual(
    r.behind!.map((m) => [back(m.code), m.to]),
    [["X", "Junior/Summer"]],
  );
  assert.equal(r.graduation_slip_terms, 0);
});

test("current term: nothing to say without it — the result has no behind fields", () => {
  const r = run(BASE(), [{ course: "D", delayTerms: 1 }]);
  assert.equal(r.behind, undefined);
  assert.equal(r.graduation_slip_terms, undefined);
  assert.equal(r.plan_graduation_term, undefined);
});

test("current term: an unknown label is an error, and a move before now is refused", () => {
  assert.throws(() => runNow("Spring 2027", []), /current_term/);
  assert.throws(
    () =>
      runNow(
        "Junior/Second Semester",
        ["A", "B"],
        [{ course: "E", moveTo: "Junior/First Semester" }],
      ),
    /before the current term/,
  );
});

test("current term: the other options of a choice already made are not overdue", () => {
  const g = BASE();
  g.courses.push(
    course("P", "Freshman/Second Semester", null, { choice: true }),
    course("Q", "Freshman/Second Semester", null, { choice: true }),
  );
  g.choices = [
    {
      term: "Freshman/Second Semester",
      options: [code("P"), code("Q")].map((c) => ({
        code: c,
        min_prior_terms: 0,
      })),
    },
  ];
  const r = whatIf(g, TERMS, {
    changes: [],
    completed: new Set([code("A"), code("B"), code("P")]),
    now: "Junior/Second Semester",
  });
  assert.ok(!r.behind!.some((m) => m.code === code("Q")));
});

// GC rule (Chip, 2026-11-10): GC 3500 and GC 4500 may not BOTH be in a
// summer, in any years; neither has to be. The published plan shows both in
// summers — "a limitation in how it can be shown". The rule is department
// data (departments/gc/rules.yaml), passed in as the tools pass it.
const SUMMER_RULE: PlanningRule = {
  kind: "at_most_in_season",
  season: "summer",
  n: 1,
  groups: [
    ["GC 3500", "COOP 2010"],
    ["GC 4500", "COOP 2020"],
  ],
  text: "At most one internship in a summer.",
  source: "test",
};
const GC_RULES: PlanningRule[] = [SUMMER_RULE];
function internships(first: string, second: string) {
  const c = (code: string, planned: string, prereq: string | null = null) => ({
    code,
    title: code,
    planned,
    requirements: [],
    prereq,
    parse: (prereq ? "complete" : "none") as GraphCourse["parse"],
    min_prior_terms: 0,
    required_by: 0,
    one_way_into: 0,
  });
  return graph([
    c("GC 3500", first),
    c("GC 4500", second, "GC 3500"),
    c("GC 4800", "Senior/Second Semester"),
  ]);
}
const ITERMS = [...TERMS, "Sophomore/Summer", "Junior/Summer"];

test("GC rule: GC 4500 is not delayed into a summer while GC 3500 is in one", () => {
  const r = whatIf(internships("Sophomore/Summer", "Junior/Summer"), ITERMS, {
    rules: GC_RULES,
    changes: [{ course: "GC 4500", delayTerms: 3 }],
    completed: none,
  });
  assert.equal(r.moves[0].to, "Fifth Year/First Semester");
});

test("GC rule: with GC 3500 in a fall, GC 4500 may take a summer", () => {
  const r = whatIf(internships("Sophomore/Summer", "Junior/Summer"), ITERMS, {
    rules: GC_RULES,
    changes: [
      { course: "GC 3500", moveTo: "Junior/First Semester" },
      { course: "GC 4500", delayTerms: 3 },
    ],
    completed: none,
  });
  assert.equal(r.moves.find((m) => m.code === "GC 4500")!.to, "Senior/Summer");
  assert.ok(!r.assumptions.some((a) => /both in summers/.test(a)));
});

test("GC rule: a result that still has both in summers says so", () => {
  const r = whatIf(internships("Sophomore/Summer", "Junior/Summer"), ITERMS, {
    rules: GC_RULES,
    changes: [{ skipTerm: "Freshman/First Semester" }],
    completed: none,
  });
  assert.ok(
    r.assumptions.some((a) =>
      /GC 3500 and GC 4500 are both in summers/.test(a),
    ),
    r.assumptions.join(" | "),
  );
});

test("GC rule: moving GC 4500 into a summer while GC 3500 is in one names the rule", () => {
  assert.throws(
    () =>
      whatIf(internships("Sophomore/Summer", "Junior/Summer"), ITERMS, {
        rules: GC_RULES,
        changes: [{ course: "GC 4500", moveTo: "Senior/Summer" }],
        completed: none,
      }),
    /only one of GC 3500 and GC 4500 may be in a summer/,
  );
});

test("GC rule: a GC 3500 completed in a summer keeps GC 4500 out of summers", () => {
  const q = (inSummer: string[]) =>
    whatIf(internships("Sophomore/Summer", "Junior/Summer"), ITERMS, {
      rules: GC_RULES,
      changes: [{ course: "GC 4500", delayTerms: 3 }],
      completed: new Set(["GC 3500"]),
      completedInSummer: new Set(inSummer),
    });
  assert.equal(q([]).moves[0].to, "Senior/Summer");
  assert.equal(q(["GC 3500"]).moves[0].to, "Fifth Year/First Semester");
});

// Review fixes (2026-11-10).
test("review: a settled choice's other option is kept when a planned course needs it", () => {
  // Real case (Management 2026-27): CPSC 2200 | MGT 2180 is a choice, and
  // MGT 3130 requires MGT 2180 alone.
  const g = BASE();
  g.courses.push(
    course("P", "Freshman/Second Semester", null, { choice: true }),
    course("Q", "Freshman/Second Semester", null, { choice: true }),
    course("R", "Sophomore/Second Semester", "Q"),
  );
  g.choices = [
    {
      term: "Freshman/Second Semester",
      options: [code("P"), code("Q")].map((c) => ({
        code: c,
        min_prior_terms: 0,
      })),
    },
  ];
  const r = whatIf(g, TERMS, {
    changes: [],
    completed: new Set([code("A"), code("B"), code("P")]),
    now: "Junior/Second Semester",
  });
  const q = r.behind!.find((m) => m.code === code("Q"))!;
  assert.equal(q.to, "Junior/Second Semester");
  assert.equal(q.only_if_chosen, undefined);
  assert.equal(
    r.behind!.find((m) => m.code === code("R"))!.to,
    "Senior/First Semester",
  );
});

test("review: a GC 3500 completed in a summer moves a planned-summer GC 4500 out of summers", () => {
  const r = whatIf(internships("Sophomore/Summer", "Junior/Summer"), ITERMS, {
    rules: GC_RULES,
    changes: [],
    completed: new Set(["GC 3500"]),
    completedInSummer: new Set(["GC 3500"]),
    now: "Junior/Summer",
  });
  assert.deepEqual(
    r.behind!.map((m) => [m.code, m.to]),
    [["GC 4500", "Senior/First Semester"]],
  );
});

test("review: without current_term, a summer-completed GC 3500 and a summer GC 4500 are noted", () => {
  const r = whatIf(internships("Sophomore/Summer", "Junior/Summer"), ITERMS, {
    rules: GC_RULES,
    changes: [{ course: "GC 4800", delayTerms: 1 }],
    completed: new Set(["GC 3500"]),
    completedInSummer: new Set(["GC 3500"]),
  });
  assert.ok(r.assumptions.some((a) => /both in summers/.test(a)));
});

test("review: GC 3500 may move into a summer when GC 4500 must leave its summer anyway", () => {
  const r = whatIf(internships("Sophomore/Summer", "Junior/Summer"), ITERMS, {
    rules: GC_RULES,
    changes: [{ course: "GC 3500", moveTo: "Junior/Summer" }],
    completed: none,
  });
  assert.equal(r.moves.find((m) => m.code === "GC 3500")!.to, "Junior/Summer");
  assert.equal(
    r.moves.find((m) => m.code === "GC 4500")!.to,
    "Senior/First Semester",
  );
});

test("review: a delay of GC 3500 counts the summer GC 4500 is about to leave", () => {
  const r = whatIf(internships("Sophomore/Summer", "Junior/Summer"), ITERMS, {
    rules: GC_RULES,
    changes: [{ course: "GC 3500", delayTerms: 3 }],
    completed: none,
  });
  assert.equal(r.moves.find((m) => m.code === "GC 3500")!.to, "Junior/Summer");
});

test("review: a skipped term before the current term is refused", () => {
  assert.throws(
    () =>
      runNow(
        "Junior/First Semester",
        ["A", "B"],
        [{ skipTerm: "Sophomore/First Semester" }],
      ),
    /before the current term/,
  );
});

test("review: a student far behind gets an answer, not a horizon error", () => {
  const r = runNow("Sixth Year/Second Semester", []);
  assert.ok(r.graduation_slip_terms! > 0);
  assert.equal(slotOf(r.graduation_term) !== null, true);
});

test("review: an option a planned course requires is not 'only if chosen', even before the choice is made", () => {
  const g = BASE();
  g.courses.push(
    course("P", "Freshman/Second Semester", null, { choice: true }),
    course("Q", "Freshman/Second Semester", null, { choice: true }),
    course("R", "Sophomore/Second Semester", "Q"),
  );
  g.choices = [
    {
      term: "Freshman/Second Semester",
      options: [code("P"), code("Q")].map((c) => ({
        code: c,
        min_prior_terms: 0,
      })),
    },
  ];
  const r = whatIf(g, TERMS, {
    changes: [],
    completed: new Set([code("A"), code("B")]),
    now: "Junior/Second Semester",
  });
  assert.equal(
    r.behind!.find((m) => m.code === code("Q"))!.only_if_chosen,
    undefined,
  );
  assert.equal(
    r.behind!.find((m) => m.code === code("P"))!.only_if_chosen,
    true,
  );
});

// Department planning rules are data (departments/<id>/rules.yaml): the
// engine applies what it is given, and nothing it is not.
test("rules: without the summer rule, GC 4500 may be delayed into a summer", () => {
  const r = whatIf(internships("Sophomore/Summer", "Junior/Summer"), ITERMS, {
    changes: [{ course: "GC 4500", delayTerms: 3 }],
    completed: none,
  });
  assert.equal(r.moves[0].to, "Senior/Summer");
});

test("rules: a summer group counts its alternatives — COOP 2010 in a summer keeps GC 4500 out", () => {
  const r = whatIf(internships("Sophomore/Summer", "Junior/Summer"), ITERMS, {
    rules: GC_RULES,
    changes: [{ course: "GC 4500", delayTerms: 3 }],
    completed: new Set(["GC 3500", "COOP 2010"]),
    completedInSummer: new Set(["COOP 2010"]),
  });
  assert.equal(r.moves[0].to, "Fifth Year/First Semester");
});

// A GC-shaped plan for the ordering rules.
function gcPlan() {
  const c = (code: string, planned: string, prereq: string | null = null) => ({
    code,
    title: code,
    planned,
    requirements: [],
    prereq,
    parse: (prereq ? "complete" : "none") as GraphCourse["parse"],
    min_prior_terms: 0,
    required_by: 0,
    one_way_into: 0,
  });
  return graph([
    c("GC 3500", "Sophomore/Summer"),
    c("GC 4060", "Junior/First Semester"),
    c("GC 4400", "Junior/Second Semester"),
    c("GC 4500", "Junior/Summer", "GC 3500"),
    c("GC 4440", "Senior/First Semester"),
    c("GC 4800", "Senior/Second Semester"),
  ]);
}
const rule = (r: Record<string, unknown>) =>
  ({ text: `rule ${String(r.kind)}`, source: "test", ...r }) as PlanningRule;
const AFTER_SECOND = rule({
  kind: "before",
  first: ["GC 4500", "COOP 2020"],
  then: ["GC 4440", "GC 4480", "GC 4800"],
});
const LAB_FIRST = rule({
  kind: "before",
  first: ["GC 4060", "GC 4400"],
  then: ["GC 4500", "COOP 2020"],
});

test("rules: `before` pushes the later courses after the earlier one", () => {
  const r = whatIf(gcPlan(), ITERMS, {
    rules: [AFTER_SECOND],
    changes: [{ course: "GC 4500", moveTo: "Senior/Summer" }],
    completed: none,
  });
  assert.equal(
    r.moves.find((m) => m.code === "GC 4440")!.to,
    "Fifth Year/First Semester",
  );
  assert.equal(
    r.moves.find((m) => m.code === "GC 4800")!.to,
    "Fifth Year/First Semester",
  );
  assert.equal(
    r.moves.find((m) => m.code === "GC 4440")!.because,
    "department rule: rule before",
  );
});

test("rules: without `before`, those courses stay put", () => {
  const r = whatIf(gcPlan(), ITERMS, {
    changes: [{ course: "GC 4500", moveTo: "Senior/Summer" }],
    completed: none,
  });
  assert.equal(r.moves.length, 1);
});

test("rules: `before` with alternatives — either one in time is enough", () => {
  // GC 4400 delayed past GC 4500, but GC 4060 is still before it.
  const one = whatIf(gcPlan(), ITERMS, {
    rules: [LAB_FIRST],
    changes: [{ course: "GC 4400", delayTerms: 2 }],
    completed: none,
  });
  assert.ok(!one.moves.some((m) => m.code === "GC 4500"));
  // Both delayed (GC 4060 to Senior fall, GC 4400 to Senior spring): GC 4500
  // must follow the earlier of the two, so the term after Senior fall.
  const both = whatIf(gcPlan(), ITERMS, {
    rules: [LAB_FIRST],
    changes: [
      { course: "GC 4060", delayTerms: 2 },
      { course: "GC 4400", delayTerms: 2 },
    ],
    completed: none,
  });
  assert.equal(
    both.moves.find((m) => m.code === "GC 4500")!.to,
    "Senior/Second Semester",
  );
});

test("rules: a completed `first` alternative satisfies `before`", () => {
  const r = whatIf(gcPlan(), ITERMS, {
    rules: [AFTER_SECOND],
    changes: [{ course: "GC 4440", moveTo: "Junior/First Semester" }],
    completed: new Set(["COOP 2020"]),
  });
  assert.deepEqual(r.prereq_problems, []);
});

test("rules: moving a course earlier than its `before` rule allows is a problem, not a push", () => {
  const r = whatIf(gcPlan(), ITERMS, {
    rules: [AFTER_SECOND],
    changes: [{ course: "GC 4440", moveTo: "Junior/First Semester" }],
    completed: none,
  });
  assert.equal(r.prereq_problems.length, 1);
  assert.match(
    r.prereq_problems[0].problem,
    /GC 4440 in Junior\/First Semester breaks a department rule: rule before/,
  );
});

test("rules: avoid_same_term warns and never moves anything", () => {
  const r = whatIf(gcPlan(), ITERMS, {
    rules: [
      rule({
        kind: "avoid_same_term",
        courses: ["GC 4060", "GC 4400"],
        text: "GC 4060 and GC 4400 together is discouraged.",
      }),
    ],
    changes: [{ course: "GC 4060", moveTo: "Junior/Second Semester" }],
    completed: none,
  });
  assert.equal(r.moves.length, 1);
  assert.equal(r.slips_graduation, false);
  assert.deepEqual(r.department_warnings, [
    "GC 4060 and GC 4400 are both in Junior/Second Semester: GC 4060 and GC 4400 together is discouraged.",
  ]);
});

test("rules: load rules the engine cannot check are named as not checked", () => {
  const r = whatIf(gcPlan(), ITERMS, {
    rules: [
      rule({
        kind: "term_load",
        when_any: ["GC 3500"],
        not_counted: ["GC 3500"],
        max_other_credits: 6,
        preferred_other_credits: 3,
        text: "At most 6 other credits in an internship term.",
      }),
    ],
    changes: [{ course: "GC 4800", delayTerms: 1 }],
    completed: none,
  });
  assert.ok(
    r.assumptions.includes(
      "Not checked here (department rule): At most 6 other credits in an internship term.",
    ),
    r.assumptions.join(" | "),
  );
});

test("rules: same_term moves a registration pair as one", () => {
  const g = gcPlan();
  g.courses.push({
    ...g.courses[3],
    code: "COOP 2020",
    prereq: null,
    parse: "none",
  });
  const r = whatIf(g, ITERMS, {
    rules: [
      rule({ kind: "same_term", courses: ["GC 4500", "COOP 2020"] }),
      AFTER_SECOND,
    ],
    changes: [{ course: "GC 4500", moveTo: "Senior/First Semester" }],
    completed: none,
  });
  const coop = r.moves.find((m) => m.code === "COOP 2020")!;
  assert.equal(coop.to, "Senior/First Semester");
  assert.equal(coop.because, "taken with GC 4500 (registered together)");
  // ...so the second internship really is in Senior fall, and GC 4440 follows.
  assert.equal(
    r.moves.find((m) => m.code === "GC 4440")!.to,
    "Senior/Second Semester",
  );
});

test("rules: an internship group with a completed member counts by that member's term", () => {
  // GC 3500 done in a fall: COOP 2010 still in its planned summer is not a
  // second summer internship. Nothing is marked completed on its behalf.
  const g = gcPlan();
  g.courses.push({ ...g.courses[0], code: "COOP 2010" });
  const r = whatIf(g, ITERMS, {
    rules: [
      rule({ kind: "same_term", courses: ["GC 3500", "COOP 2010"] }),
      SUMMER_RULE,
    ],
    changes: [{ course: "GC 4500", moveTo: "Senior/Summer" }],
    completed: new Set(["GC 3500"]),
  });
  assert.equal(r.moves.find((m) => m.code === "GC 4500")!.to, "Senior/Summer");
  assert.ok(!r.moves.some((m) => m.code === "COOP 2010"));
});

// Review (2026-11-11).
test("review: the summer rule never moves the partner of a completed internship", () => {
  // Both internships done in summers; their COOP registrations are still
  // planned. Moving a COOP cannot resolve anything, so nothing moves.
  const g = gcPlan();
  g.courses.push(
    { ...g.courses[0], code: "COOP 2010" },
    { ...g.courses[3], code: "COOP 2020", prereq: null, parse: "none" },
  );
  const r = whatIf(g, ITERMS, {
    rules: [
      rule({ kind: "same_term", courses: ["GC 3500", "COOP 2010"] }),
      rule({ kind: "same_term", courses: ["GC 4500", "COOP 2020"] }),
      SUMMER_RULE,
    ],
    changes: [],
    completed: new Set(["GC 3500", "GC 4500"]),
    completedInSummer: new Set(["GC 3500", "GC 4500"]),
    now: "Sophomore/Summer",
  });
  assert.ok(
    !(r.behind ?? []).some((m) => m.code.startsWith("COOP")),
    JSON.stringify(r.behind),
  );
});

test("review: `before` does not chain the leftover partner of a completed internship", () => {
  // GC 4500 done; its COOP 2020 left in the plan is not the second
  // internship still to come, so no `before` rule pushes it.
  const g = gcPlan();
  g.courses.push({
    ...g.courses[3],
    code: "COOP 2020",
    prereq: null,
    parse: "none",
  });
  const r = whatIf(g, ITERMS, {
    rules: [
      rule({ kind: "same_term", courses: ["GC 4500", "COOP 2020"] }),
      LAB_FIRST,
    ],
    changes: [
      { course: "GC 4060", delayTerms: 2 },
      { course: "GC 4400", delayTerms: 2 },
    ],
    completed: new Set(["GC 4500"]),
  });
  assert.ok(
    !r.moves.some((m) => m.code === "COOP 2020"),
    JSON.stringify(r.moves),
  );
});

test("review: a move forced by a department rule quotes the rule, not a prerequisite", () => {
  const r = whatIf(gcPlan(), ITERMS, {
    rules: [LAB_FIRST],
    changes: [
      { course: "GC 4060", delayTerms: 2 },
      { course: "GC 4400", delayTerms: 2 },
    ],
    completed: none,
  });
  assert.equal(
    r.moves.find((m) => m.code === "GC 4500")!.because,
    "department rule: rule before",
  );
});

test("review: moving earlier than a department rule allows names the rule", () => {
  const r = whatIf(gcPlan(), ITERMS, {
    rules: [AFTER_SECOND],
    changes: [{ course: "GC 4440", moveTo: "Junior/First Semester" }],
    completed: none,
  });
  assert.match(
    r.prereq_problems[0].problem,
    /breaks a department rule: rule before/,
  );
});
