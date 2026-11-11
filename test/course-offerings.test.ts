// get-course-offerings: offering history is RAW EVIDENCE from held snapshots,
// never an inferred pattern. The properties under test: observed_terms states
// exactly what was observed (a missing snapshot is unknown, not "not
// offered"); a course absent from an observed term is derivably
// observed-not-run; a course seen in no held snapshot says so explicitly; and
// codes normalize to the snapshot's spaceless form.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "course-offerings-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

// 2026-11-11: Fall 2024 has ended; Fall 2026 is still in progress.
const NOW = new Date("2026-11-11T12:00:00-05:00");
const { __setTermClockForTest } = await import("../src/term-resolve.ts");
__setTermClockForTest(() => NOW);

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { __schedTools } = await import("../src/mcp-tools/clemson-schedule.ts");

function section(crn: string, course: string) {
  return {
    // writeScheduleDb files every row under the snapshot's term, not these.
    term: "",
    termDescription: "",
    crn,
    subjectCourse: course,
    section: "001",
    title: `${course} title`,
    campus: "C",
    scheduleType: "Lecture",
    instructionalMethod: "F",
    partOfTerm: "1",
    creditHours: 3,
    enrollment: 5,
    maxEnrollment: 20,
    seatsAvailable: 15,
    waitCount: 0,
    waitCapacity: 0,
    open: true,
    meetings: [
      {
        days: "MWF",
        beginTime: "0900",
        endTime: "0950",
        building: "Hall",
        room: "1",
        roomCapacity: null,
        startDate: null,
        endDate: null,
        type: "Class",
      },
    ],
    instructors: [{ name: "A Teacher", email: "t@clemson.edu", primary: true }],
  };
}

// A placeholder: no seats and nobody in it. It is listed, but nothing ran.
function shell(crn: string, course: string) {
  return {
    ...section(crn, course),
    enrollment: 0,
    maxEnrollment: 0,
    seatsAvailable: 0,
  };
}

// Fall 2024: GC3400 runs twice, MATH1060 once (plus a shell); PKSC4990 has
// only a shell. Fall 2026: only MATH1060 (plus a shell).
writeScheduleDb({
  term: "202408",
  termDescription: "Fall 2024",
  fetchedAt: "2024-08-01T05:00:00Z",
  sectionCount: 5,
  sections: [
    section("50001", "GC3400"),
    section("50002", "GC3400"),
    section("50003", "MATH1060"),
    shell("50004", "PKSC4990"),
    shell("50005", "MATH1060"),
  ],
});
writeScheduleDb({
  term: "202608",
  termDescription: "Fall 2026",
  fetchedAt: "2026-08-01T05:00:00Z",
  sectionCount: 2,
  sections: [section("60001", "MATH1060"), shell("60002", "MATH1060")],
});

async function offerings(courses: string[]) {
  const res = await __schedTools.courseOfferings.handler({ courses });
  assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]));
  return JSON.parse((res.content[0] as { text: string }).text) as {
    observed_terms: { term: string; data_as_of: string | null }[];
    seasons_note?: string;
    courses: {
      code: string;
      offerings: { term: string; section_count: number }[];
      seasons: Record<
        string,
        {
          offered: number;
          observed: number;
          since_first_offered: { offered: number; observed: number } | null;
          recent: { offered: number; observed: number };
          last_offered: string | null;
          consecutive_missed: number;
          estimated_probability: number | null;
          label: string;
        }
      >;
      note?: string;
    }[];
  };
}

test("offering history is per observed term, with counts, keyed by normalized code", async () => {
  const b = await offerings(["GC 3400", "math1060"]);
  assert.deepEqual(
    b.observed_terms.map((t) => t.term),
    ["202408", "202608"],
  );
  assert.ok(b.observed_terms[0].data_as_of?.startsWith("2024-08-01"));
  const gc = b.courses.find((c) => c.code === "GC3400")!;
  // Ran in 202408 (2 sections); 202608 was OBSERVED and it did not run —
  // derivable because 202608 is in observed_terms but not in offerings.
  assert.deepEqual(gc.offerings, [{ term: "202408", section_count: 2 }]);
  const math = b.courses.find((c) => c.code === "MATH1060")!;
  assert.deepEqual(
    math.offerings.map((o) => o.term),
    ["202408", "202608"],
  );
});

test("in a term that has ended, a section with no seats and no students is not an offering", async () => {
  const b = await offerings(["PKSC 4990", "MATH 1060"]);
  // Only a shell in 202408: observed, and it did not run.
  const pksc = b.courses.find((c) => c.code === "PKSC4990")!;
  assert.deepEqual(pksc.offerings, []);
  // A shell beside a real section does not add to the count.
  const math = b.courses.find((c) => c.code === "MATH1060")!;
  assert.equal(math.offerings[0].term, "202408");
  assert.equal(math.offerings[0].section_count, 1);
});

test("a term still in progress keeps its shells — its schedule can still change", async () => {
  const b = await offerings(["MATH 1060"]);
  assert.deepEqual(b.courses[0].offerings[1], {
    term: "202608",
    section_count: 2,
  });
});

test("a course seen in no held snapshot says so — and does not claim 'not offered'", async () => {
  const b = await offerings(["ARCH 9990"]);
  const [c] = b.courses;
  assert.deepEqual(c.offerings, []);
  assert.match(String(c.note), /unknown, not/);
  // observed_terms still states the ground that WAS covered.
  assert.equal(b.observed_terms.length, 2);
});

test("garbage codes are an error naming the offenders", async () => {
  const res = await __schedTools.courseOfferings.handler({
    courses: ["not a course"],
  });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /Not course codes/);
});

test("empty courses is an error, not an empty answer", async () => {
  const res = await __schedTools.courseOfferings.handler({ courses: [] });
  assert.equal(res.isError, true);
});

test("seasons rollup carries evidence AND an era-aware probability estimate", async () => {
  const b = await offerings(["GC 3400", "MATH 1060"]);
  const gc = b.courses.find((c) => c.code === "GC3400")!;
  // Two falls observed; GC3400 ran in the older one only.
  const fall = gc.seasons.fall;
  assert.equal(fall.offered, 1);
  assert.equal(fall.observed, 2);
  assert.equal(fall.last_offered, "202408");
  assert.equal(fall.consecutive_missed, 1);
  assert.deepEqual(fall.recent, { offered: 1, observed: 2 });
  assert.deepEqual(fall.since_first_offered, { offered: 1, observed: 2 });
  // Recency-weighted: the miss is newest (weight 1), the run older (0.707)
  // -> 0.707/1.707 = 0.41. A flat lifetime ratio would say 0.5.
  assert.equal(fall.estimated_probability, 0.41);
  assert.equal(fall.label, "uncertain");
  assert.equal(gc.seasons.spring, undefined);

  const math = b.courses.find((c) => c.code === "MATH1060")!;
  // Ran every observed fall — clamped away from 1.0: never a guarantee.
  assert.equal(math.seasons.fall.estimated_probability, 0.97);
  assert.equal(math.seasons.fall.label, "very likely");
  assert.equal(math.seasons.fall.consecutive_missed, 0);
});

test("a never-observed course has no probability basis — null, not zero", async () => {
  const b = await offerings(["ARCH 9990"]);
  const [c] = b.courses;
  const fall = c.seasons.fall;
  assert.equal(fall.estimated_probability, null);
  assert.equal(fall.label, "no basis");
  assert.equal(fall.since_first_offered, null);
});

test("the offerings cache absorbs a new snapshot on the next call (fingerprint rebuild)", async () => {
  // A spring term appears AFTER the cache was first built...
  writeScheduleDb({
    term: "202601",
    termDescription: "Spring 2026",
    fetchedAt: "2026-01-02T05:00:00Z",
    sectionCount: 1,
    sections: [section("70001", "GC3400")],
  });
  // ...and the very next call sees it, with the season now present.
  const b = await offerings(["GC 3400"]);
  assert.deepEqual(
    b.observed_terms.map((t) => t.term),
    ["202408", "202601", "202608"],
  );
  const gc = b.courses[0];
  const spring = gc.seasons.spring;
  assert.equal(spring.offered, 1);
  assert.equal(spring.observed, 1);
  assert.equal(spring.last_offered, "202601");
  assert.equal(spring.estimated_probability, 0.97);
  assert.equal(spring.label, "very likely");
});

test("when a term ends, the cache recounts it without its shells", async () => {
  __setTermClockForTest(() => new Date("2027-01-05T12:00:00-05:00"));
  try {
    const b = await offerings(["MATH 1060"]);
    assert.deepEqual(b.courses[0].offerings[1], {
      term: "202608",
      section_count: 1,
    });
  } finally {
    __setTermClockForTest(() => NOW);
  }
  // And back: the in-progress count returns with the clock.
  const b = await offerings(["MATH 1060"]);
  assert.equal(b.courses[0].offerings[1].section_count, 2);
});

test("a cache built under an older counting rule is rebuilt even though no snapshot changed", async () => {
  await offerings(["MATH 1060"]); // cache current
  // Make it look like a cache written before shells were excluded: the bare
  // snapshot fingerprint, and the shell-only course counted as offered.
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(STATE, "clemson", "offerings.db"));
  const { value } = db
    .prepare("SELECT value FROM meta WHERE key='fingerprint'")
    .get() as { value: string };
  db.prepare("UPDATE meta SET value=? WHERE key='fingerprint'").run(
    value.replace(/^rule-\d+\|/, ""),
  );
  db.prepare("INSERT INTO offerings VALUES ('PKSC4990','202408',1)").run();
  db.close();
  const b = await offerings(["PKSC 4990"]);
  assert.deepEqual(b.courses[0].offerings, []);
});

// --- recorded decisions: the third provenance overrides the estimate --------

const DECISIONS_PATH = path.join(STATE, "offering-decisions.yaml");

test("a recorded decision overrides the label and rides as known_decision", async () => {
  fs.writeFileSync(
    DECISIONS_PATH,
    [
      "decisions:",
      '  - course: "GC 3400"',
      "    expect: not_offered",
      "    seasons: [fall]",
      '    note: "discontinued in falls"',
      '    source: "dept chair"',
      "    recorded: 2026-09-06",
    ].join("\n"),
  );
  const b = await offerings(["GC 3400"]);
  const fall = b.courses[0].seasons
    .fall as (typeof b)["courses"][number]["seasons"]["fall"] & {
    known_decision?: { expect: string; note?: string; source?: string };
  };
  assert.equal(fall.label, "ruled out");
  assert.equal(fall.known_decision?.expect, "not_offered");
  assert.equal(fall.known_decision?.source, "dept chair");
  // The estimate stays visible as evidence — overridden, not erased.
  assert.notEqual(fall.estimated_probability, null);
  // Other seasons untouched.
  assert.notEqual(b.courses[0].seasons.spring.label, "ruled out");
  assert.match(String(b.seasons_note ?? ""), /known_decision/);
});

test("a decision about a season with no observed history still surfaces", async () => {
  fs.writeFileSync(
    DECISIONS_PATH,
    'decisions:\n  - course: "GC 3400"\n    expect: offered\n    seasons: [summer]\n',
  );
  const b = await offerings(["GC 3400"]);
  // No summers are held in this fixture — the decision creates the entry.
  const summer = b.courses[0].seasons.summer as {
    label: string;
    estimated_probability: number | null;
    known_decision?: { expect: string };
  };
  assert.equal(summer.label, "confirmed");
  assert.equal(summer.estimated_probability, null);
  assert.equal(summer.known_decision?.expect, "offered");
});

test("an unreadable decisions file is an ERROR, never estimates that ignore it", async () => {
  fs.writeFileSync(DECISIONS_PATH, "decisions: [unclosed");
  const res = await __schedTools.courseOfferings.handler({
    courses: ["GC 3400"],
  });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /unreadable/);
});

test("a malformed entry names itself in the error", async () => {
  fs.writeFileSync(
    DECISIONS_PATH,
    'decisions:\n  - course: "GC 3400"\n    expect: maybe\n    seasons: [fall]\n',
  );
  const res = await __schedTools.courseOfferings.handler({
    courses: ["GC 3400"],
  });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /expect/);
});

test("removing the file removes the overrides — absent is a true absence", async () => {
  fs.unlinkSync(DECISIONS_PATH);
  const b = await offerings(["GC 3400"]);
  const fall = b.courses[0].seasons.fall as { known_decision?: unknown };
  assert.equal(fall.known_decision, undefined);
});
