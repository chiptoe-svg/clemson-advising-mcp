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
