// find-alternatives answers "which COURSES can be added to this schedule",
// not "which sections don't collide" (Cob_advisor for Chip, 2026-11-04).
// With subject PKSC and eight kept CRNs it reported 22 fitting sections; the
// answer is two courses: PKSC 2010 and PKSC 4990 (arranged). A lecture and its
// required lab are one unit that fits only when a section of each fits; a lab
// is never reported alone; graduate courses are hidden unless asked; zero-
// capacity placeholder sections are skipped; and the summary states the count.
// Fixture: the real Spring 2027 meetings for the kept CRNs and PKSC sections.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { catalogFixtureDdl } from "./_catalog-fixture-ddl.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "advising-mcp-alt-coreq-"));
process.env.STATE_DIR = TMP;
process.env.CATALOG_DB = path.join(TMP, "catalog.db");

{
  const cat = new Database(process.env.CATALOG_DB);
  cat.exec(catalogFixtureDdl("course"));
  const add = cat.prepare(
    "INSERT INTO course (code, subject, number, title, credits, coreq_parsed) VALUES (?,?,?,?,?,?)",
  );
  const c = (
    code: string,
    title: string,
    credits: string,
    coreqs: string[] = [],
  ) => {
    const [s, n] = code.split(" ");
    add.run(
      code,
      s,
      n,
      title,
      credits,
      coreqs.length ? JSON.stringify(coreqs) : null,
    );
  };
  c("PKSC 2010", "Packaging Fundamentals", "3");
  c("PKSC 2200", "Packaging Materials", "4", ["PKSC 2201"]);
  c("PKSC 2201", "Packaging Materials Laboratory", "0", ["PKSC 2200"]);
  c("PKSC 4200", "Distribution Packaging", "3", ["PKSC 4201"]);
  c("PKSC 4201", "Distribution Packaging Laboratory", "0", ["PKSC 4200"]);
  c("PKSC 4220", "Packaging Seminar", "2");
  c("PKSC 4300", "Package Design", "4", ["PKSC 4301"]);
  c("PKSC 4301", "Package Design Laboratory", "0", ["PKSC 4300"]);
  c("PKSC 4960", "Creative Inquiry", "3", ["PKSC 4961"]);
  c("PKSC 4961", "Creative Inquiry Laboratory", "0", ["PKSC 4960"]);
  c("PKSC 4990", "Selected Topics", "1-3");
  c("PKSC 6300", "Package Design", "4", ["PKSC 6301"]);
  c("PKSC 6301", "Package Design Laboratory", "0", ["PKSC 6300"]);
  c("PKSC 8910", "Master's Thesis Research", "1-9");
  // Two halves that each clear the keepers but clash with each other.
  c("PKSC 3200", "Package Printing", "3", ["PKSC 3201"]);
  c("PKSC 3201", "Package Printing Laboratory", "0", ["PKSC 3200"]);
  cat.close();
}

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { findAlternatives } = await import("../src/mcp-tools/core-search.ts");
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClemsonTermSnapshot } from "../src/clemson-classes.ts";

const TERM = "202701";
type Section = ClemsonTermSnapshot["sections"][number];

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}`;

/** meetings as "M610-660 W610-660" (minutes), the snapshot's own notation. */
function section(
  crn: string,
  subjectCourse: string,
  sec: string,
  meetings: string,
  cap = 30,
  credit: number | null = 3,
): Section {
  return {
    term: TERM,
    termDescription: "Spring 2027",
    crn,
    subjectCourse,
    section: sec,
    title: subjectCourse,
    campus: "Main",
    scheduleType: "Lecture",
    instructionalMethod: null,
    partOfTerm: "1",
    creditHours: credit,
    enrollment: 0,
    maxEnrollment: cap,
    seatsAvailable: cap,
    waitCount: 0,
    waitCapacity: 0,
    open: cap > 0,
    instructors: [],
    meetings: meetings
      .split(" ")
      .filter(Boolean)
      .map((m) => {
        const [, day, a, b] = /^([MTWRFSU])(\d+)-(\d+)$/.exec(m)!;
        return {
          days: day!,
          beginTime: hhmm(Number(a)),
          endTime: hhmm(Number(b)),
          building: "Hall",
          room: "1",
          roomCapacity: null,
          startDate: null,
          endDate: null,
          type: "Class",
        };
      }),
  };
}

const KEPT = [
  "12325",
  "12328",
  "14843",
  "12402",
  "12406",
  "12416",
  "12337",
  "12338",
];
const sections = [
  section("12325", "GC3400", "001", "M610-660 W610-660"),
  section("12328", "GC3401", "001", "M675-840 W675-840"),
  section("12337", "GC4440", "001", "T570-620 R570-620"),
  section("12338", "GC4441", "001", "T840-1005 R840-1005"),
  section("12402", "GC4480", "001", "M545-595 W545-595"),
  section("12406", "GC4481", "001", "M870-945"),
  section("12416", "GC4800", "001", "W960-1035"),
  section("14843", "ENSP2000", "001", "T660-735 R660-735"),
  section("14635", "PKSC2010", "001", "T750-825 R750-825", 34),
  section("11407", "PKSC2200", "400", "", 24, 4),
  section("11411", "PKSC2201", "001", "M480-660 W480-660", 24, 0),
  section("11708", "PKSC4200", "001", "M675-725 W675-725", 32),
  section("11749", "PKSC4201", "001", "F805-975", 32, 0),
  section("19735", "PKSC4220", "001", "M545-595 W545-595", 15, 2),
  section("12928", "PKSC4220", "002", "", 0, null),
  section("15810", "PKSC4220", "004", "M480-1200 W480-1200 F480-1200", 0, null),
  section("11782", "PKSC4300", "001", "T750-825 R750-825", 35, 4),
  section("11785", "PKSC4301", "001", "T840-1019", 18, 0),
  section("11787", "PKSC4301", "002", "R840-1019", 0, 0),
  section("21923", "PKSC4301", "003", "W805-985", 17, 0),
  section("15504", "PKSC4960", "001", "", 0, 3),
  section("15505", "PKSC4961", "001", "", 0, 0),
  section("18663", "PKSC4990", "001", "", 10, null),
  section("18003", "PKSC4990", "002", "", 5, 1),
  section("11784", "PKSC6300", "001", "T750-825 R750-825", 3, 4),
  section("14668", "PKSC6301", "001", "T840-1019", 3, 0),
  section("11918", "PKSC8910", "001", "", 5, null),
  // Graduate courses the (undergraduate) catalog lacks: the lab pairing is
  // read from the schedule.
  {
    ...section("40001", "PKSC7300", "001", "T750-825 R750-825", 5, 4),
    title: "Flexible Packaging",
  },
  {
    ...section("40002", "PKSC7301", "001", "M480-560", 5, 0),
    title: "Flexible Packaging Laboratory",
  },
  section("30001", "PKSC3200", "001", "F600-700", 24),
  section("30002", "PKSC3201", "001", "F630-730", 24, 0),
];
writeScheduleDb({
  term: TERM,
  termDescription: "Spring 2027",
  fetchedAt: "2026-11-04T05:00:00.000Z",
  sectionCount: sections.length,
  sections,
});

function json(res: CallToolResult) {
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  return JSON.parse((res.content[0] as { text: string }).text);
}
type Unit = {
  course: string;
  with?: string[];
  requested_as?: string[];
  fits: boolean;
  how?: string;
  reason?: string;
  options?: { crns: string[] }[];
  options_count?: number;
};
const unit = (body: { courses: Unit[] }, code: string) =>
  body.courses.find((u) => u.course === code);

const pksc = async (extra: Record<string, unknown> = {}) =>
  json(
    await findAlternatives.handler({
      term: TERM,
      subject: "PKSC",
      current_crns: KEPT,
      ...extra,
    }),
  );

test("Cob's case: exactly two courses can be added, and the summary says so", async () => {
  const body = await pksc();
  assert.deepEqual(body.summary.can_add, ["PKSC 2010", "PKSC 4990"]);
  assert.equal(body.summary.can_add_count, 2);
  assert.deepEqual(body.summary.arranged, ["PKSC 4990"]);
  assert.match(
    body.summary.text,
    /^2 courses can be added: PKSC 2010, PKSC 4990/,
  );
  // The flat section list and its count are gone: nothing to overstate.
  assert.equal(body.sections, undefined);
  assert.equal(body.totalCount, undefined);
});

test("a lecture fits only with a fitting section of its required lab", async () => {
  const body = await pksc();
  const u4300 = unit(body, "PKSC 4300")!;
  assert.equal(u4300.fits, false);
  assert.deepEqual(u4300.with, ["PKSC 4301"]);
  assert.match(u4300.reason!, /PKSC 4301/);
  const u2200 = unit(body, "PKSC 2200")!;
  assert.equal(
    u2200.fits,
    false,
    "an arranged lecture with a timed lab that clashes",
  );
  assert.match(u2200.reason!, /PKSC 2201/);
  const u4200 = unit(body, "PKSC 4200")!;
  assert.equal(u4200.fits, false);
  assert.match(u4200.reason!, /PKSC 4200.*12328/);
});

test("a lab is never a unit of its own", async () => {
  const body = await pksc();
  for (const lab of ["PKSC 2201", "PKSC 4201", "PKSC 4301", "PKSC 4961"])
    assert.equal(unit(body, lab), undefined, lab);
});

test("halves that each fit but clash with each other do not fit", async () => {
  const u = unit(await pksc(), "PKSC 3200")!;
  assert.equal(u.fits, false);
  assert.match(u.reason!, /each other/);
});

test("graduate courses are hidden unless asked, and counted", async () => {
  const body = await pksc();
  assert.equal(unit(body, "PKSC 6300"), undefined);
  assert.equal(unit(body, "PKSC 8910"), undefined);
  assert.deepEqual(body.summary.excluded.graduate, [
    "PKSC 6300",
    "PKSC 7300",
    "PKSC 8910",
  ]);
  const all = await pksc({ include_graduate: true });
  assert.equal(unit(all, "PKSC 6300")!.fits, false);
  assert.deepEqual(all.summary.can_add, [
    "PKSC 2010",
    "PKSC 4990",
    "PKSC 8910",
  ]);
});

test("zero-capacity placeholder sections are skipped; a course of only those is excluded", async () => {
  const body = await pksc();
  assert.equal(unit(body, "PKSC 4960"), undefined);
  assert.deepEqual(body.summary.excluded.placeholders_only, ["PKSC 4960"]);
  // 4220's real section clashes; its placeholders don't rescue it.
  assert.equal(unit(body, "PKSC 4220")!.fits, false);
});

test("courses mode: a listed lab answers as its lecture; a fitting pair names both CRNs", async () => {
  const lab = json(
    await findAlternatives.handler({
      term: TERM,
      courses: ["PKSC 4301"],
      current_crns: KEPT,
    }),
  );
  assert.equal(lab.courses.length, 1);
  assert.equal(lab.courses[0].course, "PKSC 4300");
  assert.deepEqual(lab.courses[0].requested_as, ["PKSC 4301"]);
  assert.equal(lab.courses[0].fits, false);
  assert.deepEqual(lab.summary.do_not_fit, ["PKSC 4300"]);
  // Keeping only the GC 3400 lecture, 4300 + its 001 or 003 lab both fit.
  const pair = json(
    await findAlternatives.handler({
      term: TERM,
      courses: ["PKSC 4300", "PKSC 6300"],
      current_crns: ["12325"],
    }),
  );
  const u = pair.courses[0] as Unit;
  assert.equal(u.fits, true);
  assert.deepEqual(
    u.options!.map((o) => o.crns),
    [
      ["11782", "11785"],
      ["11782", "21923"],
    ],
  );
  // A listed graduate course is never hidden.
  assert.equal(pair.courses[1].course, "PKSC 6300");
  assert.equal(pair.summary.can_add_count, 2);
});

test("without subject, courses or replacing_crn, the term is too wide to judge", async () => {
  const res = await findAlternatives.handler({
    term: TERM,
    current_crns: KEPT,
  });
  assert.equal(res.isError, true);
  const text = (res.content[0] as { text: string }).text;
  // The error is the redirect a model acts on: it names all three and when.
  assert.match(text, /subject.*fits around/);
  assert.match(text, /courses.*which of these/);
  assert.match(text, /replacing_crn.*swap/);
});

test("a lab the catalog lacks is still paired with its lecture, and the entry says it was inferred", async () => {
  const body = await pksc({ include_graduate: true });
  assert.equal(unit(body, "PKSC 7301"), undefined);
  const u = unit(body, "PKSC 7300")!;
  assert.deepEqual(u.with, ["PKSC 7301"]);
  assert.equal(u.fits, false); // the lab's Monday 8:00 clashes with kept 12402
  assert.match(u.reason!, /PKSC 7301.*12402/);
  assert.match(
    (u as { pairing_note?: string }).pairing_note ?? "",
    /read from the schedule/,
  );
  assert.equal(unit(await pksc(), "PKSC 7301"), undefined);
});
