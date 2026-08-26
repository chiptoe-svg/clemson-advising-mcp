// test/find-requirement-sections.test.ts
//
// find-requirement-sections (Task 6 of the local-model-tool-surface plan) —
// the reshape of the former find-eligible-sections: requirement -> offered-
// sections join (gc_advisor.db) with section-side filtering routed through
// the shared querySectionsEngine (src/mcp-tools/section-query.ts), one call
// per explicit course code. Builds a hermetic fixture gc_advisor.db (same
// schema as test/clemson-advising.test.ts) plus a fixture Banner schedule
// snapshot DB via writeScheduleDb (same pattern as test/core-search.test.ts)
// under a temp STATE_DIR. See .superpowers/sdd/task-6-brief.md.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuassistant-find-req-sections-"));
process.env.STATE_DIR = TMP;

const GC_DB_PATH = path.join(TMP, "gc_advisor.db");
process.env.GC_ADVISOR_DB = GC_DB_PATH;

// Current date in this environment is 2026-08-14 -> defaultTerm resolves to
// Fall 2026 (202608, month 8 is in the May-Nov Fall window) — the fixture
// schedule DB is written at this exact code so a no-`term` call exercises
// the real default path, not a hardcoded pin.
const TERM = "202608";
// Pin the resolver's clock inside the Fall-2026 window so the default-term
// path is stable regardless of the wall clock (review T3).
const { __setTermClockForTest } = await import("../src/term-resolve.ts");
__setTermClockForTest(() => new Date("2026-08-14T12:00:00-04:00"));
const PROGRAM = "Graphic Communications, BS";
const SLOT = "Specialty Area Requirement";

function buildGcAdvisorFixture(): void {
  const db = new Database(GC_DB_PATH);
  db.exec(`
    CREATE TABLE catalog_year (
      id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE, catoid INTEGER,
      level TEXT NOT NULL DEFAULT 'undergraduate', source_urls TEXT, ingested_at TEXT
    );
    CREATE TABLE program (
      id INTEGER PRIMARY KEY, catalog_year_id INTEGER NOT NULL REFERENCES catalog_year(id),
      poid INTEGER, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'major',
      degree TEXT, total_credits INTEGER, description TEXT, source_url TEXT, source_hash TEXT
    );
    CREATE TABLE requirement_rule (
      id INTEGER PRIMARY KEY, program_id INTEGER NOT NULL REFERENCES program(id),
      slot_type TEXT NOT NULL, rule TEXT NOT NULL, bogus INTEGER NOT NULL DEFAULT 0
    );
    -- Mirrors gc_advisor/src/gc_advisor/db/schema.sql: the named contract for
    -- direct SQL readers. The bogus flag is materialised by gc_advisor's writers from
    -- rule_semantics.is_bogus_rule; the view hides exactly what CatalogAccess hides.
    CREATE VIEW requirement_rule_effective AS
      SELECT id, program_id, slot_type, rule FROM requirement_rule WHERE bogus = 0;
    CREATE TABLE course (
      code TEXT PRIMARY KEY, subject TEXT NOT NULL, number TEXT NOT NULL,
      title TEXT, credits TEXT, description TEXT, prereq_text TEXT, prereq_parsed TEXT,
      coreq_text TEXT, coreq_parsed TEXT, terms_offered TEXT, restrictions TEXT,
      cross_listed_as TEXT, status TEXT NOT NULL DEFAULT 'active',
      first_seen TEXT, last_synced TEXT, source_url TEXT
    );
  `);

  db.prepare("INSERT INTO catalog_year (id, label, catoid) VALUES (?, ?, ?)").run(1, "2024-2025", 100);
  db.prepare("INSERT INTO catalog_year (id, label, catoid) VALUES (?, ?, ?)").run(2, "2025-2026", 101);

  db.prepare(
    "INSERT INTO program (id, catalog_year_id, poid, name, kind) VALUES (?, ?, ?, ?, 'major')",
  ).run(1, 1, 500, PROGRAM); // 2024-2025 — older catalog
  db.prepare(
    "INSERT INTO program (id, catalog_year_id, poid, name, kind) VALUES (?, ?, ?, ?, 'major')",
  ).run(2, 2, 501, PROGRAM); // 2025-2026 — latest

  const insertRule = db.prepare(
    "INSERT INTO requirement_rule (program_id, slot_type, rule) VALUES (?, ?, ?)",
  );
  // Old catalog year: 2 eligible courses, 6 credits.
  insertRule.run(
    1,
    SLOT,
    JSON.stringify({
      slot_type: SLOT,
      total_credits: 6,
      explicit_courses: ["GC 3010", "GC 3020"],
      raw_text: "old catalog rule",
    }),
  );
  // Latest catalog year: 4 eligible courses (incl. an async one), 12 credits.
  insertRule.run(
    2,
    SLOT,
    JSON.stringify({
      slot_type: SLOT,
      total_credits: 12,
      explicit_courses: ["GC 3010", "GC 3020", "GC 3030", "GC 3040"],
      raw_text: "latest catalog rule",
    }),
  );
  // Dedicated requirement whose single explicit course offers more sections
  // than querySectionsEngine's NARROW_THRESHOLD (15) — exercises the
  // narrowedCourses note path (clemson-advising.ts ~554-561). Kept out of
  // SLOT's explicit_courses so it can't perturb any of the SLOT-based tests.
  const NARROW_SLOT = "Narrow Test Requirement";
  insertRule.run(
    2,
    NARROW_SLOT,
    JSON.stringify({
      slot_type: NARROW_SLOT,
      total_credits: 3,
      explicit_courses: ["GC 3050"],
      raw_text: "narrow test rule",
    }),
  );

  // A rule gc_advisor has flagged bogus (the footnote mis-association family —
  // the real case is Management, BS 2025-2026 "Natural Science Requirement"
  // -> MGT 4150). requirement_rule_effective hides it; the tool must read
  // through the view so the slot reads as unknown rather than offering the
  // course's sections as if they filled the requirement. GC 3010 has sections
  // in the schedule fixture, so a raw-table read would return them.
  const BOGUS_SLOT = "Natural Science Requirement";
  db.prepare(
    "INSERT INTO requirement_rule (program_id, slot_type, rule, bogus) VALUES (?, ?, ?, 1)",
  ).run(
    2,
    BOGUS_SLOT,
    JSON.stringify({
      slot_type: BOGUS_SLOT,
      total_credits: 4,
      explicit_courses: ["GC 3010"],
      raw_text: "mis-associated footnote",
    }),
  );

  const insertCourse = db.prepare(
    "INSERT INTO course (code, subject, number, prereq_text, prereq_parsed) VALUES (?, ?, ?, ?, ?)",
  );
  insertCourse.run("GC 3010", "GC", "3010", null, null); // no prereq
  insertCourse.run("GC 3020", "GC", "3020", "GC 3010", JSON.stringify(["GC 3010"])); // requires GC 3010
  insertCourse.run("GC 3030", "GC", "3030", null, null);
  insertCourse.run("GC 3040", "GC", "3040", null, null);
  insertCourse.run("GC 3050", "GC", "3050", null, null); // no prereq — narrowedCourses fixture

  db.close();
}
buildGcAdvisorFixture();

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { makeFindRequirementSections, findRequirementSections } = await import(
  "../src/mcp-tools/clemson-advising.ts"
);
const { toolsForScope } = await import("../src/mcp-tools/server.ts");
const { allExposedOperations } = await import("../src/mcp-tools/permissions.ts");
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClemsonTermSnapshot } from "../src/clemson-classes.ts";

function meeting(days: string, beginTime: string, endTime: string) {
  return {
    days,
    beginTime,
    endTime,
    building: "Lee Hall",
    room: "100",
    roomCapacity: null,
    startDate: null,
    endDate: null,
    type: "Lecture",
  };
}

function section(
  overrides: Partial<ClemsonTermSnapshot["sections"][number]> & {
    crn: string;
    subjectCourse: string;
  },
): ClemsonTermSnapshot["sections"][number] {
  return {
    term: TERM,
    termDescription: "Fall 2026",
    section: "001",
    title: "Untitled",
    campus: "Main",
    scheduleType: "Lecture",
    instructionalMethod: null,
    creditHours: 3,
    enrollment: 10,
    maxEnrollment: 20,
    seatsAvailable: 10,
    waitCount: 0,
    waitCapacity: 0,
    open: true,
    instructors: [],
    meetings: [],
    ...overrides,
  };
}

const SNAP: ClemsonTermSnapshot = {
  term: TERM,
  termDescription: "Fall 2026",
  fetchedAt: "2026-07-20T05:00:00.000Z",
  sectionCount: 0,
  sections: [
    // GC3010-90001: Friday meeting — excluded by exclude_days:["F"].
    section({ crn: "90001", subjectCourse: "GC3010", section: "001", title: "Studio A", meetings: [meeting("F", "1000", "1050")] }),
    // GC3010-90002: pre-9:00 Monday meeting — excluded by no_meeting_before:"0900".
    section({ crn: "90002", subjectCourse: "GC3010", section: "002", title: "Studio B", meetings: [meeting("M", "0800", "0850")] }),
    // GC3020-90003: 9:00+ Monday meeting — kept under no_meeting_before:"0900".
    section({ crn: "90003", subjectCourse: "GC3020", section: "001", title: "Print Systems", meetings: [meeting("M", "0900", "0950")] }),
    // GC3020-90004: conflicts with anchor CRN 90010 (10:30-11:30 overlaps 10:00-11:00)
    // — excluded by fits_around_crns:["90010"].
    section({ crn: "90004", subjectCourse: "GC3020", section: "002", title: "Print Systems Lab", meetings: [meeting("M", "1000", "1100")] }),
    // GC3030-90005: back-to-back (11:00-12:00) with anchor CRN 90011 (12:00-13:00)
    // — adjacent boundary, must NOT be excluded by fits_around_crns.
    section({ crn: "90005", subjectCourse: "GC3030", section: "001", title: "Color Theory", meetings: [meeting("M", "1100", "1200")] }),
    // GC3030-90006: full — excluded by open_seats_only:true.
    section({ crn: "90006", subjectCourse: "GC3030", section: "002", title: "Color Theory Lab", enrollment: 20, seatsAvailable: 0, open: false, meetings: [meeting("T", "1300", "1350")] }),
    // GC3040-90007: zero-meeting async section.
    section({ crn: "90007", subjectCourse: "GC3040", section: "001", title: "Async Elective", scheduleType: "Online", instructionalMethod: "DE", enrollment: 5, seatsAvailable: 15, meetings: [] }),
    // Anchor sections (student's current schedule) — not in any explicit_courses list.
    section({ crn: "90010", subjectCourse: "MATH1060", section: "001", title: "Trig", enrollment: 10, seatsAvailable: 5, meetings: [meeting("M", "1030", "1130")] }),
    section({ crn: "90011", subjectCourse: "MATH1080", section: "001", title: "Calc", enrollment: 10, seatsAvailable: 5, meetings: [meeting("M", "1200", "1300")] }),
    // GC3050: 16 sections (> querySectionsEngine's NARROW_THRESHOLD of 15) —
    // "Narrow Test Requirement"'s only explicit course, dedicated to the
    // narrowedCourses note test. Not referenced by SLOT, so it can't affect
    // any SLOT-based test above.
    ...Array.from({ length: 16 }, (_, i) =>
      section({
        crn: `91${String(i).padStart(3, "0")}`,
        subjectCourse: "GC3050",
        section: String(i + 1).padStart(3, "0"),
        title: `Narrow Elective ${i + 1}`,
        meetings: [meeting("MWF", "0900", "0950")],
      }),
    ),
  ],
};
SNAP.sectionCount = SNAP.sections.length;
writeScheduleDb(SNAP);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(res: CallToolResult): string {
  return (res.content[0] as { text: string }).text;
}

function json(res: CallToolResult): any {
  assert.notEqual(res.isError, true, text(res));
  return JSON.parse(text(res));
}

function errText(res: CallToolResult): string {
  assert.equal(res.isError, true, "expected an error result");
  return text(res);
}

async function call(args: Record<string, unknown>) {
  return json(await findRequirementSections.handler(args));
}

// Phase B4: `program` no longer defaults to Graphic Communications, BS — every
// call names the program it is asking about.
const BASE_ARGS = {
  requirement: SLOT,
  completed_courses: [] as string[],
  program: PROGRAM,
};

// ---------------------------------------------------------------------------
// Registration + literal name/description (VERBATIM from task-6-brief.md)
// ---------------------------------------------------------------------------

// Updated in Phase B4: `program` is now required (no GC default) and
// catalog_year is called out as defaulting to the program's latest.
const EXPECTED_DESCRIPTION =
  "Find sections that fill a named degree requirement slot and that the " +
  "student is eligible to take (prerequisites checked against " +
  "completed_courses). Requires requirement — the requirement slot name; " +
  "an unknown name returns the valid slot list — and program, which has no " +
  "default. Optional: catalog_year (defaults to the program's latest), " +
  "completed_courses, fits_around_crns, days, no_meeting_before, " +
  "no_meeting_after, exclude_days, open_seats_only. Term is optional — " +
  "defaults to the current registration term.";

test("registered with the exact kebab-case name and the verbatim brief description", () => {
  assert.equal(findRequirementSections.tool.name, "find-requirement-sections");
  assert.equal(findRequirementSections.tool.description, EXPECTED_DESCRIPTION);
  assert.deepEqual(findRequirementSections.tool.inputSchema.required, ["requirement"]);
});

test("passes policy and appears in the exposed tool list", () => {
  const names = toolsForScope(allExposedOperations()).map((t) => t.name);
  assert.ok(names.includes("find-requirement-sections"));
});

// ---------------------------------------------------------------------------
// Requirement discriminator: missing / unknown
// ---------------------------------------------------------------------------

test("missing requirement returns a clear error", async () => {
  const res = await findRequirementSections.handler({});
  assert.match(errText(res), /requirement is required/);
});

test("an unknown requirement returns the valid slot list inline (no extra round)", async () => {
  const calls: Array<{ year: string; name: string }> = [];
  const tool = makeFindRequirementSections({
    getGcRequirementRules: async (year: string, name: string) => {
      calls.push({ year, name });
      return [
        { slot_type: "Specialty Area Requirement", rule: {} },
        { slot_type: "Graphic Communication Technical Requirement", rule: {} },
      ];
    },
  });
  const res = await tool.handler({
    requirement: "Bogus Requirement",
    completed_courses: [],
    program: PROGRAM,
  });
  const t = errText(res);
  assert.match(t, /Unknown requirement "Bogus Requirement"/);
  assert.match(t, /Specialty Area Requirement/);
  assert.match(t, /Graphic Communication Technical Requirement/);
  // Resolved against the latest catalog year (2025-2026) for the named program
  // — proves the redirect doesn't need catalog_year to be supplied.
  assert.deepEqual(calls, [{ year: "2025-2026", name: PROGRAM }]);
});

// Phase B4: the GC default is gone. A call with no program is an error that
// says so, not a silent answer about a degree nobody asked about.
test("a missing program returns a clear error instead of defaulting to Graphic Communications", async () => {
  const res = await findRequirementSections.handler({
    requirement: SLOT,
    completed_courses: [],
  });
  assert.equal(res.isError, true);
  assert.match(errText(res), /program is required/);
  assert.match(errText(res), /no default program/);
});

test("the deprecated `name` alias still resolves the program for one release", async () => {
  const out = await call({
    requirement: SLOT,
    completed_courses: [],
    name: PROGRAM,
  });
  assert.equal(out.program, PROGRAM);
});

test("every response echoes the resolved program and catalog_year", async () => {
  const latest = await call(BASE_ARGS);
  assert.equal(latest.program, PROGRAM);
  assert.equal(latest.catalog_year, "2025-2026", "defaulted to the program's latest");
  const older = await call({ ...BASE_ARGS, catalog_year: "2024-2025" });
  assert.equal(older.program, PROGRAM);
  assert.equal(older.catalog_year, "2024-2025");
});

test("the inputSchema is closed — a wrong key is a visible error, not a silent default", () => {
  assert.equal(
    (findRequirementSections.tool.inputSchema as { additionalProperties?: boolean })
      .additionalProperties,
    false,
  );
});

test("a rule gc_advisor flagged bogus is invisible: the slot reads as unknown, never as offering sections", async () => {
  const tool = makeFindRequirementSections({
    getGcRequirementRules: async () => [{ slot_type: SLOT, rule: {} }],
  });
  const res = await tool.handler({
    term: TERM,
    requirement: "Natural Science Requirement",
    completed_courses: [],
    program: PROGRAM,
  });
  assert.equal(res.isError, true, "bogus slot must not resolve to sections");
  const t = errText(res);
  assert.match(t, /Unknown requirement "Natural Science Requirement"/);
  assert.match(t, /Specialty Area Requirement/);
});

test("an unreachable gc_advisor bridge on the unknown-slot path still returns a clean error, not a throw", async () => {
  const tool = makeFindRequirementSections({
    getGcRequirementRules: async () => {
      throw new Error("gc_advisor unreachable");
    },
  });
  const res = await tool.handler({
    requirement: "Bogus Requirement",
    completed_courses: [],
    program: PROGRAM,
  });
  assert.match(errText(res), /Unknown requirement "Bogus Requirement"/);
});

// ---------------------------------------------------------------------------
// Term default (no term given -> current registration term, per resolveTerm)
// ---------------------------------------------------------------------------

test("no term given resolves to the current registration term and finds the fixture's sections", async () => {
  const out = await call({ ...BASE_ARGS });
  assert.equal(out.term, TERM);
  const crns = out.sections.map((s: any) => s.crn).sort();
  assert.deepEqual(crns, ["90001", "90002", "90003", "90004", "90005", "90006", "90007"]);
  assert.equal(out.total_credits_required, 12); // latest catalog year (2025-2026)
});

test("an unrecognized term returns the TermError redirect verbatim", async () => {
  const res = await findRequirementSections.handler({ ...BASE_ARGS, term: "not a term" });
  assert.match(errText(res), /Unrecognized term/);
});

// ---------------------------------------------------------------------------
// Section fields (EngineSection shape + prereq fields)
// ---------------------------------------------------------------------------

test("sections carry the EngineSection fields plus prereqEligible/prereqText", async () => {
  const out = await call({ ...BASE_ARGS });
  const s = out.sections.find((x: any) => x.crn === "90001");
  assert.equal(s.crn, "90001");
  assert.equal(s.subjectCourse, "GC3010");
  assert.equal(s.title, "Studio A");
  assert.equal(s.creditHours, 3);
  assert.equal(typeof s.seatsAvailable, "number");
  // Propagated through querySectionsEngine without extra work on this tool's
  // part — fixture default (section() in this file) is enrollment:10,
  // maxEnrollment:20, not overridden for 90001.
  assert.equal(s.enrollment, 10);
  assert.equal(s.maxEnrollment, 20);
  assert.ok(Array.isArray(s.instructors));
  assert.ok(Array.isArray(s.meetings));
  assert.equal(s.prereqEligible, true); // GC 3010 has no prereq
});

test("prereqEligible is false when completed_courses doesn't satisfy the course's prereq", async () => {
  const out = await call({ ...BASE_ARGS, completed_courses: [] });
  const s = out.sections.find((x: any) => x.crn === "90003"); // GC3020, requires GC 3010
  assert.equal(s.prereqEligible, false);
  assert.equal(s.prereqText, "GC 3010");
});

test("prereqEligible is true once the prereq is in completed_courses", async () => {
  const out = await call({ ...BASE_ARGS, completed_courses: ["GC 1010", "GC 3010"] });
  const s = out.sections.find((x: any) => x.crn === "90003"); // GC3020, requires GC 3010
  assert.equal(s.prereqEligible, true);
});

// ---------------------------------------------------------------------------
// fits_around_crns filtering (via the fixture DB, through querySectionsEngine)
// ---------------------------------------------------------------------------

test("fits_around_crns excludes a section that overlaps a current-schedule CRN", async () => {
  const out = await call({ ...BASE_ARGS, fits_around_crns: ["90010"] });
  const crns = out.sections.map((s: any) => s.crn);
  assert.ok(!crns.includes("90004"), "90004 (10:00-11:00) overlaps current 90010 (10:30-11:30)");
});

test("fits_around_crns keeps a section that is only adjacent (touching boundary) to a current-schedule CRN", async () => {
  const out = await call({ ...BASE_ARGS, fits_around_crns: ["90011"] });
  const crns = out.sections.map((s: any) => s.crn);
  assert.ok(crns.includes("90005"), "90005 (11:00-12:00) is adjacent to current 90011 (12:00-13:00), not a conflict");
});

// ---------------------------------------------------------------------------
// Other scheduling-side filters, all routed through querySectionsEngine
// ---------------------------------------------------------------------------

test("exclude_days excludes a Friday-meeting section", async () => {
  const out = await call({ ...BASE_ARGS, exclude_days: ["F"] });
  const crns = out.sections.map((s: any) => s.crn);
  assert.ok(!crns.includes("90001"), "Friday section 90001 should be excluded");
  assert.ok(crns.includes("90002"), "non-Friday section 90002 should remain");
});

test("no_meeting_before excludes a pre-9:00 section and keeps a 9:00+ one", async () => {
  const out = await call({ ...BASE_ARGS, no_meeting_before: "0900" });
  const crns = out.sections.map((s: any) => s.crn);
  assert.ok(!crns.includes("90002"), "0800 section should be excluded");
  assert.ok(crns.includes("90003"), "0900 section should be kept");
});

test("open_seats_only excludes a seats_available<=0 section", async () => {
  const out = await call({ ...BASE_ARGS, open_seats_only: true });
  const crns = out.sections.map((s: any) => s.crn);
  assert.ok(!crns.includes("90006"), "full section 90006 should be excluded");
  assert.ok(crns.includes("90005"), "open section 90005 should remain");
});

test("a time/day constraint excludes the zero-meeting async section (no separate envelope — engine semantics)", async () => {
  const out = await call({ ...BASE_ARGS, no_meeting_before: "0900" });
  const crns = out.sections.map((s: any) => s.crn);
  assert.ok(!crns.includes("90007"), "async section can't satisfy a time/day rule and is excluded");
});

test("with NO time/day constraint the async section is included normally", async () => {
  const out = await call({ ...BASE_ARGS, open_seats_only: true });
  const crns = out.sections.map((s: any) => s.crn);
  assert.ok(crns.includes("90007"), "async section belongs in sections when no time/day constraint is given");
});

test("applied_constraints echoes back exactly what was passed (normalized uppercase)", async () => {
  const out = await call({ ...BASE_ARGS, exclude_days: ["f"], open_seats_only: true, fits_around_crns: ["90010"] });
  assert.deepEqual(out.applied_constraints.exclude_days, ["F"]);
  assert.equal(out.applied_constraints.open_seats_only, true);
  assert.deepEqual(out.applied_constraints.fits_around_crns, ["90010"]);
});

// ---------------------------------------------------------------------------
// catalog_year / program
// ---------------------------------------------------------------------------

test("catalog_year selects the older program/rule instead of latest", async () => {
  const out = await call({ ...BASE_ARGS, catalog_year: "2024-2025" });
  assert.equal(out.total_credits_required, 6);
  const crns = out.sections.map((s: any) => s.crn).sort();
  // Old catalog's explicit_courses is only GC3010/GC3020 (no GC3030/GC3040).
  assert.deepEqual(crns, ["90001", "90002", "90003", "90004"]);
  assert.equal(out.applied_constraints.catalog_year, "2024-2025");
});

test("unknown catalog_year returns a clear error", async () => {
  const res = await findRequirementSections.handler({ ...BASE_ARGS, catalog_year: "1999-2000" });
  assert.match(errText(res), /not found for catalog year/);
});

test("unknown program returns a clear error", async () => {
  const res = await findRequirementSections.handler({ ...BASE_ARGS, program: "Underwater Basket Weaving, BS" });
  assert.match(errText(res), /not found in gc_advisor\.db/);
});

// ---------------------------------------------------------------------------
// total_matched / no-snapshot-for-any-course
// ---------------------------------------------------------------------------

test("total_matched reflects the merged section count", async () => {
  const out = await call({ ...BASE_ARGS, catalog_year: "2024-2025" });
  assert.equal(out.total_matched, 4);
  assert.equal(out.sections.length, 4);
});

// ---------------------------------------------------------------------------
// narrowedCourses: a single explicit course exceeding NARROW_THRESHOLD
// ---------------------------------------------------------------------------

test("a course offering more sections than NARROW_THRESHOLD is omitted and noted, not silently dropped", async () => {
  const out = await call({ requirement: "Narrow Test Requirement", completed_courses: [], program: PROGRAM });
  // GC 3050 is the requirement's only explicit course, and it needs_narrowing
  // (16 sections > NARROW_THRESHOLD) — so merged ends up empty rather than
  // silently dropping those 16 sections with no explanation.
  assert.equal(out.sections.length, 0);
  assert.match(out.note, /GC 3050/);
  assert.match(out.note, /more sections than can be listed/);
});
