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
      crossList: "XL9",
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

// --- patterns, free rooms, slots (Task 4) -------------------------------------
writeScheduleDb(
  snapshot("202605", [
    sec("4001", "GC3400", "001", [TR], { cap: 40 }),
    sec("4002", "ENGL1030", "001", [
      { ...TR, building: "Daniel Hall", room: "100" },
    ]),
    sec("4003", "ENGL1030", "002", [
      { ...TR, building: "Daniel Hall", room: "101" },
    ]),
    sec(
      "4004",
      "GC4061",
      "001",
      [{ days: "MW", begin: "1115", end: "1400", room: "101C" }],
      {
        instructor: { name: "Lab Lead", email: "lab@clemson.edu" },
      },
    ),
    sec("4005", "GC2400", "001", [{ ...TR, room: "205" }], {
      instructor: { name: "Busy Person", email: "busy@clemson.edu" },
    }),
    sec("4006", "MATH1010", "001", [
      {
        days: "MW",
        begin: "1300",
        end: "1350",
        building: "Martin Hall",
        room: "M1",
      },
    ]),
  ]) as never,
);
const db5 = openScheduleDb("202605")!;
const base5 = A.loadBaseSections(db5, "202605");

test("standard patterns: most common first", () => {
  const p = A.standardPatterns(base5);
  assert.deepEqual(
    p[0]!.map((m) => [m.days, m.start, m.end]),
    [["TR", "0930", "1045"]],
  );
  assert.ok(p.some((x) => x[0]!.days === "MW" && x[0]!.start === "1115"));
});

test("free rooms: booked rooms are out, the preferred building comes first", () => {
  const rooms = A.freeRooms(
    base5,
    null,
    [{ days: "TR", start: "0930", end: "1045" }],
    {
      building: "Godfrey Hall",
    },
  );
  const names = rooms.map((r) => `${r.building} ${r.room}`);
  assert.ok(!names.includes("Godfrey Hall 201"));
  assert.ok(!names.includes("Daniel Hall 100"));
  assert.ok(names.includes("Godfrey Hall 101C"));
  assert.ok(names.includes("Martin Hall M1"));
  assert.equal(rooms[0]!.building, "Godfrey Hall");
});

test("with a draft, the subject's base sections give way to the draft", () => {
  // The draft moves GC 3400 out of Godfrey 201 on TR, so 201 is free then.
  const rooms = A.freeRooms(
    base5,
    [d("a", "GC 3400", [MW], "201")],
    [{ days: "TR", start: "0930", end: "1045" }],
    { subject: "GC" },
  );
  assert.ok(rooms.some((r) => r.room === "201"));
});

test("slots avoid the group's courses and report instructors", () => {
  const r = A.findSlots({
    base: base5,
    draft: null,
    subject: "GC",
    avoidCourses: ["GC 4061"],
    instructors: ["busy@clemson.edu"],
    preferredBuilding: "Godfrey Hall",
  });
  const keys = r.slots.map((s) =>
    s.meetings.map((m) => `${m.days} ${m.start}`).join(","),
  );
  assert.ok(!keys.includes("MW 1115"), "overlaps the only GC 4061 section");
  assert.ok(!keys.includes("MW 1300"), "overlaps GC 4061 at 1300 too");
  const tr = r.slots.find((s) => s.meetings[0]!.days === "TR")!;
  assert.deepEqual(tr.instructorsBusy, ["busy@clemson.edu"]);
  assert.ok(tr.rooms.length > 0);
});

test("a course with two sections only blocks a slot when both clash", () => {
  const draft = [
    d("x1", "GC 4061", [MW], "101C"),
    d("x2", "GC 4061", [TRm], "101C"),
  ];
  const r = A.findSlots({
    base: base5,
    draft,
    subject: "GC",
    avoidCourses: ["GC 4061"],
    instructors: [],
    preferredBuilding: "Godfrey Hall",
  });
  const keys = r.slots.map((s) =>
    s.meetings.map((m) => `${m.days} ${m.start}`).join(","),
  );
  assert.ok(keys.includes("MW 1115") && keys.includes("TR 0930"));
});

test("a group's other-department course comes from the base term, not 'missing'", () => {
  // MATH 1010 (base 202608: F 0800–0850, Martin Hall) is in the group but
  // not in the GC draft. A GC section on F 0800 now has no workable pairing.
  const r = A.checkDraft(
    [d("a", "GC 3400", [{ days: "MWF", start: "0800", end: "0850" }], "201")],
    base8,
    "GC",
    [group("fresh", ["GC 3400"], ["MATH 1010"])],
    aliases8,
  );
  assert.deepEqual(r.groupsChecked[0]!.missing, []);
  assert.equal(r.groupsChecked[0]!.combinations, 0);
  assert.deepEqual(kinds(r, "a"), ["group_clash"]);
});

// --- expected class size and room matching (Chip, 2026-10-28) -------------------
test("base sections carry an expected size: enrollment plus waitlist, summed when stacked", () => {
  writeScheduleDb(
    snapshot("202405", [
      {
        ...sec("5001", "GC3400", "001", [TR], { cap: 40, enrollment: 35 }),
        waitCount: 4,
      },
      sec("5002", "GC3400", "002", [TR], { cap: 2, enrollment: 2 }),
    ]) as never,
  );
  const b = A.loadBaseSections(openScheduleDb("202405")!, "202405");
  assert.equal(b.find((s) => s.crns[0] === "5001")!.expected, 39);
  assert.equal(A.stackSections(b)[0]!.expected, 41);
});

test("a room too small for the expected size is its own problem", () => {
  // Godfrey Hall 201 seats 60: cap 50 fits, expected 70 does not.
  const r = A.checkDraft(
    [{ ...d("a", "GC 3400", [TRm], "201", [], 50), expected: 70 }],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r, "a"), ["room_too_small_for_expected"]);
});

test("a larger room than the class needs is not a problem (Chip, 2026-10-28)", () => {
  const r = A.checkDraft(
    [{ ...d("a", "GC 3400", [TRm], "201", [], 30), expected: 12 }],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r, "a"), []);
});

// Cross-listed means Banner's label, or an unlabeled 4xxx/6xxx pair at the
// same times with the same instructor (Chip, 2026-10-30). Any other overlap
// is a double booking, even in one room with one instructor.
const seminar = (
  id: string,
  course: string,
  days: string,
  crossList?: string,
) => ({
  ...d(id, course, [{ days, start: "1115", end: "1250" }], "202", [
    "cn@clemson.edu",
  ]),
  ...(crossList ? { crossList } : {}),
});

test("same Banner label, different patterns: meets together, not a double booking", () => {
  const r = A.checkDraft(
    [
      seminar("s1", "GC 1990", "MF", "GC1"),
      seminar("s2", "GC 4990", "F", "GC1"),
    ],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r, "s1"), ["meets_together"]);
  assert.deepEqual(kinds(r, "s2"), ["meets_together"]);
  assert.match(r.problems[0]!.detail, /cross-listed.*GC1/);
});

test("same room and instructor but no label: a double booking, both kinds", () => {
  const r = A.checkDraft(
    [seminar("s1", "GC 1990", "MF"), seminar("s2", "GC 4990", "F")],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r, "s1").sort(), [
    "instructor_double_booked",
    "room_double_booked",
  ]);
});

test("the label comes from the base term by CRN when the draft doesn't carry it", () => {
  const labeled: import("../src/admin-schedule.ts").BaseSection[] = [
    ["c1", "GC 1990"],
    ["c2", "GC 4990"],
  ].map(([crn, course]) => ({
    ...seminar(crn!, course!, "F"),
    crns: [crn!],
    crossList: "GC1",
    expected: 3,
    subject: "GC",
    title: course!,
    enrollment: 3,
    waitCount: 0,
    roomCapacity: null,
  }));
  const r = A.checkDraft(
    [
      { ...seminar("s1", "GC 1990", "MF"), crns: ["c1"] },
      { ...seminar("s2", "GC 4990", "F"), crns: ["c2"] },
    ],
    [...base8, ...labeled],
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r, "s1"), ["meets_together"]);
});

test("an unlabeled 4xxx/6xxx pair at the same times: one class, flagged to label in Banner", () => {
  const F = [{ days: "F", start: "1010", end: "1310" }];
  const r = A.checkDraft(
    [
      d("g4", "GC 4900", F, null, ["Kim Two"]),
      d("g6", "GC 6900", F, null, ["Kim Two"]),
    ],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.ok(kinds(r, "g4").includes("meets_together"));
  assert.ok(!kinds(r, "g4").includes("instructor_double_booked"));
  assert.match(
    r.problems.find((p) => p.id === "g4" && p.kind === "meets_together")!
      .detail,
    /not labeled/,
  );
});

test("same instructor, same time, different rooms, no label: instructor double booked", () => {
  const T = [{ days: "MW", start: "1220", end: "1335" }];
  const r = A.checkDraft(
    [
      d("a", "GC 3780", T, "112", ["Kim Two"]),
      d("b", "GC 3790", T, "G017", ["Kim Two"]),
    ],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r, "a"), ["instructor_double_booked"]);
  assert.deepEqual(kinds(r, "b"), ["instructor_double_booked"]);
});

test("free rooms for an expected size: big enough, closest fit first", () => {
  const rooms = A.freeRooms(
    base5,
    null,
    [{ days: "MW", start: "0800", end: "0850" }],
    {
      building: "Godfrey Hall",
      minCapacity: 21,
    },
  );
  for (const r of rooms) assert.ok(r.capacity != null && r.capacity >= 21);
  const caps = rooms
    .filter((r) => r.building === "Godfrey Hall")
    .map((r) => r.capacity!);
  assert.deepEqual(
    caps,
    [...caps].sort((a, b) => a - b),
  );
});

test("the course being placed does not block its own current room", () => {
  // GC 3400 holds Godfrey 201 on TR in the base; placing GC 3400 itself,
  // TR 0930 in 201 is open to it.
  const r = A.findSlots({
    base: base5,
    draft: null,
    subject: "GC",
    course: "GC 3400",
    avoidCourses: [],
    instructors: [],
    preferredBuilding: "Godfrey Hall",
  });
  const tr = r.slots.find((s) => s.meetings[0]!.days === "TR")!;
  assert.ok(tr.rooms.some((x) => x.room === "201"));
});

// --- final-review fixes ----------------------------------------------------------
test("I-1: a draft id equal to another department's CRN does not borrow its times", () => {
  // MATH 1010 is CRN 3003 in base8 (F 0800). A draft section reusing id "3003"
  // (a CRN from another term) must not lend MATH its meetings.
  const r = A.checkDraft(
    [
      d(
        "3003",
        "GC 3400",
        [{ days: "MWF", start: "0800", end: "0850" }],
        "201",
      ),
    ],
    base8,
    "GC",
    [group("fresh", ["GC 3400"], ["MATH 1010"])],
    aliases8,
  );
  assert.equal(r.groupsChecked[0]!.combinations, 0);
  assert.deepEqual(kinds(r, "3003"), ["group_clash"]);
  const moved = A.checkDraft(
    [d("3003", "GC 3400", [{ days: "TR", start: "0800", end: "0850" }], "201")],
    base8,
    "GC",
    [group("fresh", ["GC 3400"], ["MATH 1010"])],
    aliases8,
  );
  assert.equal(moved.groupsChecked[0]!.combinations, 1);
});

test("I-3: with a draft, the placed course's other sections still hold their rooms", () => {
  const draft = [d("k1", "GC 3400", [TRm], "201")];
  const r = A.findSlots({
    base: base5,
    draft,
    subject: "GC",
    course: "GC 3400",
    avoidCourses: [],
    instructors: [],
    preferredBuilding: "Godfrey Hall",
  });
  const tr = r.slots.find(
    (s) => s.meetings[0]!.days === "TR" && s.meetings[0]!.start === "0930",
  );
  assert.ok(!tr || !tr.rooms.some((x) => x.room === "201"));
});

test("I-4: an avoid need with alternatives keeps all of them", () => {
  // Need {GC 4061 or MATH 1010}: GC 4061 is MW 1115–1400, MATH 1010 is
  // MW 1300–1350 (base5). A MW 1115 slot clashes with both → blocked; with
  // only the first alternative considered, the same holds — so use a slot
  // that clashes with GC 4061 only: MW 1115 overlaps MATH too. Instead check
  // that a pattern clashing with GC 4061 but not MATH survives.
  const r = A.findSlots({
    base: base5,
    draft: null,
    subject: "GC",
    avoidNeeds: [["GC 4061", "MATH 1010"]],
    instructors: [],
    preferredBuilding: "Godfrey Hall",
    patterns: [[{ days: "MW", start: "1115", end: "1225" }]],
  });
  assert.equal(r.slots.length, 1, "MATH 1010 at 1300 is still takeable");
});

test("I-5: a cross-listed partner in another subject is not 'another department'", () => {
  writeScheduleDb(
    snapshot("202305", [
      sec("6001", "GC4900", "001", [{ ...TR, room: "202" }], {
        instructor: { name: "Cross Lister", email: "cl@clemson.edu" },
      }),
      sec("6002", "PKSC4900", "001", [{ ...TR, room: "202" }], {
        instructor: { name: "Cross Lister", email: "cl@clemson.edu" },
      }),
    ]) as never,
  );
  const db3 = openScheduleDb("202305")!;
  const b3 = A.loadBaseSections(db3, "202305");
  const draft = A.stackSections(b3.filter((s) => s.subject === "GC"));
  const r = A.checkDraft(
    draft,
    b3,
    "GC",
    [],
    A.loadInstructorAliases(db3, "202305"),
  );
  assert.deepEqual(r.problems, []);
});

test("an other-department section with the same cross-list label meets together", () => {
  // PRTM 4540 (base8) is TR 0930–1045 in Godfrey 101, taught by Other Person,
  // cross-listed as XL9.
  const a = {
    ...d("a", "GC 4540", [{ days: "T", start: "0930", end: "1100" }], "101", [
      "Other Person",
    ]),
    crossList: "XL9",
  };
  const r = A.checkDraft([a], base8, "GC", [], aliases8);
  assert.deepEqual(kinds(r, "a"), ["meets_together"]);
  // Without the label it is someone else's room and teaching.
  const r2 = A.checkDraft(
    [{ ...a, crossList: null }],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r2, "a").sort(), [
    "instructor_double_booked",
    "room_used_by_other_department",
  ]);
});

// --- Instructor preferences and room needs (2026-10-29) -----------------------
// Cob_advisor's page computes no rules itself, so a hand move that breaks a
// preference or a room need gets a badge only if the checker reports it.

test("an instructor preference broken by a meeting is reported, matched by name or email", () => {
  const preferences = new Map([
    ["Lee One", { avoidDays: "F", notBefore: "0900", notAfter: "1700" }],
  ]);
  const r = A.checkDraft(
    [
      // Friday: breaks avoid_days. Draft names her by email, file by name.
      d(
        "fri",
        "GC 3400",
        [{ days: "MWF", start: "1010", end: "1100" }],
        "201",
        ["lone@clemson.edu"],
      ),
      d(
        "early",
        "GC 4060",
        [{ days: "TR", start: "0800", end: "0915" }],
        "202",
        ["Lee One"],
      ),
      d(
        "late",
        "GC 4070",
        [{ days: "TR", start: "1630", end: "1745" }],
        "202",
        ["Lee One"],
      ),
      d(
        "fine",
        "GC 4080",
        [{ days: "TR", start: "1100", end: "1215" }],
        "202",
        ["Lee One"],
      ),
    ],
    base8,
    "GC",
    [],
    aliases8,
    { preferences },
  );
  assert.deepEqual(kinds(r, "fri"), ["instructor_preference"]);
  assert.match(r.problems.find((p) => p.id === "fri")!.detail, /Lee One.*F/);
  assert.match(r.problems.find((p) => p.id === "early")!.detail, /before 0900/);
  assert.match(r.problems.find((p) => p.id === "late")!.detail, /after 1700/);
  assert.deepEqual(kinds(r, "fine"), []);
});

test("an instructor over max_sections: every one of their sections is flagged, naming the others", () => {
  const preferences = new Map([["Kim Two", { maxSections: 1 }]]);
  const r = A.checkDraft(
    [
      d("a", "GC 3400", [TRm], "201", ["Kim Two"]),
      d("b", "GC 4060", [MW], "205", ["kim two"]),
      d("c", "GC 4999", [], null, ["Kim Two"]), // untimed still counts
    ],
    base8,
    "GC",
    [],
    aliases8,
    { preferences },
  );
  const a = r.problems.find(
    (p) => p.id === "a" && p.kind === "instructor_preference",
  )!;
  assert.match(a.detail, /3 sections.*limit is 1/);
  assert.deepEqual(a.with.sort(), ["b", "c"]);
  assert.ok(kinds(r, "c").includes("instructor_preference"));
});

test("max_sections counts a cross-listed group once, labeled or an unlabeled 4xxx/6xxx pair", () => {
  const preferences = new Map([["Kim Two", { maxSections: 2 }]]);
  const F = [{ days: "F", start: "1010", end: "1310" }];
  const R = [{ days: "R", start: "1325", end: "1415" }];
  const r = A.checkDraft(
    [
      d("g4", "GC 4900", F, null, ["Kim Two"]),
      d("g6", "GC 6900", F, null, ["Kim Two"]),
      { ...d("s1", "GC 1990", R, "205", ["Kim Two"]), crossList: "GC1" },
      { ...d("s2", "GC 2990", R, "205", ["Kim Two"]), crossList: "GC1" },
    ],
    base8,
    "GC",
    [],
    aliases8,
    { preferences },
  );
  for (const id of ["g4", "g6", "s1", "s2"])
    assert.ok(!kinds(r, id).includes("instructor_preference"), id);
});

test("no preferences given: no preference problems", () => {
  const r = A.checkDraft(
    [
      d("a", "GC 3400", [{ days: "F", start: "0700", end: "0750" }], "201", [
        "Kim Two",
      ]),
    ],
    base8,
    "GC",
    [],
    aliases8,
  );
  assert.deepEqual(kinds(r, "a"), []);
});

test("a room need: a section outside its allowed rooms or below min size is reported", () => {
  const roomNeeds = new Map([
    ["GC 4061", { rooms: ["Godfrey Hall 101C"] }],
    ["GC 6400", { minSize: 70 }], // applies to a stacked GC 4400 / GC 6400 block
  ]);
  const r = A.checkDraft(
    [
      d("lab-wrong", "GC 4061", [MW], "201"),
      d("lab-right", "GC 4061", [TRm], "101C"),
      d(
        "small",
        "GC 4400 / GC 6400",
        [{ days: "F", start: "1300", end: "1350" }],
        "201",
      ),
      d(
        "no-need",
        "GC 3400",
        [{ days: "F", start: "1400", end: "1450" }],
        "201",
      ),
    ],
    base8,
    "GC",
    [],
    aliases8,
    { roomNeeds },
  );
  assert.deepEqual(kinds(r, "lab-wrong"), ["room_need"]);
  assert.match(
    r.problems.find((p) => p.id === "lab-wrong")!.detail,
    /Godfrey Hall 101C/,
  );
  assert.deepEqual(kinds(r, "lab-right"), []);
  assert.deepEqual(kinds(r, "small"), ["room_need"]);
  assert.match(
    r.problems.find((p) => p.id === "small")!.detail,
    /seats 60.*70/,
  );
  assert.deepEqual(kinds(r, "no-need"), []);
});

test("a per-meeting room counts for room needs", () => {
  const roomNeeds = new Map([["GC 4061", { rooms: ["Godfrey Hall 101C"] }]]);
  const r = A.checkDraft(
    [
      {
        ...d("lab", "GC 4061", [], "101C"),
        meetings: [
          { days: "M", start: "1115", end: "1400" },
          {
            days: "W",
            start: "1115",
            end: "1400",
            building: "Godfrey Hall",
            room: "201",
          },
        ],
      },
    ],
    base8,
    "GC",
    [],
    aliases8,
    { roomNeeds },
  );
  assert.deepEqual(kinds(r, "lab"), ["room_need"]);
});

// --- Stacking with Banner labels (review, 2026-10-30) --------------------------
// With labels known, identical-looking sections stack only when they are one
// class (same label, or an unlabeled 4xxx/6xxx pair); otherwise the checker
// would never see an unlabeled clash. Without labels (older snapshots) the
// identical-section rule stays, or every honors pair would read as a clash.
const twin = (
  crn: string,
  course: string,
  crossList: string | null,
  subject = "GC",
): import("../src/admin-schedule.ts").BaseSection => ({
  ...d(crn, course, [{ days: "MW", start: "1000", end: "1115" }], "112", [
    "ktwo@clemson.edu",
  ]),
  crns: [crn],
  crossList,
  expected: 10,
  subject,
  title: course,
  enrollment: 10,
  waitCount: 0,
  roomCapacity: null,
});

test("labels known: an unlabeled identical pair stays apart; labeled and 4xxx/6xxx pairs stack", () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();
  assert.deepEqual(
    ids(
      A.stackSections(
        [twin("1", "GC 3780", null), twin("2", "GC 3790", null)],
        true,
      ),
    ),
    ["1", "2"],
  );
  assert.deepEqual(
    ids(
      A.stackSections(
        [twin("1", "GC 4400", "GC8"), twin("2", "GC 4400", "GC8")],
        true,
      ),
    ),
    ["1+2"],
  );
  assert.deepEqual(
    ids(
      A.stackSections(
        [twin("1", "GC 4400", null), twin("2", "GC 6400", null)],
        true,
      ),
    ),
    ["1+2"],
  );
  // Labels unknown: the old identical-section rule.
  assert.deepEqual(
    ids(
      A.stackSections([twin("1", "GC 3780", null), twin("2", "GC 3790", null)]),
    ),
    ["1+2"],
  );
});

test("labels known: another department's identical unlabeled section is still someone else's", () => {
  const base = [
    twin("1", "GC 2010", null),
    twin("2", "PKSC 2010", null, "PKSC"),
    twin("3", "GC 2020", "XL1"),
  ];
  assert.deepEqual(
    A.othersOf(base, "GC").map((o) => o.id),
    ["2"],
  );
  const r = A.findConflicts(base, "GC");
  assert.ok(
    r.doubleBookings.some(
      (b) =>
        b.kind === "room_used_by_other_department" && b.likely_missing_label,
    ),
  );
});
