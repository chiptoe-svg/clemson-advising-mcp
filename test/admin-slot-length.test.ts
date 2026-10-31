// find-offering-slots keeps a section's length (Cob_advisor, 2026-10-31;
// Chip: do it). Moving GC 3461 001, a 165-minute Tuesday lab, used to offer
// only the term's common 50/75-minute lecture patterns, so applying one turned
// the lab into a 50-minute class. Slots now match the section being moved
// (exclude_ids) — or, with nothing excluded, the shapes the course already
// uses — by weekly minutes (±10%) and meetings per week.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sec, snapshot } from "./helpers/admin-fixture.ts";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "admin-length-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { __adminTools } = await import("../src/mcp-tools/admin-schedule.ts");

const MWF = (b: string, e: string) => ({ days: "MWF", begin: b, end: e });
const TR = (b: string, e: string) => ({ days: "TR", begin: b, end: e });
const nobody = { instructor: null } as const;
let crn = 3000;
const filler = (meet: ReturnType<typeof MWF>, n: number) =>
  Array.from({ length: n }, () =>
    sec(String(crn++), "MATH1010", "001", [{ ...meet, room: "900" }], nobody),
  );

writeScheduleDb(
  snapshot("202608", [
    // The term's common lecture patterns, in a room nobody else needs.
    ...filler(MWF("0905", "0955"), 6),
    ...filler(MWF("1010", "1100"), 6),
    ...filler(TR("0930", "1045"), 6),
    ...filler(TR("1100", "1215"), 6),
    // Labs: the one being moved, and another lab time used elsewhere.
    sec("2001", "GC3461", "001", [
      { days: "T", begin: "1100", end: "1345", room: "101C" },
    ]),
    sec(
      "2002",
      "BIOL1030",
      "001",
      [{ days: "R", begin: "1400", end: "1645", room: "500" }],
      nobody,
    ),
    // A lecture course that runs both MWF and TR.
    sec("2003", "GC3400", "001", [MWF("0905", "0955")], {
      instructor: { name: "A", email: "a@clemson.edu" },
    }),
    sec("2004", "GC3400", "002", [TR("0930", "1045")], {
      instructor: { name: "B", email: "b@clemson.edu" },
    }),
  ]) as never,
);

type Res = { isError?: boolean; content: { text: string }[] };
const call = async (
  tool: keyof typeof __adminTools,
  args: Record<string, unknown>,
) => {
  const res = (await __adminTools[tool].handler(args)) as Res;
  assert.equal(res.isError, undefined, res.content[0]!.text);
  return JSON.parse(res.content[0]!.text);
};
type Slot = { meetings: { days: string; start: string; end: string }[] };
const shape = (s: Slot) =>
  s.meetings.map((m) => `${m.days} ${m.start}-${m.end}`).join(", ");

test("moving a 165-minute lab offers only lab-length slots, its own time included", async () => {
  const roll = await call("rollover", { term: "202608" });
  const lab = roll.sections.find(
    (s: { course: string }) => s.course === "GC 3461",
  );
  const body = await call("findSlots", {
    target_term: "202708",
    base_term: "202608",
    course: "GC 3461",
    draft: roll.sections,
    exclude_ids: [lab.id],
  });
  const shapes = body.slots.map(shape);
  assert.ok(shapes.length > 0);
  assert.ok(shapes.includes("T 1100-1345"), JSON.stringify(shapes));
  assert.ok(shapes.includes("R 1400-1645"), JSON.stringify(shapes));
  assert.ok(
    !shapes.some((x: string) => /MWF|TR/.test(x)),
    JSON.stringify(shapes),
  );
  assert.deepEqual(body.matched_length, {
    weekly_minutes: 165,
    meetings_per_week: 1,
    from: "the excluded section",
  });
});

test("with nothing excluded, a course gets the shapes it already uses", async () => {
  const body = await call("findSlots", {
    target_term: "202708",
    base_term: "202608",
    course: "GC 3400",
  });
  const shapes: string[] = body.slots.map(shape);
  assert.ok(shapes.some((x) => x.startsWith("MWF")));
  assert.ok(shapes.some((x) => x.startsWith("TR")));
  assert.ok(!shapes.some((x) => /^[TR] /.test(x)), JSON.stringify(shapes));
  assert.equal(body.matched_length.from, "GC 3400's sections");
});

test("a course with no meeting times to go by gets the common patterns, as before", async () => {
  const body = await call("findSlots", {
    target_term: "202708",
    base_term: "202608",
    course: "GC 4990",
    draft: [
      {
        id: "new:GC 4990:1",
        course: "GC 4990",
        meetings: [],
        building: null,
        room: null,
        instructors: [],
        cap: 20,
      },
    ],
  });
  assert.ok(body.slots.length > 0);
  assert.equal(body.matched_length, null);
});

test("a lecture can still switch between the MWF and TR grids (same weekly minutes)", async () => {
  const roll = await call("rollover", { term: "202608" });
  const tr = roll.sections.find(
    (s: { id: string; course: string }) =>
      s.course === "GC 3400" && s.id === "2004",
  );
  const body = await call("findSlots", {
    target_term: "202708",
    base_term: "202608",
    course: "GC 3400",
    draft: roll.sections,
    exclude_ids: [tr.id],
  });
  const shapes: string[] = body.slots.map(shape);
  assert.ok(
    shapes.some((x) => x.startsWith("TR")),
    JSON.stringify(shapes),
  );
  assert.ok(
    shapes.some((x) => x.startsWith("MWF")),
    JSON.stringify(shapes),
  );
});

test("the section's own time comes first, so the slot cap never cuts it", async () => {
  const roll = await call("rollover", { term: "202608" });
  const body = await call("findSlots", {
    target_term: "202708",
    base_term: "202608",
    course: "GC 3461",
    draft: roll.sections,
    exclude_ids: ["2001"],
  });
  assert.equal(shape(body.slots[0]), "T 1100-1345");
});
