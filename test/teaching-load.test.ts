// get-teaching-load: "how many contact hours do GC faculty have?" as one
// deterministic server-side computation. Properties under test: credit hours
// count once per SECTION however many meetings it has; untimed sections are
// reported separately and never folded into a contact total; co-taught
// sections attribute fully to each listed instructor; a subject filter is a
// stated scope, not a silent narrowing; and no snapshot means nothing was
// computed — never a zero.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "teaching-load-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { __schedTools } = await import("../src/mcp-tools/clemson-schedule.ts");

function section(
  crn: string,
  course: string,
  credit: number,
  instructors: { name: string; email: string | null; primary: boolean }[],
  meetings: { days: string; beginTime: string; endTime: string }[],
) {
  return {
    // writeScheduleDb files every row under the snapshot's term, not these.
    term: "",
    termDescription: "",
    crn,
    subjectCourse: course,
    // Banner reports a label (or none) for every section: a recorded snapshot.
    crossList: null as string | null,
    section: "001",
    title: `${course} title`,
    campus: "C",
    scheduleType: "Lecture",
    instructionalMethod: "F",
    partOfTerm: "1",
    creditHours: credit,
    enrollment: 5,
    maxEnrollment: 20,
    seatsAvailable: 15,
    waitCount: 0,
    waitCapacity: 0,
    open: true,
    meetings: meetings.map((m) => ({
      ...m,
      building: "Hall",
      room: "1",
      roomCapacity: null,
      startDate: null,
      endDate: null,
      type: "Class",
    })),
    instructors,
  };
}

const chip = {
  name: "Chip Tonkin",
  email: "tonkin@clemson.edu",
  primary: true,
};
const gus = { name: "Gus Seven", email: "gseven@clemson.edu", primary: true };
const fay = { name: "Fay Six", email: "fsix@clemson.edu", primary: true };
const dana = { name: "Dana Reyes", email: "reyes@clemson.edu", primary: true };
const bobby = {
  name: "Bobby Congdon",
  email: "congdon@clemson.edu",
  primary: false,
};

writeScheduleDb({
  term: "202608",
  termDescription: "Fall 2026",
  fetchedAt: new Date().toISOString(),
  sectionCount: 7,
  sections: [
    // Three meeting rows, ONE section: credit must count once (3, not 9).
    section(
      "70001",
      "GC1010",
      3,
      [chip],
      [{ days: "MWF", beginTime: "1130", endTime: "1220" }],
    ),
    section(
      "70002",
      "GC3500",
      3,
      [bobby],
      [{ days: "MW", beginTime: "0800", endTime: "0915" }],
    ),
    // No timed meetings at all — must land in untimed_sections, not a total.
    section("70003", "GC3501", 2, [bobby], []),
    // Co-taught: attributes FULLY to both Chip and Bobby.
    section(
      "70004",
      "GC4000",
      1,
      [chip, bobby],
      [{ days: "T", beginTime: "0900", endTime: "1000" }],
    ),
    // Outside the GC subject — visible without a subject filter only.
    section(
      "70005",
      "MATH1060",
      3,
      [bobby],
      [{ days: "F", beginTime: "1000", endTime: "1100" }],
    ),
    // Two people sharing the "Smith" substring, for ambiguity.
    section(
      "70006",
      "STAT2300",
      3,
      [{ name: "Ann Smithers", email: "asmithe@clemson.edu", primary: true }],
      [{ days: "M", beginTime: "0900", endTime: "1000" }],
    ),
    section(
      "70007",
      "STAT2310",
      3,
      [{ name: "Bo Smith", email: "bsmith@clemson.edu", primary: true }],
      [{ days: "T", beginTime: "0900", endTime: "1000" }],
    ),
    // Dana: what counts once (Chip, 2026-10-30). Honors 002, labeled.
    {
      ...section(
        "71001",
        "GC4400",
        4,
        [dana],
        [{ days: "MW", beginTime: "0900", endTime: "0915" }],
      ),
      crossList: "GC8",
    },
    {
      ...section(
        "71002",
        "GC4400",
        4,
        [dana],
        [{ days: "MW", beginTime: "0900", endTime: "0915" }],
      ),
      section: "002",
      crossList: "GC8",
    },
    // An unlabeled 4xxx/6xxx pair at the same times.
    section(
      "71003",
      "GC6900",
      1,
      [dana],
      [{ days: "F", beginTime: "1000", endTime: "1030" }],
    ),
    section(
      "71004",
      "GC4900",
      1,
      [dana],
      [{ days: "F", beginTime: "1000", endTime: "1030" }],
    ),
    // Labeled seminars; 2990 runs ten minutes longer.
    ...[
      ["71005", "GC1990", "1415"],
      ["71006", "GC2990", "1425"],
      ["71007", "GC3990", "1415"],
      ["71008", "GC4990", "1415"],
    ].map(([crn, course, end]) => ({
      ...section(
        crn!,
        course!,
        1,
        [dana],
        [{ days: "R", beginTime: "1325", endTime: end! }],
      ),
      crossList: "GC1",
    })),
    // A variable-credit section with no credits set (credit_hours null).
    {
      ...section(
        "72001",
        "MATH4900",
        3,
        [{ name: "Eve Null", email: "enull@clemson.edu", primary: true }],
        [{ days: "F", beginTime: "0900", endTime: "0950" }],
      ),
      creditHours: null,
    },
    // Fay: a labeled 4440/6440 pair, plus an unlabeled 4440-002 at the
    // same time in another room — a double booking, not part of the group
    // (no chaining through the 4xxx/6xxx rule).
    {
      ...section(
        "73001",
        "GC4440",
        4,
        [fay],
        [{ days: "TR", beginTime: "1100", endTime: "1215" }],
      ),
      crossList: "GC3",
    },
    {
      ...section(
        "73002",
        "GC6440",
        4,
        [fay],
        [{ days: "TR", beginTime: "1100", endTime: "1215" }],
      ),
      crossList: "GC3",
    },
    {
      ...section(
        "73003",
        "GC4440",
        4,
        [fay],
        [{ days: "TR", beginTime: "1100", endTime: "1215" }],
      ),
      section: "002",
    },
    // Same time, NOT cross-listed (a placeholder instructor, probably):
    // both count.
    section(
      "71009",
      "GC3780",
      3,
      [dana],
      [{ days: "T", beginTime: "0800", endTime: "0815" }],
    ),
    section(
      "71010",
      "GC3790",
      3,
      [dana],
      [{ days: "T", beginTime: "0800", endTime: "0815" }],
    ),
  ],
});

async function load(args: Record<string, unknown>) {
  const res = await __schedTools.teachingLoad.handler({
    term: "202608",
    ...args,
  });
  assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]));
  return JSON.parse((res.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;
}

type Person = {
  name?: string;
  query?: string;
  status?: string;
  note?: string;
  candidates?: unknown[];
  sections_count: number;
  contact_hours_weekly: number;
  credit_hours: number;
  untimed_sections: { count: number; crns: string[] };
  sections: {
    crn: string;
    weekly_contact_hours: number;
    timed: boolean;
    cross_list?: string;
    meets_with?: { crn: string }[];
  }[];
};

test("subject mode: everyone on the subject's sections, both measures, untimed separate", async () => {
  const b = await load({ subject: "GC" });
  assert.equal(b.has_snapshot, true);
  assert.match(String(b.scope), /GC sections only/);
  const rows = b.instructors as Person[];
  // Both total 3.5 contact hours; the tie breaks alphabetically.
  const i = rows.findIndex((r) => r.name === "Bobby Congdon");
  const [bobbyRow, chipRow] = [rows[i]!, rows[i + 1]!];
  assert.equal(bobbyRow.name, "Bobby Congdon");
  assert.equal(bobbyRow.sections_count, 3);
  assert.equal(bobbyRow.contact_hours_weekly, 3.5); // 150 + 60 timed minutes
  assert.equal(bobbyRow.credit_hours, 6); // 3 + 2 + 1 — untimed COUNTS for credit
  assert.deepEqual(bobbyRow.untimed_sections, { count: 1, crns: ["70003"] });
  assert.equal(chipRow.name, "Chip Tonkin");
  assert.equal(chipRow.sections_count, 2);
  assert.equal(chipRow.contact_hours_weekly, 3.5); // 150 + 60
  // The dedupe property: GC1010 meets MWF (three rows) but is 3 credits ONCE.
  assert.equal(chipRow.credit_hours, 4);
  assert.equal((b.instructors as Person[]).length, 4);
});

test("no chaining: a labeled pair stays one class, an unlabeled overlap counts on its own", async () => {
  const b = await load({ instructors: ["fsix@clemson.edu"] });
  const [row] = b.instructors as Person[];
  assert.equal(row.sections_count, 2);
  const lead = row.sections.find((s) => s.crn === "73001");
  assert.equal(lead?.cross_list, "GC3");
  assert.deepEqual(
    lead?.meets_with?.map((m) => m.crn),
    ["73002"],
  );
});

test("a section with no credits set is listed, never silently counted as 0", async () => {
  const b = await load({ instructors: ["enull@clemson.edu"] });
  const [row] = b.instructors as (Person & {
    credits_not_set?: { count: number; crns: string[] };
  })[];
  assert.equal(row.credit_hours, 0);
  assert.deepEqual(row.credits_not_set, { count: 1, crns: ["72001"] });
});

test("a cross-listed group counts once; other overlaps count separately", async () => {
  const b = await load({ instructors: ["reyes@clemson.edu"] });
  const [row] = b.instructors as Person[];
  // 4400 honors pair, 4900/6900, the seminar group, 3780, 3790.
  assert.equal(row.sections_count, 5);
  // 30 (MW) + 30 (F) + 60 (R, 1325-1425 once) + 15 + 15 = 150 minutes.
  assert.equal(row.contact_hours_weekly, 2.5);
  assert.equal(row.credit_hours, 12); // 4 + 1 + 1 + 3 + 3
  const lead = (crn: string) => row.sections.find((s) => s.crn === crn);
  assert.deepEqual(
    lead("71001")?.meets_with?.map((m) => m.crn),
    ["71002"],
  );
  assert.equal(lead("71001")?.cross_list, "GC8");
  assert.deepEqual(
    lead("71004")?.meets_with?.map((m) => m.crn),
    ["71003"],
  );
  assert.equal(lead("71004")?.cross_list, "unlabeled 4xxx/6xxx pair");
  assert.deepEqual(
    lead("71005")?.meets_with?.map((m) => m.crn),
    ["71006", "71007", "71008"],
  );
  assert.equal(lead("71009")?.meets_with, undefined);
  assert.equal(lead("71010")?.meets_with, undefined);
  assert.equal(row.sections.length, 5);
  assert.equal(b.cross_list_note, undefined);
});

test("labels not recorded: none are used, so a partial label can't split a pair", async () => {
  // As after one live course refresh on an older snapshot: GC 4400 got its
  // label GC3 written back; its GC 6400 partner (also GC3 in Banner) still
  // has none, and the rest of the file was written without labels.
  const { crossList: _a, ...g64 } = section(
    "74002",
    "GC6400",
    3,
    [gus],
    [{ days: "TR", beginTime: "0800", endTime: "0915" }],
  );
  writeScheduleDb({
    term: "202508",
    termDescription: "Fall 2025",
    fetchedAt: new Date().toISOString(),
    sectionCount: 2,
    sections: [
      {
        ...section(
          "74001",
          "GC4400",
          3,
          [gus],
          [{ days: "TR", beginTime: "0800", endTime: "0915" }],
        ),
        crossList: "GC3",
      },
      g64,
    ],
  });
  const res = await __schedTools.teachingLoad.handler({
    term: "202508",
    instructors: ["gseven@clemson.edu"],
  });
  const b = JSON.parse((res.content[0] as { text: string }).text);
  const [row] = b.instructors as Person[];
  assert.equal(row.sections_count, 1); // the unlabeled 4xxx/6xxx rule
  assert.equal(row.credit_hours, 3);
  assert.match(String(b.cross_list_note), /predates/);
});

test("instructor mode without subject counts everything they teach", async () => {
  const b = await load({ instructors: ["congdon@clemson.edu"] });
  const [row] = b.instructors as Person[];
  assert.equal(row.status, "teaching");
  assert.equal(row.sections_count, 4); // + MATH1060
  assert.equal(row.contact_hours_weekly, 4.5); // 3.5 + 1.0
  assert.equal(row.credit_hours, 9);
  assert.equal(row.untimed_sections.count, 1);
  assert.match(String(b.scope), /every section/);
});

test("subject + instructors scopes the person's load to that subject", async () => {
  const b = await load({ subject: "GC", instructors: ["Bobby Congdon"] });
  const [row] = b.instructors as Person[];
  assert.equal(row.sections_count, 3);
  assert.equal(row.contact_hours_weekly, 3.5);
  assert.equal(row.credit_hours, 6);
});

test("teaches this term but nothing in the subject: explicit zeros with a note, not absence", async () => {
  const b = await load({ subject: "MATH", instructors: ["Chip Tonkin"] });
  const [row] = b.instructors as Person[];
  assert.equal(row.status, "teaching");
  assert.equal(row.sections_count, 0);
  assert.match(String(row.note), /no MATH sections/);
});

test("co-taught sections attribute fully to each instructor, and the response says so", async () => {
  const b = await load({
    instructors: ["tonkin@clemson.edu", "congdon@clemson.edu"],
  });
  const [chipRow, bobbyRow] = b.instructors as Person[];
  const chipGc4000 = chipRow.sections.find((s) => s.crn === "70004");
  const bobbyGc4000 = bobbyRow.sections.find((s) => s.crn === "70004");
  assert.equal(chipGc4000?.weekly_contact_hours, 1);
  assert.equal(bobbyGc4000?.weekly_contact_hours, 1);
  assert.match(String(b.attribution), /fully to EACH/);
});

test("an unknown instructor is not_teaching — never a zero-hours row", async () => {
  const b = await load({ instructors: ["nobody@clemson.edu"] });
  const [row] = b.instructors as Person[];
  assert.equal(row.status, "not_teaching");
  assert.match(String(row.note), /not a statement about their workload/);
});

test("an ambiguous name returns candidates, never a merged or guessed load", async () => {
  const b = await load({ instructors: ["Smith"] });
  const [row] = b.instructors as Person[];
  assert.equal(row.status, "ambiguous");
  assert.equal((row.candidates as unknown[]).length, 2);
});

test("no snapshot: nothing was computed, so nothing is claimed", async () => {
  const res = await __schedTools.teachingLoad.handler({
    term: "203008",
    subject: "GC",
  });
  const b = JSON.parse((res.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;
  assert.equal(b.has_snapshot, false);
  assert.deepEqual(b.instructors, []);
  assert.match(String(b._note), /no load could be computed/);
});

test("neither subject nor instructors is an error, not an empty answer", async () => {
  const res = await __schedTools.teachingLoad.handler({ term: "202608" });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /subject/);
});

test("listings_count sits beside sections_count: groups count once, listings each", async () => {
  const b = await load({ instructors: ["reyes@clemson.edu", "fsix@clemson.edu"] });
  const [dana, fay] = b.instructors as (Person & { listings_count: number })[];
  assert.equal(dana.sections_count, 5);
  assert.equal(dana.listings_count, 10);
  assert.equal(fay.sections_count, 2);
  assert.equal(fay.listings_count, 3);
  const all = await load({ subject: "GC" });
  for (const p of all.instructors as (Person & { listings_count: number })[])
    assert.equal(
      p.listings_count,
      p.sections.reduce((n, s) => n + 1 + (s.meets_with?.length ?? 0), 0),
    );
});

// get-instructor-classes must count the way get-teaching-load does, or a
// chair's "who teaches more sections?" depends on which tool was called.
async function classes(args: Record<string, unknown>) {
  const res = await __schedTools.instructorClasses.handler({
    term: "202608",
    ...args,
  });
  assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]));
  return JSON.parse((res.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;
}

type ClassesPerson = {
  status: string;
  sections_count: number;
  listings_count: number;
  sections: {
    crn: string;
    timed: boolean;
    cross_list?: string;
    meets_with?: { crn: string; subject_course: string; section: string }[];
    meetings: { day: string; start_min: number | null; end_min: number | null }[];
  }[];
};

test("get-instructor-classes groups meets-with listings exactly like get-teaching-load", async () => {
  const people = ["reyes@clemson.edu", "fsix@clemson.edu", "congdon@clemson.edu", "tonkin@clemson.edu"];
  const c = await classes({ instructors: people });
  const l = await load({ instructors: people });
  const cp = c.instructors as ClassesPerson[];
  const lp = l.instructors as (Person & { listings_count: number })[];
  for (let i = 0; i < people.length; i++) {
    assert.equal(cp[i]!.sections_count, lp[i]!.sections_count, people[i]);
    assert.equal(cp[i]!.listings_count, lp[i]!.listings_count, people[i]);
    assert.equal(cp[i]!.sections.length, cp[i]!.sections_count, people[i]);
    const shape = (ss: { crn: string; cross_list?: string; meets_with?: { crn: string }[] }[]) =>
      ss
        .map((s) => `${s.crn}:${s.cross_list ?? ""}:${(s.meets_with ?? []).map((m) => m.crn).join(",")}`)
        .sort();
    assert.deepEqual(shape(cp[i]!.sections), shape(lp[i]!.sections), people[i]);
  }
  const dana = cp[0]!;
  const honors = dana.sections.find((s) => s.crn === "71001")!;
  assert.deepEqual(honors.meets_with, [
    { crn: "71002", subject_course: "GC4400", section: "002" },
  ]);
  // The seminar group's meetings are the union: GC2990 runs to 1425.
  const seminar = dana.sections.find((s) => s.crn === "71005")!;
  assert.deepEqual(
    seminar.meetings.map((m) => `${m.day}${m.start_min}-${m.end_min}`).sort(),
    ["R805-855", "R805-865"],
  );
  // Fay's unlabeled 4440-002 at the same time stays its own section.
  assert.equal(cp[1]!.sections.find((s) => s.crn === "73003")?.meets_with, undefined);
});

test("get-instructor-classes counts with a day filter too", async () => {
  const c = await classes({ instructors: ["reyes@clemson.edu"], days: "R" });
  const [dana] = c.instructors as ClassesPerson[];
  assert.equal(dana.status, "busy");
  assert.equal(dana.sections_count, 5);
  assert.equal(dana.listings_count, 10);
});
