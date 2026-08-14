// test/clemson-advising.test.ts
//
// get-program-requirements + get-schedule-freshness + the overlayLiveSeats
// live-seat-refresh helper — the tools/helpers in
// src/mcp-tools/clemson-advising.ts that were NOT reshaped/removed by Task 6
// of the local-model-tool-surface plan. find-requirement-sections (the
// reshape of the former find-eligible-sections) has its own dedicated test
// file, test/find-requirement-sections.test.ts; find-sections-by-schedule was
// removed outright (replaced by find-alternatives on 8766). Uses a small
// hermetic fixture gc_advisor.db (mirrors the real schema — catalog_year,
// program, requirement_rule, course) rather than the live project DB, so this
// test doesn't drift when that project's data changes; the schedule DB is
// built the same way test/clemson-schedule-db.test.ts does.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuassistant-advising-"));
process.env.STATE_DIR = TMP;

const GC_DB_PATH = path.join(TMP, "gc_advisor.db");
process.env.GC_ADVISOR_DB = GC_DB_PATH;

const TERM = "202608";
const PROGRAM = "Graphic Communications, BS";
const SLOT = "Specialty Area Requirement";
const ACCOUNTING_MINOR = "Accounting Minor";

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
      slot_type TEXT NOT NULL, rule TEXT NOT NULL
    );
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

  // Minor/certificate programs — for get-program-requirements tests. Two
  // distinct names both containing "Account" so a fuzzy "Account" query
  // returns >1 candidate.
  db.prepare(
    "INSERT INTO program (id, catalog_year_id, poid, name, kind) VALUES (?, ?, ?, ?, 'minor')",
  ).run(3, 2, 502, ACCOUNTING_MINOR);
  db.prepare(
    "INSERT INTO program (id, catalog_year_id, poid, name, kind) VALUES (?, ?, ?, ?, 'certificate')",
  ).run(4, 2, 503, "Accounting Certificate");

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

  insertRule.run(
    3,
    "program_requirement",
    JSON.stringify({
      total_credits: 18,
      required_courses: ["ACCT 2010", "ACCT 3110", "ACCT 3120"],
      elective_rules: [
        {
          credits: 9,
          level_or_subject_pattern: "3000- or 4000-level accounting courses",
        },
      ],
      not_open_to: [],
    }),
  );

  const insertCourse = db.prepare(
    "INSERT INTO course (code, subject, number, prereq_text, prereq_parsed) VALUES (?, ?, ?, ?, ?)",
  );
  for (const code of ["GC 3010", "GC 3020", "GC 3030", "GC 3040"]) {
    insertCourse.run(code, "GC", code.split(" ")[1], null, null);
  }

  db.close();
}
buildGcAdvisorFixture();

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const {
  getProgramRequirements,
  scheduleFreshness,
  overlayLiveSeats,
  MAX_REFRESH_SUBJECTS,
} = await import("../src/mcp-tools/clemson-advising.ts");
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

const SNAP: ClemsonTermSnapshot = {
  term: TERM,
  termDescription: "Fall 2026",
  fetchedAt: "2026-07-20T05:00:00.000Z",
  sectionCount: 0,
  sections: [
    // GC3010-001: Friday meeting — excluded by exclude_days:["F"].
    {
      term: TERM, termDescription: "Fall 2026", crn: "90001", subjectCourse: "GC3010",
      section: "001", title: "Studio A", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("F", "1000", "1050")],
    },
    // GC3010-002: pre-9:00 Monday meeting — excluded by no_meeting_before:"0900".
    {
      term: TERM, termDescription: "Fall 2026", crn: "90002", subjectCourse: "GC3010",
      section: "002", title: "Studio B", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "0800", "0850")],
    },
    // GC3020-001: 9:00+ Monday meeting — kept under no_meeting_before:"0900".
    {
      term: TERM, termDescription: "Fall 2026", crn: "90003", subjectCourse: "GC3020",
      section: "001", title: "Print Systems", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "0900", "0950")],
    },
    // GC3020-002: conflicts with the student's current CRN 90010 (10:30-11:30
    // overlaps 10:00-11:00) — excluded by avoid_conflict_with:["90010"].
    {
      term: TERM, termDescription: "Fall 2026", crn: "90004", subjectCourse: "GC3020",
      section: "002", title: "Print Systems Lab", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "1000", "1100")],
    },
    // GC3030-001: back-to-back (11:00-12:00) with current CRN 90011
    // (12:00-13:00) — adjacent boundary, must NOT be excluded.
    {
      term: TERM, termDescription: "Fall 2026", crn: "90005", subjectCourse: "GC3030",
      section: "001", title: "Color Theory", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "1100", "1200")],
    },
    // GC3030-002: full — excluded by open_only:true.
    {
      term: TERM, termDescription: "Fall 2026", crn: "90006", subjectCourse: "GC3030",
      section: "002", title: "Color Theory Lab", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 20, maxEnrollment: 20,
      seatsAvailable: 0, waitCount: 0, waitCapacity: 0, open: false, instructors: [],
      meetings: [meeting("T", "1300", "1350")],
    },
    // GC3040-001: zero-meeting async section (no meetings array entries).
    {
      term: TERM, termDescription: "Fall 2026", crn: "90007", subjectCourse: "GC3040",
      section: "001", title: "Async Elective", campus: "Main", scheduleType: "Online",
      instructionalMethod: "DE", creditHours: 3, enrollment: 5, maxEnrollment: 20,
      seatsAvailable: 15, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [],
    },
    // Not in any explicit_courses list — represents the student's own current
    // schedule (avoid_conflict_with input), not a candidate section.
    {
      term: TERM, termDescription: "Fall 2026", crn: "90010", subjectCourse: "MATH1060",
      section: "001", title: "Trig", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 5, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "1030", "1130")],
    },
    {
      term: TERM, termDescription: "Fall 2026", crn: "90011", subjectCourse: "MATH1080",
      section: "001", title: "Calc", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 5, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "1200", "1300")],
    },
    // ENGL1010-001: MWF 12:20-13:10, 3 credits, open seats — target match for
    // find-sections-by-schedule's credits+days_within+starts_at test. Not in
    // any explicit_courses list, so it's invisible to find-eligible-sections.
    {
      term: TERM, termDescription: "Fall 2026", crn: "90020", subjectCourse: "ENGL1010",
      section: "001", title: "Composition", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("MWF", "1220", "1310")],
    },
  ],
};
SNAP.sectionCount = SNAP.sections.length;
writeScheduleDb(SNAP);

// ---------------------------------------------------------------------------
// get-program-requirements — reads requirement_rule rows for minors/
// certificates (and the GC BS) directly from the gc_advisor.db fixture, with
// no schedule DB / ATTACH involved.
// ---------------------------------------------------------------------------

async function callRequirements(args: Record<string, unknown>) {
  const res = await getProgramRequirements.handler(args);
  return {
    res,
    body: res.isError
      ? null
      : (JSON.parse((res.content[0] as { text: string }).text) as {
          program?: string;
          catalog_year?: string;
          requirements?: Array<Record<string, unknown>>;
          candidates?: string[];
          query?: string;
        }),
  };
}

test("get-program-requirements: exact name returns the parsed rule", async () => {
  const { body } = await callRequirements({ name: ACCOUNTING_MINOR });
  assert.ok(body);
  assert.equal(body!.program, ACCOUNTING_MINOR);
  assert.equal(body!.catalog_year, "2025-2026");
  assert.ok(body!.requirements);
  assert.equal(body!.requirements!.length, 1);
  const rule = body!.requirements![0];
  assert.equal(rule.slot_type, "program_requirement");
  assert.equal(rule.total_credits, 18);
  assert.deepEqual(rule.required_courses, ["ACCT 2010", "ACCT 3110", "ACCT 3120"]);
});

test("get-program-requirements: exact name is case-insensitive", async () => {
  const { body } = await callRequirements({ name: "accounting minor" });
  assert.ok(body);
  assert.equal(body!.program, ACCOUNTING_MINOR);
});

test("get-program-requirements: partial name matching >1 program returns candidates, not requirements", async () => {
  const { body } = await callRequirements({ name: "Account" });
  assert.ok(body);
  assert.equal(body!.requirements, undefined);
  assert.ok(body!.candidates);
  assert.ok(body!.candidates!.includes(ACCOUNTING_MINOR));
  assert.ok(body!.candidates!.includes("Accounting Certificate"));
});

test("get-program-requirements: name matching nothing returns a clear error", async () => {
  const { res } = await callRequirements({ name: "Underwater Basket Weaving Minor" });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /No Clemson program matches/);
});

test("get-program-requirements: missing name returns a clear error", async () => {
  const res = await getProgramRequirements.handler({});
  assert.equal(res.isError, true);
});

// get-schedule-freshness: reports the snapshot's data_as_of + age with no
// Banner load, and says so plainly when a term has not been ingested.
async function freshness(args: Record<string, unknown>) {
  const res = await scheduleFreshness.handler(args);
  assert.notEqual(res.isError, true, (res.content[0] as { text: string }).text);
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

test("get-schedule-freshness reports data_as_of and age for an ingested term", async () => {
  const out = await freshness({ term: TERM });
  assert.equal(out.has_snapshot, true);
  assert.equal(out.data_as_of, SNAP.fetchedAt);
  assert.equal(out.term_description, "Fall 2026");
  assert.equal(typeof out.age_hours, "number");
  assert.ok((out.age_hours as number) >= 0);
});

test("get-schedule-freshness reports has_snapshot:false for a term with no snapshot", async () => {
  const out = await freshness({ term: "209999" });
  assert.equal(out.has_snapshot, false);
  assert.equal(out.data_as_of, undefined);
  assert.match(String(out.note), /no banner snapshot/i);
});

test("get-schedule-freshness requires a term", async () => {
  const res = await scheduleFreshness.handler({});
  assert.equal(res.isError, true);
});

// overlayLiveSeats: the opt-in live-seat overlay behind refresh:true. Tested
// in isolation with a stub live fetcher (no Banner) so the mapping, capping,
// and partial-failure behavior are deterministic.
type StubSection = { crn: string; subject_course: string; seats_available: number; enrollment: number; max_enrollment: number; open: boolean };

function stubLive(seatsByCrn: Record<string, { enrollment: number; maxEnrollment: number; seatsAvailable: number; open: boolean }>) {
  // Returns a fetcher that answers per-subject with only that subject's CRNs.
  return async ({ subject }: { subject?: string }) => {
    const sections = Object.entries(seatsByCrn)
      .filter(([crn]) => crn.startsWith(subject ?? ""))
      .map(([crn, s]) => ({ crn, subjectCourse: subject, ...s }));
    return { totalCount: sections.length, sections, snapshotDate: null, scope: "live" as const };
  };
}

function sect(crn: string, subjectCourse: string): StubSection {
  return { crn, subject_course: subjectCourse, seats_available: 1, enrollment: 19, max_enrollment: 20, open: true };
}

test("overlayLiveSeats overlays live seats onto matching CRNs and reports the count", async () => {
  const sections = [sect("GC1", "GC 3010"), sect("GC2", "GC 3020")];
  const summary = await overlayLiveSeats(
    "202608",
    sections,
    stubLive({ GC1: { enrollment: 20, maxEnrollment: 20, seatsAvailable: 0, open: false }, GC2: { enrollment: 5, maxEnrollment: 20, seatsAvailable: 15, open: true } }),
  );
  assert.equal(summary.refreshed, true);
  assert.equal(summary.crns_updated, 2);
  assert.equal(summary.crns_stale, 0);
  assert.equal(typeof summary.seats_as_of, "string");
  // Seats overlaid in place.
  assert.equal(sections[0].seats_available, 0);
  assert.equal(sections[0].open, false);
  assert.equal(sections[1].enrollment, 5);
});

test("overlayLiveSeats leaves unmatched CRNs stale", async () => {
  const sections = [sect("GC1", "GC 3010"), sect("GC9", "GC 3090")];
  const summary = await overlayLiveSeats(
    "202608",
    sections,
    stubLive({ GC1: { enrollment: 20, maxEnrollment: 20, seatsAvailable: 0, open: false } }),
  );
  assert.equal(summary.crns_updated, 1);
  assert.equal(summary.crns_stale, 1);
  assert.equal(sections[1].seats_available, 1, "unmatched CRN keeps its snapshot seats");
  assert.match(String(summary.note), /snapshot seats/i);
});

test("overlayLiveSeats declines when a result spans too many subjects", async () => {
  // Distinct ALPHA subject prefixes (subjectOf stops at the first digit, so
  // "SUB0"/"SUB1" would collapse to one subject — use AAA, BBB, ...).
  const many = Array.from({ length: MAX_REFRESH_SUBJECTS + 1 }, (_, i) =>
    sect("X" + i, `${String.fromCharCode(65 + i).repeat(3)} 1000`),
  );
  const summary = await overlayLiveSeats("202608", many, stubLive({}));
  assert.equal(summary.refreshed, false);
  assert.equal(summary.reason, "too_many_subjects");
  assert.equal(summary.subject_count, MAX_REFRESH_SUBJECTS + 1);
  // Nothing was mutated.
  assert.equal(many[0].seats_available, 1);
});

test("overlayLiveSeats survives a failed subject query, marking those CRNs stale", async () => {
  const sections = [sect("GC1", "GC 3010"), sect("EN1", "ENGL 1010")];
  const failing = async ({ subject }: { subject?: string }) => {
    if (subject === "ENGL") throw new Error("Banner timeout");
    return { totalCount: 1, sections: [{ crn: "GC1", subjectCourse: "GC", enrollment: 20, maxEnrollment: 20, seatsAvailable: 0, open: false }], snapshotDate: null, scope: "live" as const };
  };
  const summary = await overlayLiveSeats("202608", sections, failing);
  assert.equal(summary.crns_updated, 1);
  assert.equal(summary.crns_stale, 1);
  assert.deepEqual(summary.subjects_failed, ["ENGL"]);
  assert.equal(sections[0].seats_available, 0);
  assert.equal(sections[1].seats_available, 1);
});
