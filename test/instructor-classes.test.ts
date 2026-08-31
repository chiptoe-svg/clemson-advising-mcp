// get-instructor-classes: "which of these faculty teach Friday 11-12?"
// as one deterministic call. The property under test throughout: absence is
// three-state — someone the snapshot has never heard of must never read as
// "free", and an ambiguous name must never silently become one person.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "instr-conflicts-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { __setTermClockForTest } = await import("../src/term-resolve.ts");
const { __schedTools } = await import("../src/mcp-tools/clemson-schedule.ts");

function section(
  crn: string,
  course: string,
  instructors: { name: string; email: string | null; primary: boolean }[],
  meetings: { days: string; beginTime: string; endTime: string }[],
) {
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
    meetings: meetings.map((m) => ({
      ...m,
      building: "Hall",
      room: "1",
      type: "Class",
    })),
    instructors,
  };
}

writeScheduleDb({
  term: "202608",
  termDescription: "Fall 2026",
  fetchedAt: new Date().toISOString(),
  sectionCount: 4,
  sections: [
    // Busy Friday 11:30-12:20 (overlaps an 11-12 window)
    section(
      "70001",
      "GC1010",
      [{ name: "Chip Tonkin III", email: "TONKIN@CLEMSON.EDU", primary: true }],
      [{ days: "MWF", beginTime: "1130", endTime: "1220" }],
    ),
    // Teaches this term, but Tuesday only — free on Friday
    section(
      "70002",
      "MATH1060",
      [{ name: "Yuyuan Ouyang", email: "yuyuano@clemson.edu", primary: true }],
      [{ days: "TR", beginTime: "1100", endTime: "1215" }],
    ),
    // Friday but ends exactly at 11:00 — boundary must NOT count as overlap
    section(
      "70003",
      "ECON2110",
      [{ name: "Scott Baier", email: "sbaier@clemson.edu", primary: true }],
      [{ days: "F", beginTime: "1000", endTime: "1100" }],
    ),
    // Two DIFFERENT people sharing a surname substring
    section(
      "70004",
      "STAT2300",
      [{ name: "A Smith", email: "asmith@clemson.edu", primary: true }],
      [{ days: "F", beginTime: "1100", endTime: "1150" }],
    ),
    section(
      "70005",
      "BIOL1030",
      [{ name: "B Smith", email: "bsmith@clemson.edu", primary: true }],
      [{ days: "F", beginTime: "0900", endTime: "0950" }],
    ),
  ],
} as never);

__setTermClockForTest(() => new Date("2026-09-15T12:00:00Z"));

async function check(args: Record<string, unknown>) {
  const res = await __schedTools.instructorClasses.handler({
    days: "F",
    window_start: "1100",
    window_end: "1200",
    ...args,
  });
  assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]));
  return JSON.parse((res.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;
}
type Row = {
  query: string;
  status: string;
  conflicts?: unknown[];
  note?: string;
  candidates?: unknown[];
};

test('the direct question: "Name <email>" entries sort into busy / free / not_teaching', async () => {
  const b = await check({
    instructors: [
      "Chip Tonkin III <tonkin@clemson.edu>", // busy (email matches case-insensitively)
      "Yuyuan Ouyang <yuyuano@clemson.edu>", // teaches, but not Friday — free
      "Mitch Shue <mshue@clemson.edu>", // not in the snapshot at all
    ],
  });
  const [tonkin, ouyang, shue] = b.instructors as Row[];
  assert.equal(tonkin.status, "busy");
  assert.equal((tonkin.conflicts as { crn: string }[])[0].crn, "70001");
  assert.equal(ouyang.status, "free");
  assert.equal(shue.status, "not_teaching");
  assert.match(String(shue.note), /NOT the same as free/);
  assert.deepEqual(
    b.busy,
    ["Chip Tonkin III"],
    "the summary answers the question directly",
  );
});

test("a meeting ending exactly at the window start is NOT a conflict", async () => {
  const b = await check({ instructors: ["sbaier@clemson.edu"] });
  assert.equal((b.instructors as Row[])[0].status, "free");
});

test("an ambiguous name returns candidates, never a silently chosen person", async () => {
  const b = await check({ instructors: ["Smith"] });
  const row = (b.instructors as Row[])[0];
  assert.equal(row.status, "ambiguous");
  assert.equal((row.candidates as unknown[]).length, 2);
});

test("a name substring that matches one person resolves and checks them", async () => {
  const b = await check({ instructors: ["Ouyang"] });
  assert.equal((b.instructors as Row[])[0].status, "free");
});

test("omitting the window checks the whole day", async () => {
  const b = await check({
    instructors: ["bsmith@clemson.edu"],
    window_start: undefined,
    window_end: undefined,
  });
  assert.equal(
    (b.instructors as Row[])[0].status,
    "busy",
    "9am Friday counts with no window",
  );
});

test("a term with no snapshot claims nothing about anyone", async () => {
  const b = await check({
    term: "Spring 2030",
    instructors: ["tonkin@clemson.edu"],
  });
  assert.equal(b.has_snapshot, false);
  assert.deepEqual(b.instructors, []);
});

test('the primitive: "what does this person teach?" — no filter, full list', async () => {
  const b = await check({
    instructors: ["Chip Tonkin III <tonkin@clemson.edu>"],
    days: undefined,
    window_start: undefined,
    window_end: undefined,
  });
  const row = (b.instructors as Row[])[0] as Row & {
    sections: { subject_course: string; crn: string; meetings: unknown[] }[];
  };
  assert.equal(row.status, "teaching");
  assert.equal(row.sections[0].subject_course, "GC1010");
  assert.equal(
    row.sections[0].meetings.length,
    3,
    "MWF grouped under one section",
  );
  assert.equal(b.busy, undefined, "no filter, no busy verdict");
});

test('"I want Tonkin\'s GC 4800" shape: the full list is searchable for a course', async () => {
  const b = await check({
    instructors: ["Ouyang"],
    days: undefined,
    window_start: undefined,
    window_end: undefined,
  });
  const row = (b.instructors as Row[])[0] as Row & {
    sections: { subject_course: string; crn: string }[];
  };
  const hit = row.sections.find((s) => s.subject_course === "MATH1060");
  assert.ok(hit, "the course is findable in the person's list");
  assert.equal(hit!.crn, "70002");
});

test("filtered calls also carry the full section list, not just conflicts", async () => {
  const b = await check({ instructors: ["tonkin@clemson.edu"] });
  const row = (b.instructors as Row[])[0] as Row & { sections: unknown[] };
  assert.equal(row.status, "busy");
  assert.ok(row.sections.length >= 1);
});

test("a window without days is an error", async () => {
  const res = await __schedTools.instructorClasses.handler({
    instructors: ["tonkin@clemson.edu"],
    window_start: "1100",
    window_end: "1200",
  });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /days/);
});

test("half a window is an error, not a guess", async () => {
  const res = await __schedTools.instructorClasses.handler({
    instructors: ["tonkin@clemson.edu"],
    days: "F",
    window_start: "1100",
  });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /together/);
});
