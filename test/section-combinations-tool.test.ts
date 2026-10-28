// find-section-combinations against a snapshot: the Spring 2027 GC 4061 /
// GC 4401 case that find-conflict-free-schedule answered "none" for
// (2026-10-28), plus the what-if busy block Chip actually asked about.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "section-combos-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { __schedTools } = await import("../src/mcp-tools/clemson-schedule.ts");

const section = (
  crn: string,
  subjectCourse: string,
  sec: string,
  days: string,
  beginTime: string,
  endTime: string,
) => ({
  crn,
  subjectCourse,
  section: sec,
  title: subjectCourse,
  campus: "C",
  scheduleType: "Laboratory",
  instructionalMethod: "F",
  creditHours: 1,
  enrollment: 0,
  maxEnrollment: 16,
  seatsAvailable: 16,
  waitCount: 0,
  waitCapacity: 0,
  open: true,
  meetings: [
    {
      days,
      beginTime,
      endTime,
      building: "Godfrey",
      room: "205",
      type: "Class",
    },
  ],
  instructors: [],
});

writeScheduleDb({
  term: "202701",
  termDescription: "Spring 2027",
  fetchedAt: new Date().toISOString(),
  sectionCount: 5,
  sections: [
    section("12332", "GC4061", "001", "MW", "1115", "1400"),
    section("12333", "GC4061", "002", "TR", "0800", "1045"),
    section("17915", "GC4401", "001", "MW", "1115", "1400"),
    section("12336", "GC4401", "004", "TR", "0800", "1045"),
    {
      ...section("19000", "GC4990", "001", "MW", "0800", "0850"),
      meetings: [],
    },
  ],
} as never);

type Body = Record<string, unknown> & {
  combination_count: number;
  combinations: string[][];
  blocking: { kind: string; groups: string[]; reason: string }[];
  groups: { label: string; excluded: { crn: string; reason: string }[] }[];
  notes: string[];
};
const call = async (args: Record<string, unknown>) => {
  const res = await __schedTools.findSectionCombinations.handler(args);
  assert.equal(res.isError, undefined, JSON.stringify(res));
  return JSON.parse(
    (res as { content: { text: string }[] }).content[0]!.text,
  ) as Body;
};

test("courses expand to their sections and pair across groups", async () => {
  const b = await call({
    term: "Spring 2027",
    groups: [{ course: "GC 4061" }, { course: "gc4401" }],
  });
  assert.equal(b.combination_count, 2);
  assert.deepEqual(b.combinations, [
    ["12332", "12336"],
    ["12333", "17915"],
  ]);
  assert.match(JSON.stringify(b.sections), /MW 1115–1400/);
});

test("explicit CRN groups work the same as course groups", async () => {
  const b = await call({
    term: "202701",
    groups: [{ crns: ["12332", "12333"] }, { crns: ["17915", "12336"] }],
  });
  assert.equal(b.combination_count, 2);
});

test("a hypothetical meeting as a busy block answers the what-if", async () => {
  const b = await call({
    term: "Spring 2027",
    groups: [{ course: "GC 4061" }, { course: "GC 4401" }],
    busy: [
      { days: "TR", start: "1000", end: "1130", label: "GC 3401 (proposed)" },
    ],
  });
  assert.equal(b.combination_count, 0);
  assert.equal(b.blocking[0]!.kind, "pair");
  assert.match(b.groups[0]!.excluded[0]!.reason, /GC 3401 \(proposed\)/);
});

test("fixed CRNs remove sections they overlap", async () => {
  const b = await call({
    term: "Spring 2027",
    fixed_crns: ["12333"],
    groups: [{ course: "GC 4401" }],
  });
  assert.deepEqual(b.combinations, [["17915"]]);
});

test("a course with no sections is the blocker, said plainly", async () => {
  const b = await call({
    term: "Spring 2027",
    groups: [{ course: "GC 4061" }, { course: "GC 9999" }],
  });
  assert.equal(b.combination_count, 0);
  assert.equal(b.blocking[0]!.kind, "group");
  assert.match(b.blocking[0]!.reason, /no sections/);
});

test("unknown CRNs and sections with no meeting time are noted", async () => {
  const b = await call({
    term: "Spring 2027",
    groups: [{ crns: ["19000", "55555"] }],
  });
  assert.equal(b.combination_count, 1);
  const notes = b.notes.join(" ");
  assert.match(notes, /55555/);
  assert.match(notes, /19000/);
});

test("bad input is an error", async () => {
  for (const args of [
    { term: "Spring 2027", groups: [] },
    { term: "Spring 2027", groups: [{ course: "GC 4061", crns: ["1"] }] },
    {
      term: "Spring 2027",
      groups: [{ course: "GC 4061" }],
      busy: [{ days: "MX", start: "1000", end: "1100" }],
    },
    {
      term: "Spring 2027",
      groups: [{ course: "GC 4061" }],
      busy: [{ days: "M", start: "1100", end: "1000" }],
    },
  ]) {
    const res = await __schedTools.findSectionCombinations.handler(args);
    assert.equal(res.isError, true, JSON.stringify(args));
  }
});
