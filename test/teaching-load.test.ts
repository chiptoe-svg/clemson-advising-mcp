// get-teaching-load: "how many contact hours do GC faculty have?" as one
// deterministic server-side computation. Properties under test: credit hours
// count once per SECTION however many meetings it has; untimed sections are
// reported separately and never folded into a contact total; co-taught
// sections attribute fully to each listed instructor; a subject filter is a
// stated scope, not a silent narrowing; and no snapshot means nothing was
// computed — never a zero.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "teaching-load-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { __schedTools } = await import("../src/mcp-tools/clemson-schedule.ts");

function section(
  crn: string,
  course: string,
  credit: number,
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
    creditHours: credit,
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

const chip = { name: "Chip Tonkin", email: "tonkin@clemson.edu", primary: true };
const bobby = {
  name: "Bobby Congdon",
  email: "congdon@clemson.edu",
  primary: false,
};

writeScheduleDb({
  term: "202608",
  termDescription: "Fall 2026",
  fetchedAt: new Date().toISOString(),
  sectionCount: 7,
  sections: [
    // Three meeting rows, ONE section: credit must count once (3, not 9).
    section("70001", "GC1010", 3, [chip], [
      { days: "MWF", beginTime: "1130", endTime: "1220" },
    ]),
    section("70002", "GC3500", 3, [bobby], [
      { days: "MW", beginTime: "0800", endTime: "0915" },
    ]),
    // No timed meetings at all — must land in untimed_sections, not a total.
    section("70003", "GC3501", 2, [bobby], []),
    // Co-taught: attributes FULLY to both Chip and Bobby.
    section("70004", "GC4000", 1, [chip, bobby], [
      { days: "T", beginTime: "0900", endTime: "1000" },
    ]),
    // Outside the GC subject — visible without a subject filter only.
    section("70005", "MATH1060", 3, [bobby], [
      { days: "F", beginTime: "1000", endTime: "1100" },
    ]),
    // Two people sharing the "Smith" substring, for ambiguity.
    section("70006", "STAT2300", 3, [
      { name: "Ann Smithers", email: "asmithe@clemson.edu", primary: true },
    ], [{ days: "M", beginTime: "0900", endTime: "1000" }]),
    section("70007", "STAT2310", 3, [
      { name: "Bo Smith", email: "bsmith@clemson.edu", primary: true },
    ], [{ days: "T", beginTime: "0900", endTime: "1000" }]),
  ],
});

async function load(args: Record<string, unknown>) {
  const res = await __schedTools.teachingLoad.handler({
    term: "202608",
    ...args,
  });
  assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]));
  return JSON.parse((res.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;
}

type Person = {
  name?: string;
  query?: string;
  status?: string;
  note?: string;
  candidates?: unknown[];
  sections_count: number;
  contact_hours_weekly: number;
  credit_hours: number;
  untimed_sections: { count: number; crns: string[] };
  sections: { crn: string; weekly_contact_hours: number; timed: boolean }[];
};

test("subject mode: everyone on the subject's sections, both measures, untimed separate", async () => {
  const b = await load({ subject: "GC" });
  assert.equal(b.has_snapshot, true);
  assert.match(String(b.scope), /GC sections only/);
  const [bobbyRow, chipRow] = b.instructors as Person[];
  // Both total 3.5 contact hours; the tie breaks alphabetically.
  assert.equal(bobbyRow.name, "Bobby Congdon");
  assert.equal(bobbyRow.sections_count, 3);
  assert.equal(bobbyRow.contact_hours_weekly, 3.5); // 150 + 60 timed minutes
  assert.equal(bobbyRow.credit_hours, 6); // 3 + 2 + 1 — untimed COUNTS for credit
  assert.deepEqual(bobbyRow.untimed_sections, { count: 1, crns: ["70003"] });
  assert.equal(chipRow.name, "Chip Tonkin");
  assert.equal(chipRow.sections_count, 2);
  assert.equal(chipRow.contact_hours_weekly, 3.5); // 150 + 60
  // The dedupe property: GC1010 meets MWF (three rows) but is 3 credits ONCE.
  assert.equal(chipRow.credit_hours, 4);
  assert.equal((b.instructors as Person[]).length, 2);
});

test("instructor mode without subject counts everything they teach", async () => {
  const b = await load({ instructors: ["congdon@clemson.edu"] });
  const [row] = b.instructors as Person[];
  assert.equal(row.status, "teaching");
  assert.equal(row.sections_count, 4); // + MATH1060
  assert.equal(row.contact_hours_weekly, 4.5); // 3.5 + 1.0
  assert.equal(row.credit_hours, 9);
  assert.equal(row.untimed_sections.count, 1);
  assert.match(String(b.scope), /every section/);
});

test("subject + instructors scopes the person's load to that subject", async () => {
  const b = await load({ subject: "GC", instructors: ["Bobby Congdon"] });
  const [row] = b.instructors as Person[];
  assert.equal(row.sections_count, 3);
  assert.equal(row.contact_hours_weekly, 3.5);
  assert.equal(row.credit_hours, 6);
});

test("teaches this term but nothing in the subject: explicit zeros with a note, not absence", async () => {
  const b = await load({ subject: "MATH", instructors: ["Chip Tonkin"] });
  const [row] = b.instructors as Person[];
  assert.equal(row.status, "teaching");
  assert.equal(row.sections_count, 0);
  assert.match(String(row.note), /no MATH sections/);
});

test("co-taught sections attribute fully to each instructor, and the response says so", async () => {
  const b = await load({
    instructors: ["tonkin@clemson.edu", "congdon@clemson.edu"],
  });
  const [chipRow, bobbyRow] = b.instructors as Person[];
  const chipGc4000 = chipRow.sections.find((s) => s.crn === "70004");
  const bobbyGc4000 = bobbyRow.sections.find((s) => s.crn === "70004");
  assert.equal(chipGc4000?.weekly_contact_hours, 1);
  assert.equal(bobbyGc4000?.weekly_contact_hours, 1);
  assert.match(String(b.attribution), /fully to EACH/);
});

test("an unknown instructor is not_teaching — never a zero-hours row", async () => {
  const b = await load({ instructors: ["nobody@clemson.edu"] });
  const [row] = b.instructors as Person[];
  assert.equal(row.status, "not_teaching");
  assert.match(String(row.note), /not a statement about their workload/);
});

test("an ambiguous name returns candidates, never a merged or guessed load", async () => {
  const b = await load({ instructors: ["Smith"] });
  const [row] = b.instructors as Person[];
  assert.equal(row.status, "ambiguous");
  assert.equal((row.candidates as unknown[]).length, 2);
});

test("no snapshot: nothing was computed, so nothing is claimed", async () => {
  const res = await __schedTools.teachingLoad.handler({
    term: "203008",
    subject: "GC",
  });
  const b = JSON.parse((res.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;
  assert.equal(b.has_snapshot, false);
  assert.deepEqual(b.instructors, []);
  assert.match(String(b._note), /no load could be computed/);
});

test("neither subject nor instructors is an error, not an empty answer", async () => {
  const res = await __schedTools.teachingLoad.handler({ term: "202608" });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /subject/);
});
