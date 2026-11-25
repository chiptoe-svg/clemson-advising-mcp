// find-alternatives with the student's courses (Cob_advisor T10g,
// 2026-11-25): 0/8 trials got it right because the tool took no completed
// courses, so every course that fit was offered — GC 3730 without GC 3700,
// GC 3450 to a student only ENROLLED in GC 3400. With completed_courses each
// course carries a three-valued verdict, and a course the student cannot take
// leaves the can-add list for summary.not_eligible.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { catalogFixtureDdl } from "./_catalog-fixture-ddl.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "advising-mcp-alt-elig-"));
process.env.STATE_DIR = TMP;
process.env.CATALOG_DB = path.join(TMP, "catalog.db");
{
  const cat = new Database(process.env.CATALOG_DB);
  cat.exec(catalogFixtureDdl("course"));
  const add = cat.prepare(
    "INSERT INTO course (code, subject, number, title, credits, prereq_text, prereq_parsed) VALUES (?,?,?,?,?,?,?)",
  );
  const c = (
    code: string,
    title: string,
    pre: string | null,
    codes: string[] = [],
  ) => {
    const [s, n] = code.split(" ");
    add.run(
      code,
      s,
      n,
      title,
      "3",
      pre,
      codes.length ? JSON.stringify(codes) : null,
    );
  };
  c("GC 3400", "Flexography", "GC 1020 and GC 1040", ["GC 1020", "GC 1040"]);
  c("GC 3450", "Advanced Flexography", "GC 3400", ["GC 3400"]);
  c("GC 3460", "Digital Imaging", "GC 2070", ["GC 2070"]);
  c("GC 3730", "Advanced Design", "GC 3700", ["GC 3700"]);
  c("GC 3700", "Design", "Sophomore standing");
  cat.close();
}

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { findAlternatives } = await import("../src/mcp-tools/core-search.ts");
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClemsonTermSnapshot } from "../src/clemson-classes.ts";

const TERM = "202608";
type Section = ClemsonTermSnapshot["sections"][number];
function sec(
  crn: string,
  subjectCourse: string,
  days: string,
  begin: string,
  end: string,
): Section {
  return {
    term: TERM,
    termDescription: "Fall 2026",
    crn,
    subjectCourse,
    section: "001",
    title: subjectCourse,
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
    instructors: [],
    meetings: [
      {
        days,
        beginTime: begin,
        endTime: end,
        building: "Godfrey Hall",
        room: "101",
        roomCapacity: null,
        startDate: null,
        endDate: null,
        type: "Class",
      },
    ],
  };
}
const KEPT = "80822"; // GC 3400, MW 0800
const sections = [
  sec(KEPT, "GC3400", "MW", "0800", "0915"),
  sec("85064", "GC3460", "TR", "0800", "0915"), // being dropped below
  sec("90001", "GC3450", "TR", "1100", "1215"),
  sec("90002", "GC3460", "MW", "1300", "1415"),
  sec("90003", "GC3730", "TR", "1400", "1515"),
  sec("90004", "GC3700", "F", "0900", "1150"),
  sec("90005", "GC4999", "F", "1300", "1350"), // no catalog row
];
writeScheduleDb({
  term: TERM,
  termDescription: "Fall 2026",
  fetchedAt: "2026-11-25T05:00:00.000Z",
  sectionCount: sections.length,
  sections,
});

function json(res: CallToolResult) {
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  return JSON.parse((res.content[0] as { text: string }).text);
}
const alt = async (args: Record<string, unknown>) =>
  json(
    await findAlternatives.handler({
      term: TERM,
      current_crns: [KEPT, "85064"],
      replacing_crn: "85064",
      subject: "GC",
      credits: 3,
      ...args,
    }),
  );
const unit = (b: any, code: string) =>
  b.courses.find((u: any) => u.course === code);
const T10G = ["GC 1010", "GC 1020", "GC 1040", "GC 1050", "GC 2070"];

test("T10g: GC 3730 and GC 3450 are not eligible, GC 3460 is", async () => {
  const b = await alt({ completed_courses: T10G });
  assert.equal(unit(b, "GC 3730").prereq_eligibility, "not_eligible");
  assert.deepEqual(unit(b, "GC 3730").missing, ["GC 3700"]);
  assert.equal(unit(b, "GC 3450").prereq_eligibility, "not_eligible");
  assert.deepEqual(unit(b, "GC 3450").missing, ["GC 3400"]);
  assert.equal(unit(b, "GC 3460").prereq_eligibility, "eligible");
});

test("not-eligible courses leave can_add, and the text says how many", async () => {
  const b = await alt({ completed_courses: T10G });
  assert.ok(b.summary.can_add.includes("GC 3460"));
  assert.ok(!b.summary.can_add.includes("GC 3730"));
  assert.ok(!b.summary.can_add.includes("GC 3450"));
  assert.deepEqual(b.summary.fit, b.summary.can_add);
  assert.deepEqual(b.summary.not_eligible, [
    { course: "GC 3450", missing: ["GC 3400"] },
    { course: "GC 3730", missing: ["GC 3700"] },
  ]);
  assert.match(
    b.summary.text,
    /2 more fit but need prerequisites the student lacks/,
  );
});

test("undetermined stays in can_add and is named with its reason", async () => {
  const b = await alt({ completed_courses: T10G });
  assert.equal(unit(b, "GC 3700").prereq_eligibility, "undetermined");
  assert.ok(b.summary.can_add.includes("GC 3700"));
  assert.equal(b.summary.prereq_undetermined[0].course, "GC 3700");
  assert.match(b.summary.text, /could not be confirmed/);
});

test("an in-progress prerequisite from an earlier term is pending and stays in can_add", async () => {
  const b = await alt({
    completed_courses: T10G,
    in_progress_courses: ["GC 3700"],
  });
  const u = unit(b, "GC 3730");
  assert.equal(u.prereq_eligibility, "undetermined");
  assert.deepEqual(u.pending, ["GC 3700"]);
  assert.ok(b.summary.can_add.includes("GC 3730"));
  assert.match(b.summary.text, /eligible if GC 3700 is passed/);
});

test("in progress AND in a kept CRN is the same term: GC 3450 stays not eligible", async () => {
  const b = await alt({
    completed_courses: T10G,
    in_progress_courses: ["GC 3400"],
  });
  assert.equal(unit(b, "GC 3450").prereq_eligibility, "not_eligible");
});

test("without completed_courses the result says prerequisites were not checked", async () => {
  const b = await alt({});
  assert.equal(unit(b, "GC 3730").prereq_eligibility, undefined);
  assert.ok(b.summary.can_add.includes("GC 3730"));
  assert.equal(b.summary.prerequisites_checked, false);
  assert.match(b.summary.text, /Prerequisites were NOT checked/);
});

test("a completed course that is not a course code is an error", async () => {
  const res = await findAlternatives.handler({
    term: TERM,
    current_crns: [KEPT],
    subject: "GC",
    completed_courses: ["flexo"],
  });
  assert.equal(res.isError, true);
});

test("a course missing from the catalog is undetermined, never eligible (review 2)", async () => {
  const b = await alt({ completed_courses: T10G });
  assert.equal(unit(b, "GC 4999").prereq_eligibility, "undetermined");
  assert.ok(
    b.summary.prereq_undetermined.some((u: any) => u.course === "GC 4999"),
  );
});
