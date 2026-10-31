// Schedules planned across subjects (Chip, 2026-10-31: "PKSC and MKT are
// about all I can imagine coordinating"). `subject: "GC,PKSC"` makes both
// subjects the draft's own: their base sections are what the draft replaces,
// not another department's bookings. A single subject behaves as before.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sec, snapshot } from "./helpers/admin-fixture.ts";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "admin-multi-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { __adminTools } = await import("../src/mcp-tools/admin-schedule.ts");

const TR = { days: "TR", begin: "0930", end: "1045" };
const MW = { days: "MW", begin: "1115", end: "1230" };
writeScheduleDb(
  snapshot("202608", [
    sec("2001", "GC3400", "001", [TR], {
      instructor: { name: "Gee See", email: "gc@clemson.edu" },
    }),
    sec("2002", "PKSC2010", "001", [{ ...MW, room: "205" }], {
      instructor: { name: "Pack Person", email: "pk@clemson.edu" },
    }),
    sec("2003", "MKT3010", "001", [{ ...TR, room: "300" }], {
      instructor: { name: "Mark Et", email: "mk@clemson.edu" },
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
const courses = (body: { sections: { course: string }[] }) =>
  body.sections.map((s) => s.course).sort();

test("get-department-draft takes several subjects", async () => {
  const body = await call("rollover", {
    term: "202608",
    subject: "gc, PKSC",
  });
  assert.equal(body.subject, "GC,PKSC");
  assert.deepEqual(courses(body), ["GC 3400", "PKSC 2010"]);
});

test("a GC+PKSC draft checked as both: PKSC sections don't clash with their own base copies", async () => {
  const roll = await call("rollover", { term: "202608", subject: "GC,PKSC" });
  const both = await call("checkDraft", {
    target_term: "202708",
    base_term: "202608",
    subject: "GC,PKSC",
    draft: roll.sections,
  });
  const clashes = both.problems.filter((p: { kind: string }) =>
    /double_booked|other_department/.test(p.kind),
  );
  assert.deepEqual(clashes, []);
  // Checked as GC alone, the same draft's PKSC section collides with itself.
  const gcOnly = await call("checkDraft", {
    target_term: "202708",
    base_term: "202608",
    subject: "GC",
    draft: roll.sections,
  });
  assert.ok(
    gcOnly.problems.some((p: { kind: string }) =>
      /double_booked|other_department/.test(p.kind),
    ),
  );
});

test("other subjects stay fixed: a draft section moved onto MKT's room is flagged", async () => {
  const roll = await call("rollover", { term: "202608", subject: "GC,PKSC" });
  const moved = roll.sections.map((s: Record<string, unknown>) =>
    s.course === "PKSC 2010"
      ? {
          ...s,
          meetings: [{ days: "TR", start: "0930", end: "1045" }],
          room: "300",
        }
      : s,
  );
  const body = await call("checkDraft", {
    target_term: "202708",
    base_term: "202608",
    subject: "GC,PKSC",
    draft: moved,
  });
  assert.ok(
    body.problems.some(
      (p: { kind: string }) => p.kind === "room_used_by_other_department",
    ),
    JSON.stringify(body.problems),
  );
});
