// Admin scheduling (2026-10-28): the pure logic behind the admin tools —
// base-term choice, placeholder locations, and stacked (cross-listed)
// sections. Honors sections (cap 2) and 4xxx/6xxx pairs meet together in one
// room with one instructor; they are one meeting, never a double booking.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sec, snapshot } from "./helpers/admin-fixture.ts";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "admin-schedule-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb, openScheduleDb } =
  await import("../src/clemson-schedule-db.ts");
const A = await import("../src/admin-schedule.ts");

const TR = { days: "TR", begin: "0930", end: "1045" };
writeScheduleDb(
  snapshot("202601", [
    sec("1001", "GC3400", "001", [TR], { cap: 40 }),
    sec("1002", "GC3400", "002", [TR], { cap: 2 }),
    sec("1003", "GC4400", "001", [{ ...TR, room: "205" }], { cap: 30 }),
    sec("1004", "GC6400", "001", [{ ...TR, room: "205" }], { cap: 5 }),
    sec("1005", "GC2070", "001", [{ ...TR, room: "202" }], {
      instructor: { name: "Lee One", email: "lone@clemson.edu" },
    }),
    sec("1006", "GC2400", "001", [{ ...TR, room: "202" }], {
      instructor: { name: "Kim Two", email: "ktwo@clemson.edu" },
    }),
    sec("1007", "PRTM4540", "001", [{ ...TR, room: "101" }], {
      instructor: { name: "Other Person", email: null },
    }),
  ]) as never,
);
const db = openScheduleDb("202601")!;
const base = A.loadBaseSections(db, "202601");

test("default base term: the target's own snapshot, else the same season a year earlier", () => {
  assert.equal(
    A.defaultBaseTerm("202701", ["202601", "202701"])?.term,
    "202701",
  );
  assert.equal(
    A.defaultBaseTerm("202708", ["202608", "202701"])?.term,
    "202608",
  );
  assert.match(A.defaultBaseTerm("202708", ["202608"])!.reason, /202608/);
  assert.equal(A.defaultBaseTerm("202708", ["202701"]), null);
});

test("placeholder locations are not rooms", () => {
  assert.equal(A.isPlaceholderRoom("No Building Assigned", "ROOM"), true);
  assert.equal(A.isPlaceholderRoom("Exam", "TBA"), true);
  assert.equal(A.isPlaceholderRoom("Online", "COURSE"), true);
  assert.equal(A.isPlaceholderRoom("Online", null), true);
  assert.equal(A.isPlaceholderRoom(null, null), true);
  assert.equal(A.isPlaceholderRoom("Godfrey Hall", "201"), false);
});

test("base sections carry course, HHMM meetings, room, capacity and instructors", () => {
  const s = base.find((b) => b.crns[0] === "1001")!;
  assert.equal(s.course, "GC 3400");
  assert.equal(s.subject, "GC");
  assert.deepEqual(
    s.meetings.map((m) => [m.days, m.start, m.end]),
    [["TR", "0930", "1045"]],
  );
  assert.equal(s.building, "Godfrey Hall");
  assert.equal(s.room, "201");
  assert.equal(s.cap, 40);
  assert.deepEqual(s.instructors, ["pexample@clemson.edu"]);
  assert.equal(
    base.find((b) => b.crns[0] === "1007")!.instructors[0],
    "Other Person",
  );
});

test("an honors section stacks with its lecture: one meeting, caps summed", () => {
  const st = A.stackSections(base);
  const gc3400 = st.filter((s) => s.course === "GC 3400");
  assert.equal(gc3400.length, 1);
  assert.deepEqual(gc3400[0]!.sections, ["001", "002"]);
  assert.equal(gc3400[0]!.cap, 42);
  assert.equal(gc3400[0]!.id, "1001+1002");
});

test("a 4xxx/6xxx pair stacks across course numbers", () => {
  const st = A.stackSections(base);
  const pair = st.find((s) => s.crns.includes("1003"))!;
  assert.deepEqual(pair.crns, ["1003", "1004"]);
  assert.equal(pair.cap, 35);
});

test("same room and time with different instructors does not stack", () => {
  const st = A.stackSections(base);
  assert.ok(st.find((s) => s.id === "1005"));
  assert.ok(st.find((s) => s.id === "1006"));
});

test("instructor identity: email or name, case-insensitive", () => {
  assert.equal(A.sameInstructor("LOne@clemson.edu", "lone@clemson.edu"), true);
  assert.equal(A.sameInstructor("Lee One", "lee one"), true);
  assert.equal(A.sameInstructor("Lee One", "Kim Two"), false);
});

test("a snapshot without part_of_term still loads", async () => {
  writeScheduleDb(
    snapshot("202501", [sec("2001", "GC1040", "001", [TR])]) as never,
  );
  const { default: Database } = await import("better-sqlite3");
  const w = new Database(path.join(STATE, "clemson", "202501.db"));
  w.exec("ALTER TABLE sections DROP COLUMN part_of_term");
  w.close();
  const d = openScheduleDb("202501")!;
  assert.equal(A.loadBaseSections(d, "202501").length, 1);
});

// --- checkDraft (Task 3) ------------------------------------------------------
// A second base term: other departments' bookings and teaching that a GC draft
// must not land on.
writeScheduleDb(
  snapshot("202608", [
    sec("3001", "GC2070", "001", [{ days: "MW", begin: "1115", end: "1400" }], {
      instructor: { name: "Lee One", email: "lone@clemson.edu" },
    }),
    sec("3002", "PRTM4540", "001", [{ ...TR, room: "101" }], {
      instructor: { name: "Other Person", email: null },
    }),
    sec(
      "3003",
      "MATH1010",
      "001",
      [
        {
          days: "F",
          begin: "0800",
          end: "0850",
          building: "Martin Hall",
          room: "M102",
        },
      ],
      { instructor: { name: "Lee One", email: null } },
    ),
  ]) as never,
);
const db8 = openScheduleDb("202608")!;
const base8 = A.loadBaseSections(db8, "202608");
const aliases8 = A.loadInstructorAliases(db8, "202608");

const d = (
  id: string,
  course: string,
  meetings: { days: string; start: string; end: string }[],
  room: string | null,
  instructors: string[] = [],
  cap: number | null = 20,
): import("../src/admin-schedule.ts").DraftSection => ({
  id,
  course,
  sections: ["001"],
  crns: [],
  meetings,
  building: room ? "Godfrey Hall" : null,
  room,
  instructors,
  cap,
});
const MW = { days: "MW", start: "1115", end: "1400" };
const TRm = { days: "TR", start: "0930", end: "1045" };
const kinds = (r: ReturnType<typeof A.checkDraft>, id: string) =>
  r.problems.filter((p) => p.id === id).map((p) => p.kind);

test("two draft sections in one room at one time: both flagged, each naming the other", () => {
  const r = A.checkDraft(
    [d("a", "GC 3400", [TRm], "201"), d("b", "GC 4060", [TRm], "201")],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r, "a"), ["room_double_booked"]);
  assert.deepEqual(r.problems.find((p) => p.id === "a")!.with, ["b"]);
  assert.deepEqual(kinds(r, "b"), ["room_double_booked"]);
});

test("a draft section on another department's booking is flagged", () => {
  const r = A.checkDraft(
    [d("a", "GC 3400", [TRm], "101")],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r, "a"), ["room_used_by_other_department"]);
  assert.match(r.problems[0]!.detail, /PRTM 4540/);
});

test("the base term's own GC sections are not 'others' — the draft replaces them", () => {
  const r = A.checkDraft(
    [d("a", "GC 3400", [MW], "201")],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(r.problems, []);
});

test("an instructor in two overlapping draft sections is flagged", () => {
  const r = A.checkDraft(
    [
      d("a", "GC 3400", [TRm], "201", ["Kim Two"]),
      d("b", "GC 4060", [TRm], "205", ["kim two"]),
    ],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r, "a"), ["instructor_double_booked"]);
});

test("an instructor's non-GC teaching counts, matched by email or name", () => {
  // Draft names the instructor by email; the MATH record has only the name.
  const r = A.checkDraft(
    [
      d("a", "GC 3400", [{ days: "MWF", start: "0800", end: "0850" }], "201", [
        "lone@clemson.edu",
      ]),
    ],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r, "a"), ["instructor_double_booked"]);
  assert.match(r.problems[0]!.detail, /MATH 1010/);
});

test("a room smaller than the seat cap is flagged; unknown capacity is not", () => {
  const cap = A.checkDraft(
    [d("a", "GC 3400", [TRm], "201", [], 500)],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(cap, "a"), ["room_too_small"]);
  const unknown = A.checkDraft(
    [{ ...d("a", "GC 3400", [TRm], "999", [], 500), building: "Nowhere Hall" }],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(unknown, "a"), []);
});

const group = (name: string, ...needs: string[][]) => ({
  name,
  needs,
  unresolved: [],
  source: "saved" as const,
});

test("a course group with no workable combination is a group clash", () => {
  const r = A.checkDraft(
    [d("x1", "GC 4061", [MW], "101C"), d("y1", "GC 4401", [MW], "100A")],
    base8,
    "GC",
    [group("labs", ["GC 4061"], ["GC 4401"])],
    aliases8,
  );
  assert.deepEqual(kinds(r, "x1"), ["group_clash"]);
  assert.deepEqual(kinds(r, "y1"), ["group_clash"]);
  assert.match(r.problems[0]!.detail, /labs/);
  assert.equal(r.groupsChecked[0]!.combinations, 0);
});

test("one workable combination clears the group", () => {
  const r = A.checkDraft(
    [
      d("x1", "GC 4061", [MW], "101C"),
      d("x2", "GC 4061", [TRm], "101C"),
      d("y1", "GC 4401", [MW], "100A"),
    ],
    base8,
    "GC",
    [group("labs", ["GC 4061"], ["GC 4401"])],
    aliases8,
  );
  assert.deepEqual(r.problems, []);
  assert.equal(r.groupsChecked[0]!.combinations, 1);
});

test("no meeting time and no room are reported, never dropped", () => {
  const r = A.checkDraft(
    [d("a", "GC 3400", [], "201"), d("b", "GC 4061", [MW], null)],
    base8,
    "GC",
    [group("g", ["GC 3400"], ["GC 4061"])],
    aliases8,
  );
  assert.deepEqual(kinds(r, "a"), ["no_meeting_time"]);
  assert.deepEqual(kinds(r, "b"), ["room_unknown"]);
});

test("group courses missing from the draft are listed; under two present, not checked", () => {
  const r = A.checkDraft(
    [d("a", "GC 4061", [MW], "101C")],
    base8,
    "GC",
    [group("g", ["GC 4061"], ["GC 4800"])],
    aliases8,
  );
  assert.deepEqual(r.groupsChecked[0]!.missing, ["GC 4800"]);
  assert.equal(r.groupsChecked[0]!.combinations, null);
  assert.deepEqual(r.problems, []);
});
