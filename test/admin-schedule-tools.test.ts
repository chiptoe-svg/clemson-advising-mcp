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
    sec("1001", "GC3400", "001", [TR], { cap: 40 }),
    sec("1002", "GC3400", "002", [TR], { cap: 2 }),
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
  assert.equal(ops.length, 5);
  for (const t of Object.values(__adminTools))
    assert.equal(t.category, "admin");
  const schedule = expandScopes(["clemson.schedule"]);
  const admin = expandScopes(["clemson.admin"]);
  for (const op of ops) {
    assert.equal(schedule.has(op), false, op);
    assert.equal(admin.has(op), true, op);
  }
});
