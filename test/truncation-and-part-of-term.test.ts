// Two fixes from 2026-09-08, both driven by a wrong answer a real user saw.
//
// 1. TRUNCATION SAYS SO IN WORDS. Asked for Summer 2026's GC 4000-level
//    courses, an assistant answered with two zero-credit internships. The
//    snapshot held 18 GC 4xxx sections; a subject query returned the top 12 by
//    open seats, the internships floated up because nobody enrols in them, and
//    the model filtered that page and reported it as the whole list.
//    needsNarrowing already carried the counts and was read straight past, so
//    the response now states the cut and its BIAS in a sentence.
//
// 2. part_of_term IS CARRIED. "Which part of summer was this offered in?" was
//    unanswerable. Banner ships the code in the same search response we already
//    fetch; it was simply never read.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "truncation-pot-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb, scheduleDbPath, snapshotHasColumn, openScheduleDb } =
  await import("../src/clemson-schedule-db.ts");
const { querySectionsEngine } =
  await import("../src/mcp-tools/section-query.ts");

/** Unwrap the engine's error union so tests read against the result shape. */
function engine(filters: Record<string, unknown>) {
  const r = querySectionsEngine(filters as never);
  assert.ok(!("error" in r), `engine error: ${(r as any).error}`);
  return r as Exclude<typeof r, { error: string }>;
}

function section(
  crn: string,
  course: string,
  seats: number,
  partOfTerm: string | null,
) {
  return {
    crn,
    subjectCourse: course,
    section: "001",
    title: `${course} title`,
    campus: "C",
    scheduleType: "Lecture",
    instructionalMethod: "F",
    partOfTerm,
    creditHours: 3,
    enrollment: 20 - seats,
    maxEnrollment: 20,
    seatsAvailable: seats,
    waitCount: 0,
    waitCapacity: 0,
    open: true,
    meetings: [],
    instructors: [],
  } as never;
}

// 20 GC sections: the two "internships" have every seat free, so an
// open-seats sort puts them first — the exact shape that produced the wrong
// answer. The other 18 are progressively fuller.
const sections = [
  section("50419", "GC4500", 20, "1"),
  section("50420", "GC4550", 20, "1"),
  ...Array.from({ length: 18 }, (_, i) =>
    section(
      String(52000 + i),
      `GC${4060 + i}`,
      18 - i,
      i % 2 === 0 ? "H1" : "H2",
    ),
  ),
];
writeScheduleDb({
  term: "202605",
  termDescription: "Summer 2026",
  fetchedAt: "2026-08-04T05:00:00Z",
  sectionCount: sections.length,
  sections,
});

// ---------------------------------------------------------------------------
// 1. Truncation states itself
// ---------------------------------------------------------------------------

test("a truncated result says so in words, with counts and the ordering bias", () => {
  const res = engine({ term: "202605", subject: "GC" });
  assert.equal(res.totalCount, 20);
  assert.ok(
    res.sections.length < res.totalCount,
    "fixture must actually truncate",
  );
  const tr = res.truncated;
  assert.ok(tr, "a cut result must carry `truncated`");
  assert.equal(tr.shown, res.sections.length);
  assert.equal(tr.total, 20);
  assert.match(tr.note, /PARTIAL RESULT/);
  assert.match(tr.note, /showing 12 of 20/);
  // The bias must be named, not just the cut: these are the EMPTIEST sections.
  assert.match(tr.note, /MOST OPEN SEATS/);
  assert.match(tr.note, /not a representative sample/i);
  assert.match(tr.note, /offset/, "must say how to get the rest");
  assert.equal(tr.ordered_by, "seats_available desc");
});

test("the reported page really is the emptiest sections — the bias the note warns about", () => {
  const res = engine({ term: "202605", subject: "GC" });
  const crns = res.sections.map((s) => s.crn);
  assert.ok(
    crns.includes("50419") && crns.includes("50420"),
    "the two all-empty sections should lead an open-seats sort",
  );
  // And the fullest section is NOT shown — which is why answering "what was
  // offered" from this page is wrong.
  assert.ok(!crns.includes("52017"), "the fullest section should be cut");
});

test("an untruncated result carries no truncation claim at all", () => {
  const res = engine({ term: "202605", subject: "GC", courseNumber: "4500" });
  assert.equal(res.totalCount, 1);
  assert.equal(res.truncated, undefined);
  assert.equal(res.needsNarrowing, undefined);
});

// ---------------------------------------------------------------------------
// 2. part_of_term, passed through verbatim
// ---------------------------------------------------------------------------

test("part_of_term is returned verbatim, never bucketed", () => {
  const res = engine({ term: "202605", subject: "GC", courseNumber: "4060" });
  assert.equal(res.sections[0].partOfTerm, "H1");
  const second = engine({
    term: "202605",
    subject: "GC",
    courseNumber: "4061",
  });
  assert.equal(second.sections[0].partOfTerm, "H2");
  const full = engine({ term: "202605", subject: "GC", courseNumber: "4500" });
  assert.equal(full.sections[0].partOfTerm, "1");
});

test("mini-mester codes survive as themselves", () => {
  // Chip, 2026-09-08: report MMA/MMB/MMC/MMD as they come, not collapsed to a
  // "custom" label — which session a course ran in is the whole question.
  writeScheduleDb({
    term: "202505",
    termDescription: "Summer 2025",
    fetchedAt: "2025-08-04T05:00:00Z",
    sectionCount: 2,
    sections: [
      section("60001", "GC1000", 5, "MMA"),
      section("60002", "GC1001", 5, "MMD"),
    ],
  });
  const a = engine({ term: "202505", subject: "GC", courseNumber: "1000" });
  assert.equal(a.sections[0].partOfTerm, "MMA");
  const d = engine({ term: "202505", subject: "GC", courseNumber: "1001" });
  assert.equal(d.sections[0].partOfTerm, "MMD");
});

// ---------------------------------------------------------------------------
// The compatibility guarantee: 34 archived snapshots predate the column and,
// being frozen, can never gain it. Reading one must not throw.
// ---------------------------------------------------------------------------

test("a snapshot written before the column existed still reads, reporting null", () => {
  // Build an old-format snapshot by dropping the column back off a fresh one.
  writeScheduleDb({
    term: "202501",
    termDescription: "Spring 2025",
    fetchedAt: "2025-01-04T05:00:00Z",
    sectionCount: 1,
    sections: [section("70001", "GC1010", 5, "1")],
  });
  const p = scheduleDbPath("202501")!;
  const w = new Database(p);
  w.exec("ALTER TABLE sections DROP COLUMN part_of_term");
  w.close();

  const probe = openScheduleDb("202501")!;
  assert.equal(
    snapshotHasColumn(probe, "part_of_term"),
    false,
    "fixture must actually lack the column",
  );
  probe.close();

  const res = engine({ term: "202501", subject: "GC" });
  assert.equal(res.totalCount, 1, "an old snapshot must still be readable");
  assert.equal(
    res.sections[0].partOfTerm,
    null,
    "not recorded is null — never a guessed session",
  );
});
