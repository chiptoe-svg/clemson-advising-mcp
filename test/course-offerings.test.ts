// get-course-offerings: offering history is RAW EVIDENCE from held snapshots,
// never an inferred pattern. The properties under test: observed_terms states
// exactly what was observed (a missing snapshot is unknown, not "not
// offered"); a course absent from an observed term is derivably
// observed-not-run; a course seen in no held snapshot says so explicitly; and
// codes normalize to the snapshot's spaceless form.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "course-offerings-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { __schedTools } = await import("../src/mcp-tools/clemson-schedule.ts");

function section(crn: string, course: string) {
  return {
    crn,
    subjectCourse: course,
    section: "001",
    title: `${course} title`,
    campus: "C",
    scheduleType: "Lecture",
    instructionalMethod: "F",
    creditHours: 3,
    enrollment: 5,
    maxEnrollment: 20,
    seatsAvailable: 15,
    waitCount: 0,
    waitCapacity: 0,
    open: true,
    meetings: [
      {
        days: "MWF",
        beginTime: "0900",
        endTime: "0950",
        building: "Hall",
        room: "1",
        type: "Class",
      },
    ],
    instructors: [{ name: "A Teacher", email: "t@clemson.edu", primary: true }],
  };
}

// Fall 2024: GC3400 runs twice, MATH1060 once. Fall 2026: only MATH1060.
writeScheduleDb({
  term: "202408",
  termDescription: "Fall 2024",
  fetchedAt: "2024-08-01T05:00:00Z",
  sectionCount: 3,
  sections: [
    section("50001", "GC3400"),
    section("50002", "GC3400"),
    section("50003", "MATH1060"),
  ],
});
writeScheduleDb({
  term: "202608",
  termDescription: "Fall 2026",
  fetchedAt: "2026-08-01T05:00:00Z",
  sectionCount: 1,
  sections: [section("60001", "MATH1060")],
});

async function offerings(courses: string[]) {
  const res = await __schedTools.courseOfferings.handler({ courses });
  assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]));
  return JSON.parse((res.content[0] as { text: string }).text) as {
    observed_terms: { term: string; data_as_of: string | null }[];
    courses: {
      code: string;
      offerings: { term: string; section_count: number }[];
      note?: string;
    }[];
  };
}

test("offering history is per observed term, with counts, keyed by normalized code", async () => {
  const b = await offerings(["GC 3400", "math1060"]);
  assert.deepEqual(
    b.observed_terms.map((t) => t.term),
    ["202408", "202608"],
  );
  assert.ok(b.observed_terms[0].data_as_of?.startsWith("2024-08-01"));
  const gc = b.courses.find((c) => c.code === "GC3400")!;
  // Ran in 202408 (2 sections); 202608 was OBSERVED and it did not run —
  // derivable because 202608 is in observed_terms but not in offerings.
  assert.deepEqual(gc.offerings, [{ term: "202408", section_count: 2 }]);
  const math = b.courses.find((c) => c.code === "MATH1060")!;
  assert.deepEqual(
    math.offerings.map((o) => o.term),
    ["202408", "202608"],
  );
});

test("a course seen in no held snapshot says so — and does not claim 'not offered'", async () => {
  const b = await offerings(["ARCH 9990"]);
  const [c] = b.courses;
  assert.deepEqual(c.offerings, []);
  assert.match(String(c.note), /unknown, not/);
  // observed_terms still states the ground that WAS covered.
  assert.equal(b.observed_terms.length, 2);
});

test("garbage codes are an error naming the offenders", async () => {
  const res = await __schedTools.courseOfferings.handler({
    courses: ["not a course"],
  });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /Not course codes/);
});

test("empty courses is an error, not an empty answer", async () => {
  const res = await __schedTools.courseOfferings.handler({ courses: [] });
  assert.equal(res.isError, true);
});
