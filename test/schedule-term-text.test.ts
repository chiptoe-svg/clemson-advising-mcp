// A TEXT term must not read as "that term was never ingested" (2026-08-28).
//
// Reproduced against the live server before the fix: get-sections-by-crn with
// term "Fall 2026" returned has_snapshot:false — about the current term, whose
// snapshot had been fetched that morning. The tool whose job is to be the
// authority a model checks its own CRNs against was confidently wrong, in
// exactly the shape this project keeps hitting: silence read as absence.
//
// The absence of a test that passed anything but a six-digit code is why it
// shipped, so every schedule tool that takes a term is exercised here with a
// NAME, and the two answer shapes are pinned apart:
//   unparseable term        -> an error (the caller said something wrong)
//   valid term, no snapshot -> has_snapshot:false (nothing was checked)

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "term-text-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { __setTermClockForTest } = await import("../src/term-resolve.ts");
const { __schedTools } = await import("../src/mcp-tools/clemson-schedule.ts");

// One snapshot, Fall 2026, with one real section.
writeScheduleDb({
  term: "202608",
  termDescription: "Fall 2026",
  fetchedAt: new Date().toISOString(),
  sectionCount: 1,
  sections: [
    {
      crn: "80773",
      subjectCourse: "GC1040",
      section: "001",
      title: "Graphic Communications I",
      campus: "C",
      scheduleType: "Lecture",
      instructionalMethod: "F",
      creditHours: 4,
      enrollment: 10,
      maxEnrollment: 20,
      seatsAvailable: 10,
      waitCount: 0,
      waitCapacity: 0,
      open: true,
      meetings: [
        {
          days: "TR",
          beginTime: "1230",
          endTime: "1345",
          building: "Godfrey",
          room: "201",
          type: "Class",
        },
      ],
      instructors: [],
    },
  ],
} as never);

// Pin the clock inside Fall 2026 so "the current registration term" is 202608.
__setTermClockForTest(() => new Date("2026-09-15T12:00:00Z"));

function body(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

test('get-sections-by-crn accepts "Fall 2026" and finds the section', async () => {
  const res = await __schedTools.sectionsByCrn.handler({
    term: "Fall 2026",
    crns: ["80773"],
  });
  assert.equal(res.isError, undefined, JSON.stringify(res));
  const b = body(res as never);
  assert.equal(
    b.has_snapshot,
    true,
    "a text term must not read as an un-ingested term",
  );
  assert.equal(
    b.term,
    "202608",
    "the resolved code is echoed, not the raw text",
  );
  assert.equal((b.sections as { crn: string }[])[0]?.crn, "80773");
  assert.deepEqual(b.not_found, []);
});

test('resolve-crns accepts "Fall 2026"', async () => {
  const res = await __schedTools.resolveCrns.handler({
    term: "fall 2026",
    sections: [{ subject_course: "GC 1040", section: "001" }],
  });
  const b = body(res as never);
  assert.equal(b.has_snapshot, true);
  assert.deepEqual(b.crns, ["80773"]);
});

test('get-schedule-freshness accepts "Fall 2026"', async () => {
  const res = await __schedTools.scheduleFreshness.handler({
    term: "Fall 2026",
  });
  const b = body(res as never);
  assert.equal(
    b.has_snapshot,
    true,
    "a text term must not report the snapshot missing",
  );
  assert.equal(b.term, "202608");
});

test('find-conflict-free-schedule accepts "Fall 2026"', async () => {
  const res = await __schedTools.findConflictFree.handler({
    term: "Fall 2026",
    fixed_crns: ["80773"],
    candidate_crns: ["80773"],
  });
  assert.equal(res.isError, undefined, JSON.stringify(res));
});

test("an omitted term defaults to the current registration term", async () => {
  const res = await __schedTools.sectionsByCrn.handler({ crns: ["80773"] });
  const b = body(res as never);
  assert.equal(b.term, "202608");
  assert.equal(b.has_snapshot, true);
});

test("an UNPARSEABLE term is an error, not an un-ingested term", async () => {
  // The distinction that matters: "banana" is the caller saying something
  // wrong. Reporting it as has_snapshot:false would tell a model that a term
  // it never named has no data.
  for (const bad of ["banana", "2026-08", "Fall 26", "202699"]) {
    const res = await __schedTools.sectionsByCrn.handler({
      term: bad,
      crns: ["80773"],
    });
    assert.equal(res.isError, true, `${bad} must be an error`);
    assert.match(
      (res.content[0] as { text: string }).text,
      /Unrecognized term|Accepted forms/,
    );
  }
});

test("a VALID term with no snapshot still reports has_snapshot:false, not an error", async () => {
  // The three-state design survives the fix: Spring 2027 is a real term this
  // box has not ingested. Nothing was checked, so not_found stays EMPTY —
  // never "every CRN you gave me is fake".
  const res = await __schedTools.sectionsByCrn.handler({
    term: "Spring 2027",
    crns: ["80773"],
  });
  assert.equal(res.isError, undefined);
  const b = body(res as never);
  assert.equal(b.has_snapshot, false);
  assert.equal(
    b.term,
    "202701",
    "the resolved code, so the note names a real term",
  );
  assert.deepEqual(
    b.not_found,
    [],
    "nothing was checked, so nothing is claimed",
  );
});
