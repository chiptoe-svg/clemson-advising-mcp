// The admin scheduling tools end to end against a fixture snapshot: roll a
// term over, move a section onto another, check it; fall back to last year's
// term when the target has no snapshot; free rooms and slots; course groups.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sec, snapshot } from "./helpers/admin-fixture.ts";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "admin-tools-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { __adminTools } = await import("../src/mcp-tools/admin-schedule.ts");
const { expandScopes } = await import("../src/mcp-tools/permissions.ts");

const TR = { days: "TR", begin: "0930", end: "1045" };
const MW = { days: "MW", begin: "1115", end: "1400" };
writeScheduleDb(
  snapshot("202608", [
    sec("1001", "GC3400", "001", [TR], { cap: 40, enrollment: 30 }),
    sec("1002", "GC3400", "002", [TR], { cap: 2, enrollment: 2 }),
    sec("1003", "GC4061", "001", [{ ...MW, room: "101C" }], {
      instructor: { name: "Lab Lead", email: "lab@clemson.edu" },
    }),
    sec("1004", "PRTM4540", "001", [{ ...TR, room: "205" }], {
      instructor: { name: "Other Person", email: null },
    }),
  ]) as never,
);

type Res = { isError?: boolean; content: { text: string }[] };
const call = async (
  tool: keyof typeof __adminTools,
  args: Record<string, unknown>,
) => {
  const res = (await __adminTools[tool].handler(args)) as Res;
  return { res, body: res.isError ? null : JSON.parse(res.content[0]!.text) };
};

test("rollover returns the term's GC sections, honors pair stacked", async () => {
  const { res, body } = await call("rollover", { term: "Fall 2026" });
  assert.equal(res.isError, undefined, res.content[0]!.text);
  assert.equal(body.base_term, "202608");
  assert.equal(body.count, 2);
  const gc3400 = body.sections.find(
    (s: { course: string }) => s.course === "GC 3400",
  );
  assert.equal(gc3400.id, "1001+1002");
  assert.equal(gc3400.cap, 42);
  assert.ok(
    !body.sections.some((s: { course: string }) => s.course.startsWith("PRTM")),
  );
});

test("a moved section that lands on another department's room is flagged; last year's term stands in", async () => {
  const roll = (await call("rollover", { term: "202608" })).body;
  const draft = roll.sections.map((s: Record<string, unknown>) =>
    s.course === "GC 3400" ? { ...s, room: "205" } : s,
  );
  const { res, body } = await call("checkDraft", {
    target_term: "Fall 2027",
    draft,
  });
  assert.equal(res.isError, undefined, res.content[0]!.text);
  assert.equal(body.base_term, "202608");
  assert.match(body.base_reason, /a year earlier/);
  const kinds = body.problems.map((p: { kind: string }) => p.kind);
  assert.ok(kinds.includes("room_used_by_other_department"), kinds.join());
  // Godfrey Hall 205 seats fewer than the stacked pair's 42 — also reported.
  assert.ok(kinds.includes("room_too_small"), kinds.join());
  assert.match(body.note, /no class is booked/i);
});

test("free rooms excludes a room another department uses", async () => {
  const { body } = await call("freeRooms", {
    target_term: "Fall 2026",
    days: "TR",
    start: "0930",
    end: "1045",
  });
  const names = body.rooms.map(
    (r: { building: string; room: string }) => `${r.building} ${r.room}`,
  );
  assert.ok(!names.includes("Godfrey Hall 205"));
  assert.ok(!names.includes("Godfrey Hall 201"));
  assert.ok(names.includes("Godfrey Hall 101C"));
});

test("find slots: an unknown course is an error; a known one gets slots", async () => {
  assert.equal(
    (await call("findSlots", { target_term: "Fall 2026", course: "GC 9999" }))
      .res.isError,
    true,
  );
  const { body } = await call("findSlots", {
    target_term: "Fall 2026",
    course: "GC 3400",
    avoid_courses: ["GC 4061"],
    instructors: ["lab@clemson.edu"],
  });
  assert.ok(body.slots.length > 0);
  for (const s of body.slots)
    assert.notEqual(s.meetings[0].days + s.meetings[0].start, "MW1115");
});

test("bad times and an unknown group name are errors", async () => {
  assert.equal(
    (
      await call("freeRooms", {
        target_term: "Fall 2026",
        days: "MX",
        start: "0930",
        end: "1045",
      })
    ).res.isError,
    true,
  );
  assert.equal(
    (
      await call("freeRooms", {
        target_term: "Fall 2026",
        days: "M",
        start: "1100",
        end: "1000",
      })
    ).res.isError,
    true,
  );
  const r = await call("checkDraft", {
    target_term: "Fall 2026",
    draft: [],
    groups: [
      { name: "inline", courses: ["GC 3400", "GC 4061"] },
      "No Such Group",
    ],
  });
  assert.equal(r.res.isError, true);
  assert.match(r.res.content[0]!.text, /No Such Group/);
});

test("the admin tools are admin-category and outside the schedule scope", () => {
  const ops = Object.values(__adminTools).map((t) => t.operation);
  assert.equal(ops.length, 6);
  for (const t of Object.values(__adminTools))
    assert.equal(t.category, "admin");
  const schedule = expandScopes(["clemson.schedule"]);
  const admin = expandScopes(["clemson.admin"]);
  for (const op of ops) {
    assert.equal(schedule.has(op), false, op);
    assert.equal(admin.has(op), true, op);
  }
});

test("expected size: rollover carries it, the check reads it, slots default to it", async () => {
  const roll = (await call("rollover", { term: "202608" })).body;
  const gc3400 = roll.sections.find(
    (s: { course: string }) => s.course === "GC 3400",
  );
  assert.equal(gc3400.expected, 32);
  const draft = roll.sections.map((s: Record<string, unknown>) =>
    s.course === "GC 3400" ? { ...s, cap: 40, expected: 70 } : s,
  );
  const chk = (await call("checkDraft", { target_term: "Fall 2026", draft }))
    .body;
  assert.ok(
    chk.problems.some(
      (p: { kind: string }) => p.kind === "room_too_small_for_expected",
    ),
    JSON.stringify(chk.problems),
  );
  const slots = (
    await call("findSlots", {
      target_term: "Fall 2026",
      course: "GC 3400",
      expected_size: 50,
    })
  ).body;
  assert.equal(slots.expected_size, 50);
  for (const s of slots.slots)
    for (const r of s.rooms)
      assert.ok(r.capacity >= 50, `${r.building} ${r.room}`);
  const dflt = (
    await call("findSlots", { target_term: "Fall 2026", course: "GC 3400" })
  ).body;
  assert.equal(dflt.expected_size, gc3400.expected);
});

test("I-2: duplicate draft ids are rejected, not silently merged", async () => {
  const sec1 = {
    id: "a",
    course: "GC 3400",
    meetings: [{ days: "MW", start: "0900", end: "0950" }],
    building: "Godfrey Hall",
    room: "202",
    instructors: [],
    cap: 20,
  };
  const r = await call("checkDraft", {
    target_term: "Fall 2026",
    draft: [sec1, { ...sec1, course: "GC 4060" }],
  });
  assert.equal(r.res.isError, true);
  assert.match(r.res.content[0]!.text, /duplicate id "a"/);
});

// --- Preferences, room needs, exclude_ids (2026-10-29) -------------------------

test("check: course room needs and the preferences file are reported", async () => {
  const roll = (await call("rollover", { term: "202608" })).body;
  const prefs = path.join(STATE, "instructor-preferences.yaml");
  fs.writeFileSync(
    prefs,
    'instructors:\n  "Lab Lead":\n    not_before: "1200"\n',
  );
  try {
    const { res, body } = await call("checkDraft", {
      target_term: "Fall 2027",
      draft: roll.sections,
      courses: [{ course: "GC 3400", rooms: ["Godfrey Hall 101C"] }],
    });
    assert.equal(res.isError, undefined, res.content[0]!.text);
    const byKind = (k: string) =>
      body.problems.filter((p: { kind: string }) => p.kind === k);
    assert.equal(byKind("room_need").length, 1);
    // GC 4061 meets MW 1115: before Lab Lead's 1200.
    assert.match(byKind("instructor_preference")[0].detail, /before 1200/);
    assert.match(body.note, /preferences for 1 instructor/);
  } finally {
    fs.rmSync(prefs);
  }
});

test("check: a malformed preferences file or courses entry is an error, not ignored", async () => {
  const roll = (await call("rollover", { term: "202608" })).body;
  const prefs = path.join(STATE, "instructor-preferences.yaml");
  fs.writeFileSync(
    prefs,
    'instructors:\n  "Lab Lead":\n    avoid_days: "Fridays"\n',
  );
  try {
    const { res } = await call("checkDraft", {
      target_term: "Fall 2027",
      draft: roll.sections,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /instructor preferences unreadable/);
  } finally {
    fs.rmSync(prefs);
  }
  for (const courses of [
    "GC 3400",
    [{ rooms: ["Godfrey Hall 201"] }],
    [{ course: "GC 3400", rooms: "Godfrey Hall 201" }],
    [{ course: "GC 3400", rooms: ["Godfrey"] }],
    [{ course: "GC 3400", min_size: -3 }],
  ]) {
    const { res } = await call("checkDraft", {
      target_term: "Fall 2027",
      draft: roll.sections,
      courses,
    });
    assert.equal(res.isError, true, JSON.stringify(courses));
  }
});

test("find slots: exclude_ids lets a section's own room and instructor count as free", async () => {
  const roll = (await call("rollover", { term: "202608" })).body;
  const block = roll.sections.find(
    (s: { course: string }) => s.course === "GC 3400",
  );
  const args = {
    target_term: "Fall 2027",
    course: "GC 3400",
    draft: roll.sections,
    instructors: ["pexample@clemson.edu"],
  };
  const atTR = (b: {
    slots: {
      meetings: { days: string; start: string }[];
      rooms: { room: string }[];
      instructorsFree: string[];
    }[];
  }) =>
    b.slots.find(
      (s) => s.meetings[0]!.days === "TR" && s.meetings[0]!.start === "0930",
    );
  const kept = atTR((await call("findSlots", args)).body);
  assert.ok(!kept || !kept.rooms.some((r) => r.room === "201"));
  const moved = (await call("findSlots", { ...args, exclude_ids: [block.id] }))
    .body;
  const slot = atTR(moved)!;
  assert.ok(
    slot,
    JSON.stringify(moved.slots.map((s: { meetings: unknown }) => s.meetings)),
  );
  assert.ok(slot.rooms.some((r) => r.room === "201"));
  assert.deepEqual(slot.instructorsFree, ["pexample@clemson.edu"]);
  assert.deepEqual(moved.excluded, [block.id]);

  for (const bad of [
    { ...args, exclude_ids: ["nope"] },
    { ...args, draft: undefined, exclude_ids: [block.id] },
    { ...args, exclude_ids: block.id },
  ]) {
    const { res } = await call("findSlots", bad);
    assert.equal(res.isError, true, JSON.stringify(bad.exclude_ids));
  }
});

test("a draft section's crossList is read: labeled seminars meet together, unlabeled double-book", async () => {
  const sem = (
    id: string,
    course: string,
    days: string,
    crossList?: string,
  ) => ({
    id,
    course,
    meetings: [{ days, start: "1115", end: "1250" }],
    building: "Godfrey Hall",
    room: "202",
    instructors: ["cn@clemson.edu"],
    cap: 5,
    ...(crossList ? { crossList } : {}),
  });
  const labeled = await call("checkDraft", {
    target_term: "202608",
    draft: [
      sem("s1", "GC 1990", "MF", "GC1"),
      sem("s2", "GC 4990", "F", "GC1"),
    ],
  });
  assert.equal(labeled.res.isError, undefined, labeled.res.content[0]!.text);
  assert.deepEqual(
    labeled.body.problems.map((p: { kind: string }) => p.kind),
    ["meets_together", "meets_together"],
  );
  const bare = await call("checkDraft", {
    target_term: "202608",
    draft: [sem("s1", "GC 1990", "MF"), sem("s2", "GC 4990", "F")],
  });
  assert.ok(
    bare.body.problems.some(
      (p: { kind: string }) => p.kind === "instructor_double_booked",
    ),
  );
});

// --- find-schedule-conflicts (2026-10-30) -------------------------------------
// Chip: find rooms or instructors double booked outside cross-listed
// classes, and list unlabeled 4xxx/6xxx pairs so they get labeled in Banner.
const F = { days: "F", begin: "1010", end: "1310" };
const kim = { name: "Kim Two", email: "ktwo@clemson.edu" };
writeScheduleDb(
  snapshot("202601", [
    // Labeled honors pair: one class, nothing to report.
    sec("2001", "GC4400", "001", [TR], { instructor: kim, crossList: "GC8" }),
    sec("2002", "GC4400", "002", [TR], { instructor: kim, crossList: "GC8" }),
    // Unlabeled 4xxx/6xxx pair, no room: one class, but report the label.
    sec(
      "2003",
      "GC4900",
      "006",
      [{ ...F, building: "No Building Assigned", room: "ROOM" }],
      { instructor: kim },
    ),
    sec(
      "2004",
      "GC6900",
      "002",
      [{ ...F, building: "No Building Assigned", room: "ROOM" }],
      { instructor: kim },
    ),
    // Same instructor, same time, different rooms: instructor double booked.
    sec("2005", "GC3780", "001", [{ ...MW, room: "112" }], { instructor: kim }),
    sec("2006", "GC3790", "001", [{ ...MW, room: "G017" }], {
      instructor: kim,
    }),
    // One room, two instructors, same time: room double booked.
    sec(
      "2007",
      "GC2070",
      "001",
      [{ days: "R", begin: "1400", end: "1515", room: "202" }],
      {
        instructor: { name: "Lee One", email: "lone@clemson.edu" },
      },
    ),
    sec(
      "2008",
      "GC2400",
      "001",
      [{ days: "R", begin: "1430", end: "1545", room: "202" }],
      {
        instructor: { name: "Ann Three", email: "athree@clemson.edu" },
      },
    ),
    // Identical meetings, room and instructor, no label: double booked, but
    // probably a cross-listing missing its label.
    sec(
      "2009",
      "GC1990",
      "001",
      [{ days: "F", begin: "0805", end: "0855", room: "205" }],
      {
        instructor: { name: "Cy Four", email: "cfour@clemson.edu" },
      },
    ),
    sec(
      "2010",
      "GC2990",
      "001",
      [{ days: "F", begin: "0805", end: "0855", room: "205" }],
      {
        instructor: { name: "Cy Four", email: "cfour@clemson.edu" },
      },
    ),
    // Another department in a GC room at the same time.
    sec(
      "2011",
      "GC3450",
      "001",
      [{ days: "T", begin: "1300", end: "1415", room: "101" }],
      {
        instructor: { name: "Dee Five", email: "dfive@clemson.edu" },
      },
    ),
    sec(
      "2012",
      "PRTM4540",
      "001",
      [{ days: "T", begin: "1330", end: "1445", room: "101" }],
      {
        instructor: { name: "Other Person", email: null },
      },
    ),
  ]) as never,
);

test("find-schedule-conflicts: real double bookings once each, unlabeled pairs listed", async () => {
  const { res, body } = await call("findConflicts", {
    term: "202601",
    subject: "GC",
  });
  assert.equal(res.isError, undefined, res.content[0]!.text);
  assert.equal(body.labels_recorded, true);
  type Sec = { crn: string };
  const crnsOf = (x: { sections: Sec[] }) =>
    x.sections
      .map((s) => s.crn)
      .sort()
      .join("+");
  const found = body.double_bookings.map(
    (b: { kind: string; sections: Sec[] }) => `${b.kind}:${crnsOf(b)}`,
  );
  assert.deepEqual(found.sort(), [
    "instructor:2005+2006",
    "instructor:2009+2010",
    "room:2007+2008",
    "room:2009+2010",
    "room_used_by_other_department:2011+2012",
  ]);
  const likely = body.double_bookings.filter(
    (b: { likely_missing_label?: boolean }) => b.likely_missing_label,
  );
  assert.deepEqual(likely.map(crnsOf).sort(), ["2009+2010", "2009+2010"]);
  assert.deepEqual(body.unlabeled_cross_lists.map(crnsOf), ["2003+2004"]);
  assert.match(body.unlabeled_cross_lists[0].note, /label/i);
});

test("find-schedule-conflicts on a snapshot without labels says so", async () => {
  // As written before labels were kept: no crossList field at all.
  const { crossList: _x, ...bare } = sec("4001", "GC3400", "001", [TR]);
  writeScheduleDb(snapshot("202508", [bare as never]) as never);
  const { body } = await call("findConflicts", { term: "202508" });
  assert.equal(body.labels_recorded, false);
  assert.match(body.note, /cross-list labels/);
});
