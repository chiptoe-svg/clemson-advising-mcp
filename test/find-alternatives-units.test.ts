// find-alternatives course units, from the hostile review of 2026-11-04: a
// lab shared by alternative lectures (BIOL 1200 with 1220 OR 1230); a kept
// lecture whose lab is asked for, or swapped; a lab with arranged hours under
// a time filter; credit-bearing labs in the credit total; labs the catalog
// lacks (paired only on an exact title, else set aside); and every unit in
// exactly one summary list.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { catalogFixtureDdl } from "./_catalog-fixture-ddl.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "advising-mcp-alt-units-"));
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
    co: string[] = [],
  ) => {
    const [s, n] = code.split(" ");
    add.run(code, s, n, title, credits, co.length ? JSON.stringify(co) : null);
  };
  c("BI 1200", "Biological Inquiry Laboratory", "1", ["BI 1220", "BI 1230"]);
  c("BI 1220", "Keys to Biodiversity", "3", ["BI 1200"]);
  c("BI 1230", "Keys to Human Biology", "3", ["BI 1200"]);
  c("BI 1030", "General Biology", "3", ["BI 1050"]);
  c("BI 1050", "General Biology Laboratory", "1", ["BI 1030"]);
  c("CH 1010", "General Chemistry", "4", ["CH 1011"]);
  c("CH 1011", "General Chemistry Laboratory", "0", ["CH 1010"]);
  c("AL 3530", "Field Methods", "3", ["AL 3531"]);
  c("AL 3531", "Field Methods Laboratory", "0", ["AL 3530"]);
  c("XX 3000", "Soils", "3"); // its lab, XX 3001, is not in the catalog
  c("ZZ 1000", "Anchor", "3");
  c("ZZ 2000", "Mostly Placeholders", "3");
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
  title: string,
  credit: number | null,
  days: string | null,
  begin = "",
  end = "",
  cap = 20,
): Section {
  return {
    term: TERM,
    termDescription: "Fall 2026",
    crn,
    subjectCourse,
    section: crn.slice(-3),
    title,
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
            type: "Class",
          },
        ]
      : [],
  };
}

const K1 = "10001"; // kept: MW 0900-0950
const sections = [
  sec(K1, "ZZ1000", "Anchor", 3, "MW", "0900", "0950"),
  sec("20001", "BI1230", "Keys to Human Biology", 3, "TR", "1100", "1215"),
  sec(
    "20002",
    "BI1200",
    "Biological Inquiry Laboratory",
    1,
    "F",
    "1300",
    "1450",
  ),
  sec("30001", "CH1010", "General Chemistry", 4, "MW", "0900", "0950"), // clashes K1
  sec("30002", "CH1010", "General Chemistry", 4, "MWF", "1000", "1050"), // kept below
  sec("30003", "CH1010", "General Chemistry", 4, "TR", "0800", "0850"),
  sec(
    "30011",
    "CH1011",
    "General Chemistry Laboratory",
    0,
    "T",
    "1400",
    "1650",
  ),
  sec(
    "30012",
    "CH1011",
    "General Chemistry Laboratory",
    0,
    "R",
    "1400",
    "1650",
  ),
  sec("40001", "AL3530", "Field Methods", 3, "MW", "1100", "1215"),
  sec("40002", "AL3531", "Field Methods Laboratory", 0, null),
  // A full lab section with arranged hours: open_seats_only must drop it.
  {
    ...sec("40003", "AL3531", "Field Methods Laboratory", 0, null),
    seatsAvailable: 0,
  },
  sec("50001", "BI1030", "General Biology", 3, "TR", "0800", "0915"),
  sec("50002", "BI1050", "General Biology Laboratory", 1, "W", "1400", "1650"),
  sec("60001", "XX3000", "Soils", 3, "MW", "1300", "1350"),
  sec("60002", "XX3001", "Soils Laboratory", 0, "R", "0800", "0950"),
  // Creative Inquiry: topics per section; the lab belongs to one topic.
  sec("70001", "YY4940", "CI: Cichlid EvoDevo", 1, null),
  sec("70002", "YY4940", "CI: Herpetology", 1, null),
  sec("70003", "YY4941", "CI: Herpetology Lab", 0, null),
  // Banner cuts titles short: "La (HON )" is still the lab.
  sec("70004", "YY4941", "CI: Herpetology La (HON )", 0, null),
  // Numbered n/n+1 but unrelated.
  sec("71001", "YY6000", "Thesis Research", 3, null),
  sec("71002", "YY6001", "Microscopy Laboratory", 0, null),
  sec("80001", "ZZ2000", "Mostly Placeholders", 3, "MW", "0900", "0950"),
  sec("80002", "ZZ2000", "Mostly Placeholders", 3, null, "", "", 0),
];
writeScheduleDb({
  term: TERM,
  termDescription: "Fall 2026",
  fetchedAt: "2026-11-04T05:00:00.000Z",
  sectionCount: sections.length,
  sections,
});

function json(res: CallToolResult) {
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  return JSON.parse((res.content[0] as { text: string }).text);
}
const alt = async (args: Record<string, unknown>) =>
  json(
    await findAlternatives.handler({ term: TERM, current_crns: [K1], ...args }),
  );
const unit = (body: any, code: string) =>
  body.courses.find((u: any) => u.course === code);

test("a lab shared by alternative lectures pairs with either, never requiring both", async () => {
  const body = await alt({ courses: ["BI 1230"] });
  const u = unit(body, "BI 1230");
  assert.equal(u.fits, true, JSON.stringify(u));
  assert.deepEqual(u.with, ["BI 1200"]);
  assert.deepEqual(u.options[0].crns, ["20001", "20002"]);
  // Asking for the lab answers for each lecture it can go with.
  const lab = await alt({ courses: ["BI 1200"] });
  assert.deepEqual(lab.courses.map((x: any) => x.course).sort(), [
    "BI 1220",
    "BI 1230",
  ]);
  assert.deepEqual(lab.summary.can_add, ["BI 1230"]);
  assert.deepEqual(lab.summary.not_offered, ["BI 1220"]);
});

test("she keeps the lecture and asks for the lab: the lab can be added", async () => {
  const body = await alt({ current_crns: [K1, "30002"], courses: ["CH 1011"] });
  assert.deepEqual(body.summary.can_add, ["CH 1011"]);
  assert.match(body.summary.text, /CH 1011 \(to go with kept CH 1010\)/);
  assert.deepEqual(
    body.courses[0].options.map((o: any) => o.crns),
    [["30011"], ["30012"]],
  );
});

test("swapping a lab: its 0 credit hours don't rule out every other lab", async () => {
  const body = await alt({
    current_crns: [K1, "30002", "30011"],
    replacing_crn: "30011",
  });
  assert.deepEqual(body.summary.can_add, ["CH 1011"]);
  assert.deepEqual(
    body.courses.find((u: any) => u.course === "CH 1010").options[0].crns,
    ["30012"],
  );
});

test("swapping a lecture while keeping its lab: the lecture can be added", async () => {
  const body = await alt({
    current_crns: [K1, "30002", "30011"],
    replacing_crn: "30002",
    courses: ["CH 1010"],
  });
  assert.deepEqual(body.summary.can_add, ["CH 1010"]);
  assert.equal(body.summary.already_kept, undefined);
});

test("a lab with arranged hours passes a time filter; a lab the filter rules out is 'outside the filters'", async () => {
  const al = await alt({ courses: ["AL 3530"], no_meeting_before: "1000" });
  assert.equal(unit(al, "AL 3530").fits, true, JSON.stringify(al.courses[0]));
  const bi = await alt({ courses: ["BI 1030"], days: "TR" });
  assert.deepEqual(bi.summary.outside_filters, ["BI 1030"]);
  assert.deepEqual(bi.summary.do_not_fit, []);
});

test("a choice's credit hours include a credit-bearing lab, and the credits filter reads the total", async () => {
  const body = await alt({ courses: ["BI 1030"] });
  assert.equal(unit(body, "BI 1030").options[0].credit_hours, 4);
  assert.equal(
    unit(await alt({ courses: ["BI 1030"], credits: 4 }), "BI 1030").fits,
    true,
  );
  const three = unit(
    await alt({ courses: ["BI 1030"], credits: 3 }),
    "BI 1030",
  );
  assert.equal(three.fits, false);
  assert.equal(three.failure, "filters");
});

test("a lab the catalog lacks pairs only on an exact title; any other is set aside, never listed", async () => {
  const xx = await alt({ subject: "XX" });
  assert.equal(unit(xx, "XX 3001"), undefined);
  assert.deepEqual(unit(xx, "XX 3000").with, ["XX 3001"]);
  assert.match(unit(xx, "XX 3000").pairing_note, /read from the schedule/);
  const yy = await alt({ subject: "YY", include_graduate: true });
  assert.deepEqual(yy.summary.excluded.unpaired_labs, ["YY 4941", "YY 6001"]);
  assert.equal(unit(yy, "YY 4940").with, undefined);
  assert.equal(unit(yy, "YY 6000").with, undefined);
  assert.deepEqual(yy.summary.can_add, ["YY 4940", "YY 6000"]);
  assert.match(yy.note, /YY 4941/);
});

test("every unit lands in exactly one summary list", async () => {
  for (const subject of ["BI", "CH", "XX", "YY", "ZZ", "AL"]) {
    const b = await alt({ subject, include_graduate: true });
    const s = b.summary;
    const listed = [
      ...s.can_add,
      ...s.do_not_fit,
      ...s.not_offered,
      ...(s.already_kept ?? []),
      ...(s.outside_filters ?? []),
    ];
    assert.equal(
      listed.length,
      b.courses.length,
      `${subject}: ${JSON.stringify(s)}`,
    );
  }
});

test("placeholder sections are not counted as filter rejections", async () => {
  const u = unit(await alt({ courses: ["ZZ 2000"] }), "ZZ 2000");
  assert.equal(u.outside_filters, undefined);
  assert.equal(u.placeholders_skipped, 1);
});

test("the time-filter exemption follows the lab, not its position: kept lecture, lab asked", async () => {
  const body = await alt({
    current_crns: [K1, "40001"],
    courses: ["AL 3531"],
    no_meeting_before: "1000",
  });
  assert.deepEqual(body.summary.can_add, ["AL 3531"]);
});

test("a lab with arranged hours still has to pass open_seats_only", async () => {
  const body = await alt({
    courses: ["AL 3530"],
    open_seats_only: true,
    no_meeting_before: "1000",
  });
  const crns = unit(body, "AL 3530").options.flatMap((o: any) => o.crns);
  assert.ok(!crns.includes("40003"), JSON.stringify(crns));
  assert.ok(crns.includes("40002"));
});

test("graduate labs stay out of unpaired_labs unless graduate courses are asked for", async () => {
  const yy = await alt({ subject: "YY" });
  assert.deepEqual(yy.summary.excluded.unpaired_labs, ["YY 4941"]);
});

test("swapping a lecture whose lab she keeps says the lab goes with it", async () => {
  const body = await alt({
    current_crns: [K1, "30002", "30011"],
    replacing_crn: "30002",
    subject: "CH",
  });
  assert.match(body.note, /CH 1011.*CH 1010/);
});

test("a course kept whole with no other section is not called placeholder-only", async () => {
  const body = await alt({
    current_crns: [K1, "20001", "20002"],
    courses: ["BI 1230"],
  });
  assert.deepEqual(body.summary.already_kept, ["BI 1230"]);
  assert.doesNotMatch(unit(body, "BI 1230").reason ?? "", /placeholder/);
});

test("swapping a lab section does not warn about its kept lecture", async () => {
  const body = await alt({
    current_crns: [K1, "30002", "30011"],
    replacing_crn: "30011",
  });
  assert.doesNotMatch(body.note ?? "", /goes with/);
});
