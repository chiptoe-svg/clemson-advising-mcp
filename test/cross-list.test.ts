// Cross-listed sections (Chip, 2026-10-30). Banner labels a cross-listing with
// a group code (crossList: "GC3"); the snapshot used to drop it. Sections in
// one group are one class. So is an UNLABELED 4xxx/6xxx pair of one subject
// that one instructor teaches at the same times (GC 4900 006 + GC 6900 002):
// counted as one, and reported so the label gets fixed in Banner. Any other
// overlap is a double booking, never merged.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "cross-list-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { mapSection } = await import("../src/clemson-classes.ts");
const {
  writeScheduleDb,
  writeScheduleSlice,
  scheduleDbPath,
  snapshotHasColumn,
  backfillBannerFields,
  crossListRecorded,
} = await import("../src/clemson-schedule-db.ts");
const { sameClass, isUnlabeledGradPair } = await import("../src/cross-list.ts");

function section(crn: string, course: string, crossList: string | null) {
  return {
    term: "202601",
    termDescription: "Spring 2026",
    crn,
    subjectCourse: course,
    section: "001",
    title: `${course} title`,
    campus: "C",
    scheduleType: "Lecture",
    instructionalMethod: "F",
    partOfTerm: "1",
    crossList,
    creditHours: 3,
    enrollment: 5,
    maxEnrollment: 20,
    seatsAvailable: 15,
    waitCount: 0,
    waitCapacity: 0,
    open: true,
    meetings: [],
    instructors: [],
  };
}

test("mapSection keeps Banner's crossList code; empty or missing is null", () => {
  const base = { courseReferenceNumber: "1", subjectCourse: "GC1040" };
  assert.equal(mapSection({ ...base, crossList: "GC3" }).crossList, "GC3");
  assert.equal(mapSection({ ...base, crossList: null }).crossList, null);
  assert.equal(mapSection({ ...base, crossList: "" }).crossList, null);
  assert.equal(mapSection(base).crossList, null);
});

test("a full snapshot write records cross_list", () => {
  writeScheduleDb({
    term: "202601",
    termDescription: "Spring 2026",
    fetchedAt: "2026-01-10T00:00:00Z",
    sectionCount: 2,
    sections: [section("1", "GC1040", "GC3"), section("2", "GC3500", null)],
  });
  const db = new Database(scheduleDbPath("202601"), { readonly: true });
  assert.ok(snapshotHasColumn(db, "cross_list"));
  assert.ok(crossListRecorded(db));
  assert.deepEqual(
    db.prepare("SELECT crn, cross_list FROM sections ORDER BY crn").all(),
    [
      { crn: "1", cross_list: "GC3" },
      { crn: "2", cross_list: null },
    ],
  );
  db.close();
});

test("a snapshot rebuilt from an archive without labels does not claim them", () => {
  const { crossList: _drop, ...noLabel } = section("1", "GC1040", null);
  writeScheduleDb({
    term: "202408",
    termDescription: "Fall 2024",
    fetchedAt: "2024-08-10T00:00:00Z",
    sectionCount: 1,
    sections: [noLabel],
  });
  const db = new Database(scheduleDbPath("202408"), { readonly: true });
  assert.equal(crossListRecorded(db), false);
  db.close();
});

/** A snapshot as written before cross_list existed. */
function oldSnapshot(term: string) {
  const p = scheduleDbPath(term);
  fs.rmSync(p, { force: true });
  const db = new Database(p);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('fetched_at', '2026-01-10T00:00:00Z');
    CREATE TABLE sections (crn TEXT NOT NULL, term TEXT NOT NULL,
      subject_course TEXT NOT NULL, section TEXT NOT NULL, title TEXT NOT NULL,
      campus TEXT, schedule_type TEXT, instructional_method TEXT,
      part_of_term TEXT, credit_hours REAL,
      enrollment INTEGER NOT NULL DEFAULT 0,
      max_enrollment INTEGER NOT NULL DEFAULT 0,
      seats_available INTEGER NOT NULL DEFAULT 0,
      wait_count INTEGER NOT NULL DEFAULT 0,
      wait_capacity INTEGER NOT NULL DEFAULT 0,
      open INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (crn, term));
    CREATE TABLE meetings (id INTEGER PRIMARY KEY AUTOINCREMENT,
      crn TEXT NOT NULL, term TEXT NOT NULL, day TEXT NOT NULL,
      start_min INTEGER, end_min INTEGER, building TEXT, room TEXT, type TEXT);
    CREATE TABLE instructors (crn TEXT NOT NULL, term TEXT NOT NULL,
      name TEXT NOT NULL, email TEXT, primary_i INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (crn, term, name));
    INSERT INTO sections (crn, term, subject_course, section, title,
      part_of_term, credit_hours, enrollment)
      VALUES ('1', '${term}', 'GC1040', '001', 'Old', '1', 4, 33),
             ('2', '${term}', 'GC1040', '002', 'Old', '1', 1, 2),
             ('3', '${term}', 'MATH1060', '001', 'Old', '1', 4, 40);
  `);
  db.close();
}

test("a slice write-back into a pre-cross_list snapshot adds the column", () => {
  oldSnapshot("202605");
  const ok = writeScheduleSlice(
    "202605",
    { subject: "GC", complete: true },
    [{ ...section("1", "GC1040", "GC3"), term: "202605" }],
    "2026-05-01T00:00:00Z",
  );
  assert.equal(ok, true);
  const db = new Database(scheduleDbPath("202605"), { readonly: true });
  assert.equal(
    (
      db.prepare("SELECT cross_list FROM sections WHERE crn='1'").get() as {
        cross_list: string;
      }
    ).cross_list,
    "GC3",
  );
  // Older rows are null because nobody asked Banner, not because they aren't
  // cross-listed: the snapshot must not claim its labels are complete.
  assert.equal(crossListRecorded(db), false);
  db.close();
});

test("backfill sets labels and corrects credits; every other value stays as recorded", () => {
  oldSnapshot("202508");
  const r = backfillBannerFields(
    "202508",
    new Map([
      ["1", { crossList: "GC3", creditHours: 4 }],
      // Stored at a course minimum before 3e8c25a; Banner's section value is 3.
      ["2", { crossList: "GC3", creditHours: 3 }],
      ["3", { crossList: null, creditHours: 4 }],
      ["999", { crossList: "ZZ1", creditHours: 3 }], // not in the snapshot
    ]),
  );
  assert.deepEqual(r, {
    ok: true,
    labeled: 2,
    creditsChanged: 1,
    unknownCrns: 1,
    missingFromFetch: 0,
    recorded: true,
  });
  const db = new Database(scheduleDbPath("202508"), { readonly: true });
  assert.deepEqual(
    db
      .prepare(
        "SELECT crn, title, enrollment, credit_hours, cross_list FROM sections ORDER BY crn",
      )
      .all(),
    [
      {
        crn: "1",
        title: "Old",
        enrollment: 33,
        credit_hours: 4,
        cross_list: "GC3",
      },
      {
        crn: "2",
        title: "Old",
        enrollment: 2,
        credit_hours: 3,
        cross_list: "GC3",
      },
      {
        crn: "3",
        title: "Old",
        enrollment: 40,
        credit_hours: 4,
        cross_list: null,
      },
    ],
  );
  assert.ok(crossListRecorded(db));
  db.close();
});

test("backfill refuses a term with no snapshot rather than creating one", () => {
  const r = backfillBannerFields(
    "203001",
    new Map([["1", { crossList: "GC3", creditHours: 3 }]]),
  );
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(scheduleDbPath("203001")), false);
});

const F = "F 1010-1310";
const k = (
  course: string,
  crossList: string | null,
  slots = F,
  instructors = ["kim@clemson.edu"],
) => ({ course, crossList, slots, instructors });

test("same Banner label: one class, whatever the times", () => {
  assert.ok(sameClass(k("GC 1990", "GC1"), k("GC 2990", "GC1", "F 1010-1320")));
  assert.ok(!sameClass(k("GC 1990", "GC1"), k("GC 1990", "WAG")));
});

test("an unlabeled 4xxx/6xxx pair, same subject, instructor and times: one class", () => {
  assert.ok(sameClass(k("GC 4900", null), k("GC 6900", null)));
  assert.ok(sameClass(k("GC6900", null), k("GC4900", null)));
  assert.ok(isUnlabeledGradPair(k("GC 4900", null), k("GC 6900", null)));
});

test("not a pair: different times, instructor, subject, number or level", () => {
  assert.ok(!sameClass(k("GC 4900", null), k("GC 6900", null, "F 1010-1300")));
  assert.ok(
    !sameClass(k("GC 4900", null), k("GC 6900", null, F, ["lee@clemson.edu"])),
  );
  assert.ok(!sameClass(k("GC 4900", null), k("PKSC 6900", null)));
  assert.ok(!sameClass(k("GC 4900", null), k("GC 6910", null)));
  assert.ok(!sameClass(k("GC 3780", null), k("GC 3790", null)));
  assert.ok(!sameClass(k("GC 4900", null, ""), k("GC 6900", null, ""))); // untimed
});

test("a labeled pair is not reported as unlabeled", () => {
  assert.ok(!isUnlabeledGradPair(k("GC 4900", "GC2"), k("GC 6900", "GC2")));
  assert.ok(sameClass(k("GC 4900", "GC2"), k("GC 6900", "GC2")));
});

test("sections in DIFFERENT Banner groups are not an unlabeled pair", () => {
  assert.ok(!isUnlabeledGradPair(k("GC 4400", "GC3"), k("GC 6400", "GC7")));
  assert.ok(!sameClass(k("GC 4400", "GC3"), k("GC 6400", "GC7")));
  // One labeled, one not: not an "unlabeled pair" either.
  assert.ok(!isUnlabeledGradPair(k("GC 4400", "GC3"), k("GC 6400", null)));
});

test("a fetch that misses snapshot sections fills what it has but claims no labels", () => {
  oldSnapshot("202405");
  const r = backfillBannerFields(
    "202405",
    new Map([["1", { crossList: "GC3", creditHours: 4 }]]),
  );
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.missingFromFetch, 2);
  assert.equal(r.ok && r.recorded, false);
  const db = new Database(scheduleDbPath("202405"), { readonly: true });
  assert.equal(crossListRecorded(db), false);
  db.close();
});

test("fetchBackfillFields refuses a scan that stopped short of Banner's total", async () => {
  const { fetchBackfillFields } = await import("../src/clemson-classes.ts");
  const real = globalThis.fetch;
  let page = 0;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.includes("searchResults/searchResults")) {
      const body =
        page++ === 0
          ? {
              totalCount: 1000,
              data: Array.from({ length: 500 }, (_, i) => ({
                courseReferenceNumber: String(i),
                subjectCourse: "GC1010",
              })),
            }
          : { success: false, totalCount: 0, data: null };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await fetchBackfillFields("202601", 0), null);
  } finally {
    globalThis.fetch = real;
  }
});
