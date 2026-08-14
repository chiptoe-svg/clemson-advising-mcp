// test/core-search.test.ts
//
// The four 8766 front-door tools (Task 5 of the MCP-tool-surface rebuild):
// search-classes, find-alternatives, check-conflicts, get-course-details.
// Builds a hermetic fixture Banner schedule snapshot DB via writeScheduleDb
// (same pattern as test/section-query.test.ts) under a temp STATE_DIR, then
// exercises: tool registration + literal description substrings, the term
// resolver ("Spring 2027" -> 202701), find-alternatives fit filtering,
// check-conflicts against a direct findConflicts computation plus the
// unknown-CRN redirect, get-course-details routing via injected deps, and
// each tool's missing-discriminator redirect. See
// .superpowers/sdd/task-5-brief.md.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuassistant-core-search-"));
process.env.STATE_DIR = TMP;

const {
  writeScheduleDb,
  openScheduleDb,
  getMeetingsForCrns,
  findConflicts,
} = await import("../src/clemson-schedule-db.ts");
const {
  searchClasses,
  findAlternatives,
  checkConflicts,
  getCourseDetails,
  makeGetCourseDetails,
  makeSearchClasses,
} = await import("../src/mcp-tools/core-search.ts");
const { toolsForScope } = await import("../src/mcp-tools/server.ts");
const { allExposedOperations } = await import("../src/mcp-tools/permissions.ts");
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ClemsonTermSnapshot,
  ClemsonSearchResult,
} from "../src/clemson-classes.ts";

const TERM = "202701"; // Spring 2027

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
    termDescription: "Spring 2027",
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

const SNAP: ClemsonTermSnapshot = {
  term: TERM,
  termDescription: "Spring 2027",
  fetchedAt: "2026-07-20T05:00:00.000Z",
  sectionCount: 0,
  sections: [
    // search-classes resolver target.
    section({
      crn: "30001",
      subjectCourse: "GC1010",
      title: "Intro to GC",
      creditHours: 3,
      seatsAvailable: 10,
      instructors: [{ name: "Jane Smith", email: null, primary: true }],
      meetings: [meeting("MWF", "0900", "0950")],
    }),
    // Conflicting pair for check-conflicts: overlaps 1030-1100 on M and W.
    section({
      crn: "30010",
      subjectCourse: "MATH1060",
      title: "Trig A",
      meetings: [meeting("MW", "1000", "1100")],
    }),
    section({
      crn: "30011",
      subjectCourse: "MATH1070",
      title: "Trig B",
      meetings: [meeting("MW", "1030", "1130")],
    }),
    // Clear of 30010/30011 — candidate_crns conflict-free target.
    section({
      crn: "30012",
      subjectCourse: "MATH1080",
      title: "Calc",
      meetings: [meeting("TR", "1300", "1400")],
    }),
    // Anchor (student's current schedule) for find-alternatives.
    section({
      crn: "30020",
      subjectCourse: "ENGL1010",
      title: "Composition",
      meetings: [meeting("MW", "1000", "1100")],
    }),
    // Overlaps the anchor — find-alternatives must exclude this.
    section({
      crn: "30021",
      subjectCourse: "GC1020",
      title: "GC Lab",
      meetings: [meeting("MW", "1030", "1130")],
    }),
    // Clear of the anchor — find-alternatives must include this.
    section({
      crn: "30022",
      subjectCourse: "GC1030",
      title: "GC Studio",
      meetings: [meeting("MW", "1200", "1250")],
    }),
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

function crns(sections: Array<{ crn: string }>): string[] {
  return sections.map((s) => s.crn).sort();
}

// ---------------------------------------------------------------------------
// Registration + literal description substrings
// ---------------------------------------------------------------------------

test("all four front doors are registered with exact kebab-case names", () => {
  assert.equal(searchClasses.tool.name, "search-classes");
  assert.equal(findAlternatives.tool.name, "find-alternatives");
  assert.equal(checkConflicts.tool.name, "check-conflicts");
  assert.equal(getCourseDetails.tool.name, "get-course-details");
});

test("all four front doors pass policy and appear in the exposed tool list", () => {
  const names = toolsForScope(allExposedOperations()).map((t) => t.name);
  assert.ok(names.includes("search-classes"));
  assert.ok(names.includes("find-alternatives"));
  assert.ok(names.includes("check-conflicts"));
  assert.ok(names.includes("get-course-details"));
});

test("search-classes: description names the discriminator and both siblings", () => {
  const desc = searchClasses.tool.description ?? "";
  assert.match(desc, /subject and\/or course number/);
  assert.match(desc, /check-conflicts/);
  assert.match(desc, /find-alternatives/);
});

test("find-alternatives: description names current_crns as required", () => {
  const desc = findAlternatives.tool.description ?? "";
  assert.match(desc, /Requires current_crns/);
});

test("check-conflicts: description names pair-by-pair + candidate_crns", () => {
  const desc = checkConflicts.tool.description ?? "";
  assert.match(desc, /pair by pair/);
  assert.match(desc, /candidate_crns/);
});

test("get-course-details: description routes course_code vs crn and points at search-classes", () => {
  const desc = getCourseDetails.tool.description ?? "";
  assert.match(desc, /course_code/);
  assert.match(desc, /crn for a specific section/);
  assert.match(desc, /search-classes/);
});

// ---------------------------------------------------------------------------
// search-classes: term resolver + missing discriminator
// ---------------------------------------------------------------------------

test("search-classes: 'Spring 2027' resolves to the 202701 fixture and returns its sections", async () => {
  const res = await searchClasses.handler({ term: "Spring 2027", subject: "GC" });
  const body = json(res);
  assert.ok(crns(body.sections).includes("30001"));
  assert.equal(
    body.sections.find((s: any) => s.crn === "30001").subjectCourse,
    "GC1010",
  );
});

test("search-classes: EngineSection fields are present on each result", async () => {
  const res = await searchClasses.handler({
    term: "Spring 2027",
    subject: "GC",
    course_number: "1010",
  });
  const body = json(res);
  const s = body.sections.find((x: any) => x.crn === "30001");
  assert.equal(s.crn, "30001");
  assert.equal(s.subjectCourse, "GC1010");
  assert.equal(s.title, "Intro to GC");
  assert.equal(s.creditHours, 3);
  assert.equal(s.seatsAvailable, 10);
  assert.deepEqual(s.instructors, ["Jane Smith"]);
  assert.ok(Array.isArray(s.meetings) && s.meetings.length === 3);
});

test("search-classes: refresh:true post-filters live results by instructor", async () => {
  const liveSections = [
    section({
      crn: "40001",
      subjectCourse: "GC1010",
      instructors: [{ name: "Jane Smith", email: null, primary: true }],
      meetings: [meeting("MWF", "0900", "0950")],
    }),
    section({
      crn: "40002",
      subjectCourse: "GC1010",
      instructors: [{ name: "Bob Jones", email: null, primary: true }],
      meetings: [meeting("MWF", "0900", "0950")],
    }),
  ];
  const searchLive = async (): Promise<ClemsonSearchResult> => ({
    totalCount: liveSections.length,
    sections: liveSections,
    snapshotDate: null,
    scope: "live",
  });
  const tool = makeSearchClasses({ searchLive });

  const res = await tool.handler({
    term: "Spring 2027",
    subject: "GC",
    refresh: true,
    instructor: "smith",
  });
  const body = json(res);
  assert.deepEqual(crns(body.sections), ["40001"]);
  assert.equal(body.totalCount, 1); // recomputed post-filter, not Banner's pre-filter count
  assert.equal(body.scope, "live");
});

test("search-classes: refresh:true post-filters live results by building_room", async () => {
  const liveSections = [
    section({
      crn: "40010",
      subjectCourse: "GC1010",
      meetings: [meeting("MWF", "0900", "0950", "Godfrey Hall", "205")],
    }),
    section({
      crn: "40011",
      subjectCourse: "GC1010",
      meetings: [meeting("MWF", "0900", "0950", "Lee Hall", "100")],
    }),
  ];
  const searchLive = async (): Promise<ClemsonSearchResult> => ({
    totalCount: liveSections.length,
    sections: liveSections,
    snapshotDate: null,
    scope: "live",
  });
  const tool = makeSearchClasses({ searchLive });

  const res = await tool.handler({
    term: "Spring 2027",
    subject: "GC",
    refresh: true,
    building_room: "godfrey",
  });
  const body = json(res);
  assert.deepEqual(crns(body.sections), ["40010"]);
  assert.equal(body.totalCount, 1);
});

test("search-classes: refresh:true post-filters live results by days (every meeting day must be within the set)", async () => {
  const liveSections = [
    section({
      crn: "40020",
      subjectCourse: "GC1010",
      meetings: [meeting("MW", "1000", "1050")],
    }),
    section({
      crn: "40021",
      subjectCourse: "GC1010",
      meetings: [meeting("MWF", "1000", "1050")], // F isn't within "MW" -> violates
    }),
  ];
  const searchLive = async (): Promise<ClemsonSearchResult> => ({
    totalCount: liveSections.length,
    sections: liveSections,
    snapshotDate: null,
    scope: "live",
  });
  const tool = makeSearchClasses({ searchLive });

  const res = await tool.handler({
    term: "Spring 2027",
    subject: "GC",
    refresh: true,
    days: "MW",
  });
  const body = json(res);
  assert.deepEqual(crns(body.sections), ["40020"]);
  assert.equal(body.totalCount, 1);
});

test("search-classes: refresh:true post-filters live results by no_meeting_before", async () => {
  const liveSections = [
    section({
      crn: "40030",
      subjectCourse: "GC1010",
      meetings: [meeting("MWF", "0900", "0950")], // starts at the bound -> kept
    }),
    section({
      crn: "40031",
      subjectCourse: "GC1010",
      meetings: [meeting("MWF", "0800", "0850")], // starts earlier -> excluded
    }),
  ];
  const searchLive = async (): Promise<ClemsonSearchResult> => ({
    totalCount: liveSections.length,
    sections: liveSections,
    snapshotDate: null,
    scope: "live",
  });
  const tool = makeSearchClasses({ searchLive });

  const res = await tool.handler({
    term: "Spring 2027",
    subject: "GC",
    refresh: true,
    no_meeting_before: "0900",
  });
  const body = json(res);
  assert.deepEqual(crns(body.sections), ["40030"]);
  assert.equal(body.totalCount, 1);
});

test("search-classes: refresh:true post-filters live results by no_meeting_after", async () => {
  const liveSections = [
    section({
      crn: "40040",
      subjectCourse: "GC1010",
      meetings: [meeting("MWF", "1600", "1700")], // ends at the bound -> kept
    }),
    section({
      crn: "40041",
      subjectCourse: "GC1010",
      meetings: [meeting("MWF", "1630", "1730")], // ends later -> excluded
    }),
  ];
  const searchLive = async (): Promise<ClemsonSearchResult> => ({
    totalCount: liveSections.length,
    sections: liveSections,
    snapshotDate: null,
    scope: "live",
  });
  const tool = makeSearchClasses({ searchLive });

  const res = await tool.handler({
    term: "Spring 2027",
    subject: "GC",
    refresh: true,
    no_meeting_after: "1700",
  });
  const body = json(res);
  assert.deepEqual(crns(body.sections), ["40040"]);
  assert.equal(body.totalCount, 1);
});

test("search-classes: an unrecognized term returns the TermError redirect verbatim", async () => {
  const res = await searchClasses.handler({ term: "not a term", subject: "GC" });
  assert.match(errText(res), /Unrecognized term/);
});

test("search-classes: missing subject AND course_number returns the redirect error", async () => {
  const res = await searchClasses.handler({ term: "Spring 2027" });
  assert.match(errText(res), /subject or course_number is required/);
});

// ---------------------------------------------------------------------------
// find-alternatives: fits-around filtering + missing discriminator
// ---------------------------------------------------------------------------

test("find-alternatives: excludes an overlapping section, includes a clear one, excludes the anchor itself", async () => {
  const res = await findAlternatives.handler({
    term: "Spring 2027",
    current_crns: ["30020"],
  });
  const body = json(res);
  assert.ok(!body.sections.some((s: any) => s.crn === "30021")); // overlaps anchor
  assert.ok(body.sections.some((s: any) => s.crn === "30022")); // clear
  assert.ok(!body.sections.some((s: any) => s.crn === "30020")); // anchor itself
});

test("find-alternatives: missing current_crns returns the redirect error", async () => {
  const res = await findAlternatives.handler({ term: "Spring 2027" });
  assert.match(errText(res), /current_crns is required/);
});

// ---------------------------------------------------------------------------
// check-conflicts: verdict matches findConflicts + unknown CRN + candidates
// ---------------------------------------------------------------------------

test("check-conflicts: verdict matches a direct findConflicts computation", async () => {
  const db = openScheduleDb(TERM)!;
  const expected = findConflicts(getMeetingsForCrns(db, TERM, ["30010", "30011"]));
  db.close();

  const res = await checkConflicts.handler({
    term: "Spring 2027",
    crns: ["30010", "30011"],
  });
  const body = json(res);
  assert.deepEqual(body.conflicts, expected);
  assert.equal(body.has_conflicts, true);
  assert.deepEqual(body.conflict_free, []);
});

test("check-conflicts: a conflict-free set reports no conflicts", async () => {
  const res = await checkConflicts.handler({
    term: "Spring 2027",
    crns: ["30010", "30012"],
  });
  const body = json(res);
  assert.deepEqual(body.conflicts, []);
  assert.equal(body.has_conflicts, false);
  assert.deepEqual(body.conflict_free.sort(), ["30010", "30012"]);
});

test("check-conflicts: candidate_crns flags which candidates conflict with crns", async () => {
  const res = await checkConflicts.handler({
    term: "Spring 2027",
    crns: ["30010"],
    candidate_crns: ["30011", "30012"],
  });
  const body = json(res);
  const byC = Object.fromEntries(body.candidates.map((c: any) => [c.crn, c]));
  assert.equal(byC["30011"].conflict_free, false);
  assert.equal(byC["30012"].conflict_free, true);
});

test("check-conflicts: an unknown CRN returns an error naming it", async () => {
  const res = await checkConflicts.handler({
    term: "Spring 2027",
    crns: ["30010", "99999"],
  });
  assert.match(errText(res), /99999/);
});

test("check-conflicts: missing crns returns the redirect error", async () => {
  const res = await checkConflicts.handler({ term: "Spring 2027" });
  assert.match(errText(res), /crns is required/);
});

// ---------------------------------------------------------------------------
// get-course-details: routes course_code vs crn (injected deps) + missing discriminator
// ---------------------------------------------------------------------------

test("get-course-details: course_code routes to the GC catalog lookup, not the Banner section fetch", async () => {
  const courseCalls: string[] = [];
  const crnCalls: string[] = [];
  const tool = makeGetCourseDetails({
    getGcCourse: async (code: string) => {
      courseCalls.push(code);
      return { code, title: "Mock Course" };
    },
    getClemsonSectionDetails: async (term: string, crn: string) => {
      crnCalls.push(crn);
      return null;
    },
  });
  const res = await tool.handler({ term: "Spring 2027", course_code: "GC 3010" });
  const body = json(res);
  assert.deepEqual(courseCalls, ["GC 3010"]);
  assert.deepEqual(crnCalls, []);
  assert.equal(body.code, "GC 3010");
  assert.equal(body.title, "Mock Course");
});

test("get-course-details: crn routes to the Banner section fetch, not the GC catalog lookup", async () => {
  const courseCalls: string[] = [];
  const crnCalls: Array<{ term: string; crn: string }> = [];
  const tool = makeGetCourseDetails({
    getGcCourse: async (code: string) => {
      courseCalls.push(code);
      return { code };
    },
    getClemsonSectionDetails: async (term: string, crn: string) => {
      crnCalls.push({ term, crn });
      return {
        term,
        crn,
        description: "A section.",
        prerequisites: null,
        corequisites: null,
        restrictions: null,
        attributes: null,
        bookstoreUrl: null,
      };
    },
  });
  const res = await tool.handler({ term: "Spring 2027", crn: "30001" });
  const body = json(res);
  assert.deepEqual(courseCalls, []);
  assert.deepEqual(crnCalls, [{ term: TERM, crn: "30001" }]);
  assert.equal(body.description, "A section.");
});

test("get-course-details: missing course_code AND crn returns the redirect error", async () => {
  const res = await getCourseDetails.handler({ term: "Spring 2027" });
  assert.match(errText(res), /course_code or crn is required/);
});
