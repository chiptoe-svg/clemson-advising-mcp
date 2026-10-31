// find-alternatives with `courses`: "which of these courses could she add
// around the classes she keeps? List every one." A subject-wide call is cut to
// the sections with the most open seats, so a model could not confirm every
// course from one answer and ran out of rounds checking them one by one
// (Cob_advisor's T10d, 2026-10-31). With `courses`, each listed course gets a
// verdict from all of its sections: fits, the sections that fit, or the kept
// CRNs that block it.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "advising-mcp-alt-courses-"));
process.env.STATE_DIR = TMP;

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { findAlternatives } = await import("../src/mcp-tools/core-search.ts");
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClemsonTermSnapshot } from "../src/clemson-classes.ts";

const TERM = "202708";
type Section = ClemsonTermSnapshot["sections"][number];

function section(
  crn: string,
  subjectCourse: string,
  days: string | null,
  begin = "",
  end = "",
  seats = 10,
): Section {
  return {
    term: TERM,
    termDescription: "Fall 2027",
    crn,
    subjectCourse,
    section: "001",
    title: `${subjectCourse} title`,
    campus: "Main",
    scheduleType: "Lecture",
    instructionalMethod: null,
    partOfTerm: "1",
    creditHours: 3,
    enrollment: 5,
    maxEnrollment: 20,
    seatsAvailable: seats,
    waitCount: 0,
    waitCapacity: 0,
    open: seats > 0,
    instructors: [],
    meetings: days
      ? [
          {
            days,
            beginTime: begin,
            endTime: end,
            building: "Hall",
            room: "1",
            roomCapacity: null,
            startDate: null,
            endDate: null,
            type: "Lecture",
          },
        ]
      : [],
  };
}

const sections = [
  section("60001", "GC3400", "TR", "0930", "1045"), // kept
  section("60002", "GC3720", "MWF", "1000", "1050"), // kept, or swapped out
  section("60011", "GC3460", "TR", "0930", "1045"), // blocked by 60001
  section("60012", "GC3460", "MWF", "1100", "1150"), // fits
  section("60021", "GC4400", "TR", "1000", "1115"), // blocked by 60001
  section("60022", "GC4400", "MW", "1000", "1115"), // blocked by 60002
  section("60031", "GC4060", null), // online: fits
  section("60041", "GC4800", "MWF", "1000", "1050"), // only the swapped slot
  // A big course: every section fits, more than the listing shows.
  ...Array.from({ length: 30 }, (_, i) =>
    section(String(60100 + i), "GC1990", "F", "1400", "1450"),
  ),
];
writeScheduleDb({
  term: TERM,
  termDescription: "Fall 2027",
  fetchedAt: "2026-10-31T05:00:00.000Z",
  sectionCount: sections.length,
  sections,
});

function json(res: CallToolResult) {
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  return JSON.parse((res.content[0] as { text: string }).text);
}
const byCourse = (body: any) =>
  Object.fromEntries(body.courses.map((c: any) => [c.course, c]));

test("each listed course gets a verdict from all its sections", async () => {
  const body = json(
    await findAlternatives.handler({
      term: TERM,
      current_crns: ["60001", "60002"],
      courses: ["GC 3460", "GC 4400", "GC 4060", "GC 9999"],
    }),
  );
  const c = byCourse(body);
  assert.equal(c["GC 3460"].fits, true);
  assert.deepEqual(
    c["GC 3460"].fitting.map((s: any) => s.crn),
    ["60012"],
  );
  assert.equal(c["GC 4400"].fits, false);
  assert.deepEqual(
    c["GC 4400"].blocked
      .map((b: any) => [b.crn, b.blocked_by])
      .sort((a: any, b: any) => a[0].localeCompare(b[0])),
    [
      ["60021", ["60001"]],
      ["60022", ["60002"]],
    ],
  );
  assert.equal(c["GC 4060"].fits, true); // no meeting times: never clashes
  assert.equal(c["GC 9999"].offered, false);
  assert.equal(c["GC 9999"].fits, false);
  assert.deepEqual(body.summary, {
    fit: ["GC 3460", "GC 4060"],
    do_not_fit: ["GC 4400"],
    not_offered: ["GC 9999"],
  });
  assert.equal(body.truncated, undefined);
});

test("course codes are accepted without a space and in lower case", async () => {
  const body = json(
    await findAlternatives.handler({
      term: TERM,
      current_crns: ["60001"],
      courses: ["gc3460"],
    }),
  );
  assert.equal(body.courses[0].course, "GC 3460");
  assert.equal(body.courses[0].fits, true);
});

test("a big course's verdict counts every section; the listing is capped", async () => {
  const body = json(
    await findAlternatives.handler({
      term: TERM,
      current_crns: ["60001"],
      courses: ["GC 1990"],
    }),
  );
  const c = body.courses[0];
  assert.equal(c.fits, true);
  assert.equal(c.fitting_count, 30);
  assert.equal(c.fitting.length, 10);
});

test("replacing_crn frees its slot for the listed courses", async () => {
  const kept = json(
    await findAlternatives.handler({
      term: TERM,
      current_crns: ["60001", "60002"],
      courses: ["GC 4800"],
    }),
  );
  assert.equal(kept.courses[0].fits, false);
  const swapped = json(
    await findAlternatives.handler({
      term: TERM,
      current_crns: ["60001", "60002"],
      replacing_crn: "60002",
      courses: ["GC 4800"],
    }),
  );
  assert.equal(swapped.courses[0].fits, true);
});

test("a course whose sections all miss the time filters says so, not 'blocked'", async () => {
  const body = json(
    await findAlternatives.handler({
      term: TERM,
      current_crns: ["60001"],
      courses: ["GC 3460"],
      no_meeting_before: "1200",
    }),
  );
  const c = body.courses[0];
  assert.equal(c.fits, false);
  assert.equal(c.outside_filters, 2);
  assert.deepEqual(c.blocked, []);
});

test("bad course lists are refused", async () => {
  for (const args of [
    { courses: ["GC 3460"], subject: "GC" },
    { courses: ["not a course"] },
    { courses: Array.from({ length: 21 }, (_, i) => `GC ${1000 + i}`) },
  ]) {
    const res = await findAlternatives.handler({
      term: TERM,
      current_crns: ["60001"],
      ...args,
    });
    assert.equal(res.isError, true, JSON.stringify(args));
  }
});

test("a listed course she already keeps says so, not 'blocked by itself'", async () => {
  const body = json(
    await findAlternatives.handler({
      term: TERM,
      current_crns: ["60001"],
      courses: ["GC 3400"],
    }),
  );
  const c = body.courses[0];
  assert.deepEqual(c.already_kept, ["60001"]);
  assert.equal(
    JSON.stringify(c.blocked ?? []).includes('"60001"]'),
    false,
    JSON.stringify(c),
  );
});
