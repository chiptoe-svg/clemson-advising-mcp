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
    // Banner lists a middle initial; people ask for "First Last" (2026-09-29).
    section(
      "70006",
      "ACCT2010",
      [
        {
          name: "Carl W Hollingsworth",
          email: "chollin@clemson.edu",
          primary: true,
        },
      ],
      [{ days: "TR", beginTime: "0930", endTime: "1045" }],
    ),
    // Untimed sections (internships): Banner gives them NO meeting rows.
    // Spring 2026: three of Bobby Congdon's sections vanished from this tool
    // while get-teaching-load listed them (Cob_advisor, 2026-10-07).
    section(
      "70007",
      "GC3500",
      [{ name: "Chip Tonkin III", email: "TONKIN@CLEMSON.EDU", primary: true }],
      [],
    ),
    section(
      "70008",
      "GC4510",
      [{ name: "Pat Internova", email: "pinter@clemson.edu", primary: true }],
      [],
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

// Names match by WORDS, in any order: every word of the query must appear in
// the instructor's name. Banner lists middle initials ("Carl W Hollingsworth"),
// so a plain substring made "Carl Hollingsworth" a confident not_teaching for
// 359 Fall 2026 instructors (observed 2026-09-29 by GC_Agent).
test("a full name finds an instructor listed with a middle initial", async () => {
  const b = await check({ instructors: ["Carl Hollingsworth"] });
  const row = (b.instructors as Row[])[0] as Row & { name?: string };
  assert.notEqual(row.status, "not_teaching");
  assert.equal(row.status, "free");
});

test('"Last, First" and any word order resolve the same person', async () => {
  for (const q of ["Hollingsworth, Carl", "hollingsworth carl"]) {
    const b = await check({ instructors: [q] });
    assert.equal((b.instructors as Row[])[0].status, "free", q);
  }
});

test("a word that matches nobody still means not_teaching, with a hint", async () => {
  const b = await check({ instructors: ["Carl Zzyzx"] });
  const row = (b.instructors as Row[])[0];
  assert.equal(row.status, "not_teaching");
  assert.match(String(row.note), /surname|email/i);
});

test("a query with no words matches nobody, never everyone", async () => {
  const b = await check({ instructors: [" , "] });
  assert.equal((b.instructors as Row[])[0].status, "not_teaching");
});

// --- Untimed sections (2026-10-07) ------------------------------------------
// A section with no meeting rows is still taught. Dropping it made the advisor
// tell Chip "he did NOT teach GC 3500" — silence read as absence.

const LIST = { days: undefined, window_start: undefined, window_end: undefined };
type Sec = { crn: string; meetings: unknown[]; timed: boolean };

test("an untimed section is listed with meetings [] and timed: false", async () => {
  const b = await check({ instructors: ["tonkin@clemson.edu"], ...LIST });
  const row = (b.instructors as Row[])[0] as Row & { sections: Sec[] };
  const internship = row.sections.find((s) => s.crn === "70007");
  assert.ok(internship, "the untimed section is in the list");
  assert.deepEqual(internship!.meetings, []);
  assert.equal(internship!.timed, false);
  assert.equal(row.sections.find((s) => s.crn === "70001")!.timed, true);
});

test("someone teaching only untimed sections is teaching, with the sections", async () => {
  const b = await check({ instructors: ["Pat Internova"], ...LIST });
  const row = (b.instructors as Row[])[0] as Row & { sections: Sec[] };
  assert.equal(row.status, "teaching");
  assert.deepEqual(
    row.sections.map((s) => s.crn),
    ["70008"],
  );
});

test("with a day filter, an untimed section is listed but cannot make anyone busy", async () => {
  const b = await check({ instructors: ["pinter@clemson.edu"] });
  const row = (b.instructors as Row[])[0] as Row & { sections: Sec[] };
  assert.equal(row.status, "free");
  assert.equal(row.sections.length, 1);
});
