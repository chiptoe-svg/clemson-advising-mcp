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
