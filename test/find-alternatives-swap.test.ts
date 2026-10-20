// find-alternatives for a SWAP: "she wants to swap out CRN X for something
// that doesn't wreck the rest of her week — Y stays." Cob_advisor's T3c failed
// on every model (2026-10-20): models looked X up, then fell back to
// search-classes, because nothing connected "swap/replace" to "pass the CRNs
// she keeps". replacing_crn takes the dropped section directly: its subject and
// credit hours become the default filters, and it is never offered back.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "advising-mcp-swap-"));
process.env.STATE_DIR = TMP;

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { findAlternatives, searchClasses } =
  await import("../src/mcp-tools/core-search.ts");
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClemsonTermSnapshot } from "../src/clemson-classes.ts";

const TERM = "202708";

function section(
  crn: string,
  subjectCourse: string,
  creditHours: number,
  days: string,
  begin: string,
  end: string,
): ClemsonTermSnapshot["sections"][number] {
  return {
    term: TERM,
    termDescription: "Fall 2027",
    crn,
    subjectCourse,
    section: "001",
    title: subjectCourse,
    campus: "Main",
    scheduleType: "Lecture",
    instructionalMethod: null,
    partOfTerm: "1",
    creditHours,
    enrollment: 5,
    maxEnrollment: 20,
    seatsAvailable: 10,
    waitCount: 0,
    waitCapacity: 0,
    open: true,
    instructors: [],
    meetings: [
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
    ],
  };
}

const sections = [
  section("50001", "GC3400", 3, "TR", "0930", "1045"), // kept
  section("50002", "GC3720", 3, "MWF", "1000", "1050"), // being swapped out
  section("50003", "GC3600", 3, "MWF", "1000", "1050"), // the dropped slot: fits
  section("50004", "GC3610", 3, "TR", "0930", "1045"), // clashes with the keeper
  section("50005", "MATH1080", 3, "MWF", "1300", "1350"), // other subject
  section("50006", "GC1050", 1, "MWF", "1400", "1450"), // other credit hours
];
writeScheduleDb({
  term: TERM,
  termDescription: "Fall 2027",
  fetchedAt: "2026-10-20T05:00:00.000Z",
  sectionCount: sections.length,
  sections,
});

function json(res: CallToolResult) {
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  return JSON.parse((res.content[0] as { text: string }).text);
}
const crns = (body: any) => body.sections.map((s: any) => s.crn).sort();

test("replacing_crn: same subject and credits by default, never the dropped section, fits the keepers", async () => {
  const body = json(
    await findAlternatives.handler({
      term: TERM,
      current_crns: ["50001"],
      replacing_crn: "50002",
    }),
  );
  assert.deepEqual(crns(body), ["50003"]);
  assert.equal(body.replacing.crn, "50002");
  assert.equal(body.replacing.subject_course, "GC3720");
  assert.deepEqual(body.replacing.applied, { subject: "GC", credits: 3 });
});

test("replacing_crn also listed in current_crns is dropped from the keepers, and said so", async () => {
  // A model that passes her whole schedule would otherwise block the very
  // slot she is freeing up.
  const body = json(
    await findAlternatives.handler({
      term: TERM,
      current_crns: ["50001", "50002"],
      replacing_crn: "50002",
    }),
  );
  assert.deepEqual(crns(body), ["50003"]);
  assert.match(body.replacing.note, /removed from current_crns/);
});

test("explicit subject/credits override the dropped section's", async () => {
  const body = json(
    await findAlternatives.handler({
      term: TERM,
      current_crns: ["50001"],
      replacing_crn: "50002",
      subject: "MATH",
    }),
  );
  assert.deepEqual(crns(body), ["50005"]);
  assert.deepEqual(body.replacing.applied, { subject: "MATH", credits: 3 });
});

test("an unknown replacing_crn is an error, not an unfiltered list", async () => {
  const res = await findAlternatives.handler({
    term: TERM,
    current_crns: ["50001"],
    replacing_crn: "59999",
  });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /59999/);
});

test("descriptions route swap/replace questions to find-alternatives", () => {
  const fa = findAlternatives.tool.description ?? "";
  assert.match(fa, /swap|replace/i);
  assert.match(fa, /replacing_crn/);
  const sc = searchClasses.tool.description ?? "";
  assert.match(sc, /swap|replace/i);
  assert.match(sc, /find-alternatives/);
});
