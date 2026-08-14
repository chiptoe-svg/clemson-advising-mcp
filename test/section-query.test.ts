// test/section-query.test.ts
//
// querySectionsEngine: the shared section-query engine every new front-door
// tool composes on top of (Task 2 of the MCP-tool-surface rebuild). Builds a
// hermetic fixture Banner schedule snapshot DB via writeScheduleDb (same
// pattern as test/clemson-advising.test.ts / test/clemson-schedule-db.test.ts)
// under a temp STATE_DIR, then exercises each filter independently, a
// combined case, the needs_narrowing envelope, and the missing-snapshot error.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuassistant-section-query-"));
process.env.STATE_DIR = TMP;

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { querySectionsEngine } = await import("../src/mcp-tools/section-query.ts");
import type { ClemsonTermSnapshot } from "../src/clemson-classes.ts";
import type { EngineResult, EngineSection } from "../src/mcp-tools/section-query.ts";

const TERM = "202608";
const NARROW_TERM = "202609"; // separate term, dedicated to the needs_narrowing case

function meeting(
  days: string,
  beginTime: string,
  endTime: string,
  building = "Lee Hall",
  room = "100",
) {
  return {
    days,
    beginTime,
    endTime,
    building,
    room,
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
    enrollment: 5,
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

// ---------------------------------------------------------------------------
// Primary fixture (TERM): one section per filter behavior, plus a fit-around
// anchor pair.
// ---------------------------------------------------------------------------

const SNAP: ClemsonTermSnapshot = {
  term: TERM,
  termDescription: "Fall 2026",
  fetchedAt: "2026-07-20T05:00:00.000Z",
  sectionCount: 0,
  sections: [
    // Baseline GC section — subject filter target.
    section({
      crn: "20001",
      subjectCourse: "GC1010",
      title: "Intro to GC",
      creditHours: 3,
      seatsAvailable: 10,
      instructors: [{ name: "Jane Smith", email: null, primary: true }],
      meetings: [meeting("MWF", "0900", "0950")],
    }),
    // Instructor + buildingRoom filter target.
    section({
      crn: "20002",
      subjectCourse: "GC1020",
      title: "GC Lab",
      creditHours: 3,
      seatsAvailable: 10,
      instructors: [{ name: "Bob Jones", email: null, primary: true }],
      meetings: [meeting("TR", "1300", "1350", "Barre Hall", "200")],
    }),
    // Closed section — openSeatsOnly must exclude this.
    section({
      crn: "20003",
      subjectCourse: "GC1030",
      title: "Closed Section",
      creditHours: 3,
      seatsAvailable: 0,
      enrollment: 20,
      maxEnrollment: 20,
      open: false,
      meetings: [meeting("MW", "1000", "1050")],
    }),
    // 4-credit section — credits filter must distinguish this from the
    // 3-credit sections above.
    section({
      crn: "20004",
      subjectCourse: "GC1040",
      title: "Four Credit Course",
      creditHours: 4,
      seatsAvailable: 5,
      meetings: [meeting("MWF", "1100", "1150")],
    }),
    // Pre-9:00 meeting — noMeetingBefore target.
    section({
      crn: "20005",
      subjectCourse: "GC1050",
      title: "Early Bird",
      creditHours: 3,
      seatsAvailable: 5,
      meetings: [meeting("M", "0700", "0750")],
    }),
    // MW meeting — fits within a "MWF" days filter (subset).
    section({
      crn: "20006",
      subjectCourse: "GC1060",
      title: "MWF Fit",
      creditHours: 3,
      seatsAvailable: 5,
      meetings: [meeting("MW", "0930", "1020")],
    }),
    // Tuesday meeting — does NOT fit a "MWF" days filter (T not in set).
    section({
      crn: "20007",
      subjectCourse: "GC1070",
      title: "Tuesday Course",
      creditHours: 3,
      seatsAvailable: 5,
      meetings: [meeting("T", "0930", "1020")],
    }),
    // Overlaps anchor 20010's MW 10:00-11:00 meeting — fitsAroundCrns must
    // exclude this.
    section({
      crn: "20008",
      subjectCourse: "GC1080",
      title: "Overlap Course",
      creditHours: 3,
      seatsAvailable: 5,
      meetings: [meeting("MW", "1030", "1130")],
    }),
    // Clear of both anchors — fitsAroundCrns must include this.
    section({
      crn: "20009",
      subjectCourse: "GC1090",
      title: "Clear Course",
      creditHours: 3,
      seatsAvailable: 5,
      meetings: [meeting("MW", "1200", "1250")],
    }),
    // Anchor 1 (student's current schedule) — not itself a candidate.
    section({
      crn: "20010",
      subjectCourse: "MATH1060",
      title: "Trig",
      creditHours: 3,
      seatsAvailable: 5,
      meetings: [meeting("MW", "1000", "1100")],
    }),
    // Anchor 2 (student's current schedule) — not itself a candidate.
    section({
      crn: "20011",
      subjectCourse: "MATH1080",
      title: "Calc",
      creditHours: 3,
      seatsAvailable: 5,
      meetings: [meeting("TR", "1300", "1400")],
    }),
    // Subject-discipline sections: "AS" (no courseNumber) must match this
    // via the spaceless subject_course GLOB anchor...
    section({
      crn: "20012",
      subjectCourse: "AS1010",
      title: "Air Force Leadership",
      creditHours: 1,
      seatsAvailable: 5,
      meetings: [meeting("M", "1300", "1350")],
    }),
    // ...but must NOT match this (real prefix clash: AS vs ASTR).
    section({
      crn: "20013",
      subjectCourse: "ASTR1010",
      title: "Intro Astronomy",
      creditHours: 3,
      seatsAvailable: 5,
      meetings: [meeting("T", "1300", "1350")],
    }),
  ],
};
SNAP.sectionCount = SNAP.sections.length;
writeScheduleDb(SNAP);

// ---------------------------------------------------------------------------
// Narrowing fixture (NARROW_TERM): sections with varying counts per subject
// so an unfiltered query trips needs_narrowing, and bySubject ordering can be
// verified. Designed to have counts: GC(6), MATH(5), CPSC(4), ENGL(3).
// ---------------------------------------------------------------------------

const NARROW_SUBJECTS = ["GC", "GC", "GC", "GC", "GC", "GC", "MATH", "MATH", "MATH", "MATH", "MATH", "CPSC", "CPSC", "CPSC", "CPSC", "ENGL", "ENGL", "ENGL"];
const NARROW_SNAP: ClemsonTermSnapshot = {
  term: NARROW_TERM,
  termDescription: "Spring 2027",
  fetchedAt: "2026-07-21T05:00:00.000Z",
  sectionCount: 0,
  sections: Array.from({ length: NARROW_SUBJECTS.length }, (_, i) => {
    const subj = NARROW_SUBJECTS[i];
    return {
      ...section({
        crn: `3${String(i).padStart(4, "0")}`,
        subjectCourse: `${subj}${1000 + i}`,
        title: `Narrow Course ${i}`,
        seatsAvailable: 10,
        meetings: [meeting("MWF", "0900", "0950")],
      }),
      term: NARROW_TERM,
      termDescription: "Spring 2027",
    };
  }),
};
NARROW_SNAP.sectionCount = NARROW_SNAP.sections.length;
writeScheduleDb(NARROW_SNAP);

// ---------------------------------------------------------------------------
// Narrowing fixture for cap test (NARROW_TERM, appended): 15 subjects with
// distinct counts so capping to 12 can be verified.
// ---------------------------------------------------------------------------

const CAP_TEST_TERM = "202610";
const CAP_SUBJECTS = [
  "GC", "GC", "GC", "GC", "GC", // 5
  "CPSC", "CPSC", "CPSC", "CPSC", // 4
  "MATH", "MATH", "MATH", // 3
  "ENGL", "ENGL", // 2
  "HIST", "HIST", "HIST", "HIST", "HIST", "HIST", // 6
  "PHYS", "PHYS", "PHYS", "PHYS", "PHYS", "PHYS", "PHYS", // 7
  "CHEM", "CHEM", "CHEM", "CHEM", "CHEM", "CHEM", "CHEM", "CHEM", // 8
  "BIO", "BIO", "BIO", "BIO", "BIO", "BIO", "BIO", "BIO", "BIO", // 9
  "PSY", "PSY", "PSY", "PSY", "PSY", "PSY", "PSY", "PSY", "PSY", "PSY", // 10
  "SOC", "SOC", "SOC", "SOC", "SOC", "SOC", "SOC", "SOC", "SOC", "SOC", "SOC", // 11
  "ECON", "ECON", "ECON", "ECON", "ECON", "ECON", "ECON", "ECON", "ECON", "ECON", "ECON", "ECON", // 12
  "POLI", "POLI", "POLI", "POLI", "POLI", "POLI", "POLI", "POLI", "POLI", "POLI", "POLI", "POLI", "POLI", // 13
  "ART", "ART", "ART", "ART", "ART", "ART", "ART", "ART", "ART", "ART", "ART", "ART", "ART", "ART", // 14
  "MUS", "MUS", "MUS", "MUS", "MUS", "MUS", "MUS", "MUS", "MUS", "MUS", "MUS", "MUS", "MUS", "MUS", "MUS", // 15
];
const CAP_SNAP: ClemsonTermSnapshot = {
  term: CAP_TEST_TERM,
  termDescription: "Summer 2027",
  fetchedAt: "2026-07-22T05:00:00.000Z",
  sectionCount: 0,
  sections: Array.from({ length: CAP_SUBJECTS.length }, (_, i) => {
    const subj = CAP_SUBJECTS[i];
    return {
      ...section({
        crn: `4${String(i).padStart(4, "0")}`,
        subjectCourse: `${subj}${1000 + i}`,
        title: `Cap Test Course ${i}`,
        seatsAvailable: 10,
        meetings: [meeting("MWF", "0900", "0950")],
      }),
      term: CAP_TEST_TERM,
      termDescription: "Summer 2027",
    };
  }),
};
CAP_SNAP.sectionCount = CAP_SNAP.sections.length;
writeScheduleDb(CAP_SNAP);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isError(x: EngineResult | { error: string }): x is { error: string } {
  return "error" in x;
}

function crns(sections: EngineSection[]): string[] {
  return sections.map((s) => s.crn).sort();
}

function ok(result: EngineResult | { error: string }): EngineResult {
  assert.ok(!isError(result), isError(result) ? result.error : "");
  return result as EngineResult;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("missing snapshot DB for the term returns an error naming the term", () => {
  const result = querySectionsEngine({ term: "999999" });
  assert.ok(isError(result));
  if (isError(result)) assert.match(result.error, /999999/);
});

test("subject filter: GC matches GC-prefixed courses only", () => {
  const result = ok(querySectionsEngine({ term: TERM, subject: "GC" }));
  assert.ok(result.sections.every((s) => s.subjectCourse.startsWith("GC")));
  assert.ok(result.sections.some((s) => s.crn === "20001"));
  assert.ok(!result.sections.some((s) => s.crn === "20010")); // MATH, excluded
});

test("subject filter: AS matches AS-prefixed courses but NOT ASTR (alpha->digit boundary)", () => {
  const result = ok(querySectionsEngine({ term: TERM, subject: "AS" }));
  assert.deepEqual(crns(result.sections), ["20012"]);
});

test("subject + courseNumber: exact spaceless match", () => {
  const result = ok(
    querySectionsEngine({ term: TERM, subject: "GC", courseNumber: "1010" }),
  );
  assert.deepEqual(crns(result.sections), ["20001"]);
});

test("openSeatsOnly excludes the closed section", () => {
  const result = ok(
    querySectionsEngine({ term: TERM, subject: "GC", openSeatsOnly: true }),
  );
  assert.ok(!result.sections.some((s) => s.crn === "20003"));
  assert.ok(result.sections.some((s) => s.crn === "20001"));
});

test("credits filter matches within 0.01 and excludes other credit values", () => {
  const result = ok(querySectionsEngine({ term: TERM, subject: "GC", credits: 4 }));
  assert.deepEqual(crns(result.sections), ["20004"]);
});

test("instructor filter: substring, case-insensitive against the instructors table", () => {
  const result = ok(querySectionsEngine({ term: TERM, instructor: "jones" }));
  assert.deepEqual(crns(result.sections), ["20002"]);
  assert.deepEqual(result.sections[0].instructors, ["Bob Jones"]);
});

test("buildingRoom filter: substring match on meetings building+room", () => {
  const result = ok(querySectionsEngine({ term: TERM, buildingRoom: "barre" }));
  assert.deepEqual(crns(result.sections), ["20002"]);
});

test("buildingRoom filter matches on room number too", () => {
  const result = ok(querySectionsEngine({ term: TERM, buildingRoom: "200" }));
  assert.deepEqual(crns(result.sections), ["20002"]);
});

test("days filter: MW section fits within MWF, T section does not", () => {
  const result = ok(
    querySectionsEngine({ term: TERM, subject: "GC", days: "MWF" }),
  );
  assert.ok(result.sections.some((s) => s.crn === "20006")); // MW fits
  assert.ok(!result.sections.some((s) => s.crn === "20007")); // T does not fit
});

test("days filter: MWF section does NOT fit within MW (EVERY-day semantics)", () => {
  const result = ok(
    querySectionsEngine({ term: TERM, subject: "GC", days: "MW" }),
  );
  assert.ok(!result.sections.some((s) => s.crn === "20001")); // MWF has F, outside set
  assert.ok(result.sections.some((s) => s.crn === "20006")); // MW fits
});

test("excludeDays excludes any section meeting on one of the given days", () => {
  const result = ok(
    querySectionsEngine({ term: TERM, subject: "GC", excludeDays: ["F"] }),
  );
  assert.ok(!result.sections.some((s) => s.crn === "20001")); // MWF -> has F
  assert.ok(result.sections.some((s) => s.crn === "20002")); // TR -> no F
});

test("noMeetingBefore excludes a section with any meeting starting earlier", () => {
  const result = ok(
    querySectionsEngine({ term: TERM, subject: "GC", noMeetingBefore: "0900" }),
  );
  assert.ok(!result.sections.some((s) => s.crn === "20005")); // starts 0700
  assert.ok(result.sections.some((s) => s.crn === "20001")); // starts 0900
});

test("noMeetingAfter excludes a section with any meeting ending later", () => {
  const result = ok(
    querySectionsEngine({ term: TERM, subject: "GC", noMeetingAfter: "1000" }),
  );
  assert.ok(!result.sections.some((s) => s.crn === "20004")); // ends 1150
  assert.ok(result.sections.some((s) => s.crn === "20001")); // ends 0950
});

test("fitsAroundCrns excludes an overlapping section, includes a clear one, excludes the anchors themselves", () => {
  const result = ok(
    querySectionsEngine({ term: TERM, fitsAroundCrns: ["20010", "20011"] }),
  );
  assert.ok(!result.sections.some((s) => s.crn === "20008")); // overlaps anchor 20010
  assert.ok(result.sections.some((s) => s.crn === "20009")); // clear
  assert.ok(!result.sections.some((s) => s.crn === "20010")); // anchor itself excluded
  assert.ok(!result.sections.some((s) => s.crn === "20011")); // anchor itself excluded
});

test("combined filters: subject + openSeatsOnly + credits narrows to the matching set", () => {
  const result = ok(
    querySectionsEngine({
      term: TERM,
      subject: "GC",
      openSeatsOnly: true,
      credits: 3,
    }),
  );
  // 20003 excluded (closed), 20004 excluded (4 credits) -> the rest of the
  // 3-credit open GC sections remain.
  assert.ok(!result.sections.some((s) => s.crn === "20003"));
  assert.ok(!result.sections.some((s) => s.crn === "20004"));
  assert.ok(result.sections.some((s) => s.crn === "20001"));
  assert.ok(result.sections.every((s) => s.creditHours === 3 && s.seatsAvailable > 0));
});

test("EngineSection carries crn/subjectCourse/title/creditHours/seatsAvailable/instructors/meetings", () => {
  const result = ok(
    querySectionsEngine({ term: TERM, subject: "GC", courseNumber: "1010" }),
  );
  const s = result.sections[0];
  assert.equal(s.crn, "20001");
  assert.equal(s.subjectCourse, "GC1010");
  assert.equal(s.title, "Intro to GC");
  assert.equal(s.creditHours, 3);
  assert.equal(s.seatsAvailable, 10);
  assert.deepEqual(s.instructors, ["Jane Smith"]);
  assert.deepEqual(s.meetings, [
    { day: "M", start: "0900", end: "0950", building: "Lee Hall", room: "100" },
    { day: "W", start: "0900", end: "0950", building: "Lee Hall", room: "100" },
    { day: "F", start: "0900", end: "0950", building: "Lee Hall", room: "100" },
  ]);
});

test("needsNarrowing envelope: >15 matches returns total + bySubject instead of a section list", () => {
  const result = ok(querySectionsEngine({ term: NARROW_TERM }));
  assert.equal(result.totalCount, 18);
  assert.deepEqual(result.sections, []);
  assert.ok(result.needsNarrowing);
  assert.equal(result.needsNarrowing?.total, 18);
  // Verify bySubject is sorted descending by count AND preserves order (insertion order in JS object)
  const subjectKeys = Object.keys(result.needsNarrowing?.bySubject || {});
  assert.deepEqual(result.needsNarrowing?.bySubject, {
    GC: 6,
    MATH: 5,
    CPSC: 4,
    ENGL: 3,
  });
  assert.deepEqual(subjectKeys, ["GC", "MATH", "CPSC", "ENGL"]);
});

test("needsNarrowing does not trip once narrowed below the threshold", () => {
  const result = ok(querySectionsEngine({ term: NARROW_TERM, subject: "GC" }));
  assert.equal(result.totalCount, 6);
  assert.equal(result.needsNarrowing, undefined);
  assert.equal(result.sections.length, 6);
});

test("needsNarrowing bySubject capped to top 12 subjects by count descending", () => {
  const result = ok(querySectionsEngine({ term: CAP_TEST_TERM }));
  assert.ok(result.needsNarrowing);
  const subjectKeys = Object.keys(result.needsNarrowing?.bySubject || {});
  // Verify exactly 12 subjects returned (capped)
  assert.equal(subjectKeys.length, 12);
  // Verify ordered by count descending
  const counts = Object.values(result.needsNarrowing?.bySubject || {});
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i - 1] >= counts[i], `Count order violation: ${counts[i - 1]} < ${counts[i]}`);
  }
  // Verify top subject is MUS (15 sections)
  assert.equal(subjectKeys[0], "MUS");
  // Verify 13th subject (MATH with 3 sections) is NOT included
  assert.ok(!subjectKeys.includes("MATH"));
  // Verify CPSC (4 sections, 12th) is included
  assert.ok(subjectKeys.includes("CPSC"));
});

test("snapshotDate is populated from the snapshot's fetchedAt", () => {
  const result = ok(querySectionsEngine({ term: TERM, subject: "GC" }));
  assert.equal(result.snapshotDate, "2026-07-20T05:00:00.000Z");
});
