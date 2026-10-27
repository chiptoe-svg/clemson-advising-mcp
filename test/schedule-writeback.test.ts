// test/schedule-writeback.test.ts
//
// A live search-classes refresh writes what it fetched back into the term's
// snapshot (2026-10-27: a refresh showed GC 3450 at 2:00, the next snapshot
// answer in the same chat showed the morning's 3:30). Invariant: for any
// slice, a reader sees old or new, never a mix; a fetch that is not complete
// for its slice never deletes; no snapshot file means no write at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";

import Database from "better-sqlite3";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "advising-mcp-writeback-"));
process.env.STATE_DIR = TMP;

const { writeScheduleDb, writeScheduleSlice, scheduleDbPath } =
  await import("../src/clemson-schedule-db.ts");
const { querySectionsEngine } =
  await import("../src/mcp-tools/section-query.ts");
const { makeSearchClasses } = await import("../src/mcp-tools/core-search.ts");
import type {
  ClemsonSearchResult,
  ClemsonTermSnapshot,
} from "../src/clemson-classes.ts";

type Section = ClemsonTermSnapshot["sections"][number];
const TERM = "202701";
const BASE_TIME = "2026-10-27T09:01:08.913Z";

function sec(
  crn: string,
  subjectCourse: string,
  days: string,
  begin: string,
  end: string,
  room = "202",
  instructor = "Chas Williams",
): Section {
  return {
    crn,
    term: TERM,
    termDescription: "Spring 2027",
    subjectCourse,
    section: "001",
    title: `${subjectCourse} title`,
    campus: "Main",
    scheduleType: "Lecture",
    instructionalMethod: null,
    partOfTerm: "1",
    creditHours: 3,
    enrollment: 0,
    maxEnrollment: 20,
    seatsAvailable: 20,
    waitCount: 0,
    waitCapacity: 0,
    open: true,
    instructors: [{ name: instructor, email: null, primary: true }],
    meetings: [
      {
        days,
        beginTime: begin,
        endTime: end,
        building: "Godfrey Hall",
        room,
        roomCapacity: null,
        startDate: null,
        endDate: null,
        type: "Class",
      },
    ],
  } as Section;
}

const BASE: Section[] = [
  sec("100", "GC1010", "MW", "0900", "0950"),
  sec("16071", "GC3450", "TR", "1530", "1645"),
  sec("300", "MATH1060", "MWF", "1000", "1050", "100"),
];

fs.mkdirSync(path.join(TMP, "clemson"), { recursive: true });

beforeEach(() => {
  for (const f of fs.readdirSync(path.join(TMP, "clemson")))
    fs.rmSync(path.join(TMP, "clemson", f), { force: true });
  assert.ok(
    writeScheduleDb({
      term: TERM,
      termDescription: "Spring 2027",
      fetchedAt: BASE_TIME,
      sectionCount: BASE.length,
      sections: BASE,
    }),
  );
});

function rows(sql: string, ...b: unknown[]) {
  const db = new Database(scheduleDbPath(TERM), { readonly: true });
  try {
    return db.prepare(sql).all(...b) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}
const crnsOf = () =>
  rows("SELECT crn FROM sections ORDER BY crn").map((r) => r.crn);
const meetingsOf = (crn: string) =>
  rows(
    "SELECT day, start_min FROM meetings WHERE crn = ? ORDER BY day",
    crn,
  ).map((r) => `${r.day}${r.start_min}`);

test("a complete subject fetch replaces the subject: updates, adds, and drops what Banner no longer lists", () => {
  const ok = writeScheduleSlice(
    TERM,
    { subject: "GC", complete: true },
    [
      sec("16071", "GC3450", "TR", "1400", "1515"),
      sec("400", "GC2000", "F", "0800", "0850"),
    ],
    "2026-10-27T21:20:00.000Z",
  );
  assert.equal(ok, true);
  assert.deepEqual(crnsOf(), ["16071", "300", "400"]); // 100 dropped, MATH kept
  assert.deepEqual(meetingsOf("16071"), ["R840", "T840"]); // replaced, not doubled
  assert.equal(
    rows("SELECT count(*) n FROM instructors WHERE crn = '100'")[0].n,
    0,
  );
});

test("a subject + course fetch replaces only that course", () => {
  writeScheduleSlice(
    TERM,
    { subject: "GC", courseNumber: "3450", complete: true },
    [sec("16071", "GC3450", "TR", "1400", "1515")],
    "2026-10-27T21:20:00.000Z",
  );
  assert.deepEqual(crnsOf(), ["100", "16071", "300"]);
  assert.deepEqual(meetingsOf("16071"), ["R840", "T840"]);
});

test("an incomplete fetch (open seats only) updates what it got and deletes nothing", () => {
  writeScheduleSlice(
    TERM,
    { subject: "GC", complete: false },
    [sec("16071", "GC3450", "TR", "1400", "1515")],
    "2026-10-27T21:20:00.000Z",
  );
  assert.deepEqual(crnsOf(), ["100", "16071", "300"]);
  assert.deepEqual(meetingsOf("16071"), ["R840", "T840"]);
});

test("a complete fetch with no sections writes nothing (never delete a whole subject on an empty answer)", () => {
  const ok = writeScheduleSlice(
    TERM,
    { subject: "GC", complete: true },
    [],
    "2026-10-27T21:20:00.000Z",
  );
  assert.equal(ok, false);
  assert.deepEqual(crnsOf(), ["100", "16071", "300"]);
});

test("a section outside the slice is never written into it", () => {
  const ok = writeScheduleSlice(
    TERM,
    { subject: "GC", complete: true },
    [
      sec("16071", "GC3450", "TR", "1400", "1515"),
      sec("999", "MATH9999", "F", "0800", "0850"),
    ],
    "2026-10-27T21:20:00.000Z",
  );
  assert.equal(ok, false);
  assert.deepEqual(crnsOf(), ["100", "16071", "300"]);
  assert.deepEqual(meetingsOf("16071"), ["R930", "T930"]);
});

test("a failure part-way leaves the old slice whole", () => {
  const bad = sec("400", "GC2000", "F", "0800", "0850");
  (bad as { title: unknown }).title = null; // NOT NULL column → throws mid-write
  const ok = writeScheduleSlice(
    TERM,
    { subject: "GC", complete: true },
    [sec("16071", "GC3450", "TR", "1400", "1515"), bad],
    "2026-10-27T21:20:00.000Z",
  );
  assert.equal(ok, false);
  assert.deepEqual(crnsOf(), ["100", "16071", "300"]);
  assert.deepEqual(meetingsOf("16071"), ["R930", "T930"]);
});

test("no snapshot file: nothing is written and no file is created", () => {
  const ok = writeScheduleSlice(
    "202705",
    { subject: "GC", complete: true },
    [{ ...sec("16071", "GC3450", "TR", "1400", "1515"), term: "202705" }],
    "2026-10-27T21:20:00.000Z",
  );
  assert.equal(ok, false);
  assert.equal(fs.existsSync(scheduleDbPath("202705")), false);
});

test("snapshotDate is the slice's own refresh time for a query inside it, the file's otherwise", () => {
  writeScheduleSlice(
    TERM,
    { subject: "GC", complete: true },
    [sec("16071", "GC3450", "TR", "1400", "1515")],
    "2026-10-27T21:20:00.000Z",
  );
  const gc = querySectionsEngine({ term: TERM, subject: "GC" });
  const math = querySectionsEngine({ term: TERM, subject: "MATH" });
  assert.ok(!("error" in gc) && !("error" in math));
  assert.match((gc as { snapshotDate: string }).snapshotDate, /T17:20/); // 21:20Z, Eastern
  assert.match((math as { snapshotDate: string }).snapshotDate, /T05:01/);
});

// --- through search-classes --------------------------------------------------

function liveOf(sections: Section[]) {
  return async (p: { offset?: number }): Promise<ClemsonSearchResult> => {
    const off = p.offset ?? 0;
    return {
      totalCount: sections.length,
      sections: sections.slice(off, off + 50),
      snapshotDate: null,
      scope: "live",
    };
  };
}
const json = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0].text);

test("search-classes: after a refresh, the snapshot answer shows the refreshed time", async () => {
  const tool = makeSearchClasses({
    searchLive: liveOf([sec("16071", "GC3450", "TR", "1400", "1515")]),
  });
  await tool.handler({
    term: "Spring 2027",
    subject: "GC",
    course_number: "3450",
    refresh: true,
  });
  const body = json(
    await tool.handler({
      term: "Spring 2027",
      subject: "GC",
      course_number: "3450",
    }),
  );
  assert.equal(body.sections[0].meetings[0].start, "1400");
});

test("search-classes: open_seats_only refresh deletes nothing", async () => {
  const tool = makeSearchClasses({
    searchLive: liveOf([sec("16071", "GC3450", "TR", "1400", "1515")]),
  });
  await tool.handler({
    term: "Spring 2027",
    subject: "GC",
    open_seats_only: true,
    refresh: true,
  });
  assert.deepEqual(crnsOf(), ["100", "16071", "300"]);
});

test("search-classes: a filtered refresh writes the whole fetched subject, not just the filtered rows", async () => {
  const tool = makeSearchClasses({
    searchLive: liveOf([
      sec("100", "GC1010", "MW", "0900", "0950"),
      sec("16071", "GC3450", "TR", "1400", "1515"),
    ]),
  });
  await tool.handler({
    term: "Spring 2027",
    subject: "GC",
    building_room: "Godfrey 999",
    refresh: true,
  });
  assert.deepEqual(crnsOf(), ["100", "16071", "300"]);
  assert.deepEqual(meetingsOf("16071"), ["R840", "T840"]);
});

// --- hostile review 2026-10-27 -------------------------------------------------
// C1: an in-place write killed mid-transaction left a hot -journal beside the
// live file: readers failed, and the next nightly file was silently rolled
// back. The live file must only ever be replaced by rename.

test("the live file is replaced by rename, never written in place", () => {
  const p = scheduleDbPath(TERM);
  const before = fs.statSync(p).ino;
  assert.ok(
    writeScheduleSlice(
      TERM,
      { subject: "GC", complete: true },
      [sec("16071", "GC3450", "TR", "1400", "1515")],
      "2026-10-27T21:20:00.000Z",
    ),
  );
  assert.notEqual(fs.statSync(p).ino, before);
  for (const ext of ["-journal", "-wal", "-shm"])
    assert.equal(fs.existsSync(p + ext), false, ext);
});

test("leftovers of a crashed earlier write are cleared, never replayed", () => {
  const p = scheduleDbPath(TERM);
  for (const f of fs.readdirSync(path.dirname(p)))
    if (f.startsWith(`${TERM}.db.`)) fs.rmSync(path.join(path.dirname(p), f));
  const tmp = `${p}.slice-tmp`;
  fs.writeFileSync(tmp, "junk from a killed write");
  fs.writeFileSync(`${tmp}-journal`, "junk journal");
  assert.ok(
    writeScheduleSlice(
      TERM,
      { subject: "GC", complete: true },
      [sec("16071", "GC3450", "TR", "1400", "1515")],
      "2026-10-27T21:20:00.000Z",
    ),
  );
  assert.deepEqual(crnsOf(), ["16071", "300"]);
  assert.equal(fs.existsSync(tmp), false);
  assert.equal(fs.existsSync(`${tmp}-journal`), false);
});

// I2: pages from separate Banner sessions can repeat one row and skip another
// while the row count still reaches totalCount.

test("search-classes: a repeated row across pages neither deletes the skipped section nor doubles meetings", async () => {
  const A = sec("100", "GC1010", "MW", "0900", "0950");
  const B = sec("16071", "GC3450", "TR", "1400", "1515");
  const pages = [[A, B], [B]];
  let call = 0;
  const tool = makeSearchClasses({
    searchLive: async (): Promise<ClemsonSearchResult> => ({
      totalCount: 3,
      sections: pages[call++] ?? [],
      snapshotDate: null,
      scope: "live",
    }),
  });
  const body = json(
    await tool.handler({ term: "Spring 2027", subject: "GC", refresh: true }),
  );
  assert.deepEqual(body.sections.map((s: { crn: string }) => s.crn).sort(), [
    "100",
    "16071",
  ]);
  assert.deepEqual(crnsOf(), ["100", "16071", "300"]); // nothing deleted
  assert.deepEqual(meetingsOf("16071"), ["R840", "T840"]); // updated, not doubled
});

test("a duplicate CRN in one write does not double its meetings", () => {
  const B = sec("16071", "GC3450", "TR", "1400", "1515");
  assert.ok(
    writeScheduleSlice(
      TERM,
      { subject: "GC", complete: false },
      [B, B],
      "2026-10-27T21:20:00.000Z",
    ),
  );
  assert.deepEqual(meetingsOf("16071"), ["R840", "T840"]);
});

// Guards the review's mutations showed were untested.

test("a complete GC write leaves a GCX subject alone", () => {
  assert.ok(
    writeScheduleSlice(
      TERM,
      { subject: "GCX", complete: true },
      [sec("500", "GCX1000", "F", "0800", "0850")],
      "2026-10-27T21:20:00.000Z",
    ),
  );
  assert.ok(
    writeScheduleSlice(
      TERM,
      { subject: "GC", complete: true },
      [sec("16071", "GC3450", "TR", "1400", "1515")],
      "2026-10-27T21:21:00.000Z",
    ),
  );
  assert.deepEqual(crnsOf(), ["16071", "300", "500"]);
});

test("a section from another term is refused", () => {
  const ok = writeScheduleSlice(
    TERM,
    { subject: "GC", complete: true },
    [{ ...sec("16071", "GC3450", "TR", "1400", "1515"), term: "202608" }],
    "2026-10-27T21:20:00.000Z",
  );
  assert.equal(ok, false);
  assert.deepEqual(meetingsOf("16071"), ["R930", "T930"]);
});

test("an archived snapshot without part_of_term is refused", () => {
  const db = new Database(scheduleDbPath(TERM));
  db.exec("ALTER TABLE sections DROP COLUMN part_of_term");
  db.close();
  const ok = writeScheduleSlice(
    TERM,
    { subject: "GC", complete: true },
    [sec("16071", "GC3450", "TR", "1400", "1515")],
    "2026-10-27T21:20:00.000Z",
  );
  assert.equal(ok, false);
  assert.deepEqual(crnsOf(), ["100", "16071", "300"]);
});

test("a lowercase course letter still writes back (1990h is GC1990H)", () => {
  assert.ok(
    writeScheduleSlice(
      TERM,
      { subject: "gc", courseNumber: "1990h", complete: true },
      [sec("700", "GC1990H", "F", "0800", "0850")],
      "2026-10-27T21:20:00.000Z",
    ),
  );
  assert.deepEqual(crnsOf(), ["100", "16071", "300", "700"]);
});

test("search-classes: a course-number-only refresh answers and writes nothing", async () => {
  let wrote = false;
  const tool = makeSearchClasses({
    searchLive: liveOf([sec("16071", "GC3450", "TR", "1400", "1515")]),
    writeBack: () => {
      wrote = true;
      return true;
    },
  });
  const body = json(
    await tool.handler({
      term: "Spring 2027",
      course_number: "3450",
      refresh: true,
    }),
  );
  assert.equal(body.totalCount, 1);
  assert.equal(wrote, false);
});

test("search-classes: a throwing write-back never fails the search", async () => {
  const tool = makeSearchClasses({
    searchLive: liveOf([sec("16071", "GC3450", "TR", "1400", "1515")]),
    writeBack: () => {
      throw new Error("boom");
    },
  });
  const body = json(
    await tool.handler({ term: "Spring 2027", subject: "GC", refresh: true }),
  );
  assert.equal(body.totalCount, 1);
});

test("search-classes: after a refresh, the snapshot answer carries the refresh time", async () => {
  const tool = makeSearchClasses({
    searchLive: liveOf([
      sec("100", "GC1010", "MW", "0900", "0950"),
      sec("16071", "GC3450", "TR", "1400", "1515"),
    ]),
  });
  await tool.handler({ term: "Spring 2027", subject: "GC", refresh: true });
  const body = json(await tool.handler({ term: "Spring 2027", subject: "GC" }));
  assert.doesNotMatch(body.snapshotDate, /T05:01/);
});

test("a GC write carrying a GCX section is refused (the digit after the subject)", () => {
  const ok = writeScheduleSlice(
    TERM,
    { subject: "GC", complete: true },
    [
      sec("16071", "GC3450", "TR", "1400", "1515"),
      sec("500", "GCX1000", "F", "0800", "0850"),
    ],
    "2026-10-27T21:20:00.000Z",
  );
  assert.equal(ok, false);
  assert.deepEqual(crnsOf(), ["100", "16071", "300"]);
});

test("a REAL hot journal left by a killed write is cleared, not replayed into the new copy", async () => {
  const { spawnSync } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const p = scheduleDbPath(TERM);
  const tmp = `${p}.slice-tmp`;
  // A killed writer: a different database at the copy's path, a big change
  // spilled to disk under a one-page cache, then SIGKILL mid-transaction.
  const bsql = createRequire(import.meta.url).resolve("better-sqlite3");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const D=require(${JSON.stringify(bsql)});const db=new D(${JSON.stringify(tmp)});
       db.exec("CREATE TABLE junk(x TEXT)");
       db.pragma("cache_size=1");
       db.exec("BEGIN");
       for(let i=0;i<3000;i++)db.prepare("INSERT INTO junk VALUES (?)").run("x".repeat(500));
       process.kill(process.pid,"SIGKILL");`,
    ],
    { stdio: "ignore" },
  );
  assert.equal(child.signal, "SIGKILL");
  assert.ok(fs.existsSync(`${tmp}-journal`), "the kill left a hot journal");
  assert.ok(
    writeScheduleSlice(
      TERM,
      { subject: "GC", complete: true },
      [sec("16071", "GC3450", "TR", "1400", "1515")],
      "2026-10-27T21:20:00.000Z",
    ),
  );
  assert.deepEqual(crnsOf(), ["16071", "300"]);
  assert.deepEqual(meetingsOf("16071"), ["R840", "T840"]);
  const db = new Database(p, { readonly: true });
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  db.close();
});
