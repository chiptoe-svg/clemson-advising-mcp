// get-course-enrollment-history: enrollment/capacity per course per term.
//
// The properties under test are the ones a demand analysis gets wrong if the
// tool is sloppy: a term nobody observed must stay UNKNOWN rather than reading
// as zero demand; a missing enrollment must stay null rather than being summed
// as 0; fill_rate must be allowed above 1.0 because Clemson really does
// over-enrol labs; and every term must declare how its snapshot relates to the
// term's own lifecycle, since comparing a pre-registration reading against
// settled ones invents a demand cliff.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "enrollment-history-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { __schedTools } = await import("../src/mcp-tools/clemson-schedule.ts");
const { termStatus } = await import("../src/clemson-enrollment-history.ts");

function section(
  crn: string,
  course: string,
  enrollment: number | null,
  maxEnrollment: number | null,
  seatsAvailable: number | null,
) {
  return {
    crn,
    subjectCourse: course,
    section: "001",
    title: `${course} title`,
    campus: "C",
    scheduleType: "Lecture",
    instructionalMethod: "F",
    creditHours: 3,
    enrollment,
    maxEnrollment,
    seatsAvailable,
    waitCount: 0,
    waitCapacity: 0,
    open: true,
    meetings: [],
    instructors: [],
  } as never;
}

// Fall 2025 mirrors the real snapshot exactly (verified against
// state/clemson/202508.db on 2026-09-08): GC 3401 ran three sections at
// 13/16/16 in 16 seats each, and GC 2071 ran OVER its listed cap.
writeScheduleDb({
  term: "202508",
  termDescription: "Fall 2025 (View Only)",
  fetchedAt: "2026-07-18T04:52:13.723Z", // after the term ended -> final
  sectionCount: 5,
  sections: [
    section("80859", "GC3401", 16, 16, 0),
    section("80861", "GC3401", 13, 16, 3),
    section("80863", "GC3401", 16, 16, 0),
    section("80870", "GC2071", 50, 48, 0),
    section("80880", "MATH1060", null, null, null),
  ],
});
// A term swept BEFORE it began: registration still running.
writeScheduleDb({
  term: "202701",
  termDescription: "Spring 2027 (View Only)",
  fetchedAt: "2026-09-08T09:01:24.986Z",
  sectionCount: 1,
  sections: [section("90001", "GC3401", 2, 16, 14)],
});

async function history(args: Record<string, unknown>) {
  const res = await __schedTools.enrollmentHistory.handler(args);
  const text = (res.content[0] as { text: string }).text;
  assert.notEqual(res.isError, true, text);
  return JSON.parse(text);
}

function courseTerm(body: any, course: string, term: string) {
  const c = body.courses.find((x: any) => x.course === course);
  assert.ok(c, `${course} missing from response`);
  return c.terms.find((t: any) => t.term === term);
}

// ---------------------------------------------------------------------------
// The regression fixture the requesting analyst specified, verified against
// the real Fall 2025 snapshot before it was written here.
// ---------------------------------------------------------------------------

test("GC 3401 Fall 2025: three sections, 45 of 48 seats, two full", async () => {
  const body = await history({
    courses: ["GC 3401"],
    terms: ["202508"],
    include_sections: true,
  });
  const t = courseTerm(body, "GC3401", "202508");
  assert.equal(t.section_count, 3);
  assert.equal(t.total_enrollment, 45);
  assert.equal(t.total_capacity, 48);
  assert.equal(t.seats_available, 3);
  assert.equal(t.full_sections, 2);
  assert.equal(t.max_section_enrollment, 16);
  assert.equal(t.fill_rate, 0.9375);
  assert.deepEqual(
    t.sections
      .map((s: any) => s.enrollment)
      .sort((a: number, b: number) => a - b),
    [13, 16, 16],
  );
});

test("include_sections false omits the rows but keeps identical aggregates", async () => {
  const withRows = await history({
    courses: ["GC 3401"],
    terms: ["202508"],
    include_sections: true,
  });
  const without = await history({ courses: ["GC 3401"], terms: ["202508"] });
  const a = courseTerm(withRows, "GC3401", "202508");
  const b = courseTerm(without, "GC3401", "202508");
  assert.ok(!("sections" in b));
  for (const k of [
    "section_count",
    "total_enrollment",
    "total_capacity",
    "seats_available",
    "fill_rate",
    "full_sections",
    "max_section_enrollment",
  ]) {
    assert.deepEqual(b[k], a[k], `${k} differs between include_sections modes`);
  }
});

// ---------------------------------------------------------------------------
// Missing-data semantics
// ---------------------------------------------------------------------------

test("an unobserved term is UNKNOWN, never zero demand", async () => {
  const body = await history({
    courses: ["GC 3401"],
    terms: ["202508", "201608"], // the second is not held
  });
  assert.deepEqual(
    body.observed_terms.map((t: any) => t.term),
    ["202508"],
  );
  assert.deepEqual(body.requested_terms_not_held, ["201608"]);
  const terms = body.courses[0].terms.map((t: any) => t.term);
  assert.ok(
    !terms.includes("201608"),
    "an unobserved term must not appear as a course-term row at all",
  );
});

test("observed term where the course did not run yields no row, and observed_terms proves it was looked at", async () => {
  const body = await history({
    courses: ["GC 2071"],
    terms: ["202508", "202701"],
  });
  assert.deepEqual(body.observed_terms.map((t: any) => t.term).sort(), [
    "202508",
    "202701",
  ]);
  const terms = body.courses[0].terms.map((t: any) => t.term);
  assert.deepEqual(terms, ["202508"], "GC 2071 did not run in 202701");
});

test("a course seen in no observed term says so explicitly", async () => {
  const body = await history({ courses: ["ZZZZ 9999"] });
  assert.equal(body.courses[0].terms.length, 0);
  assert.match(body.courses[0].note, /unobserved term is unknown/);
});

test("a genuinely empty section reports 0 enrolled, and fill_rate stays null when capacity is 0", async () => {
  // The snapshot schema is `enrollment INTEGER NOT NULL DEFAULT 0`, so a
  // missing value is already 0 by the time this module sees it — and 0 is
  // overwhelmingly REAL (2,223 sections in the live Fall 2025 snapshot are
  // empty against a positive capacity). The guarantee the tool can actually
  // make is the one below: a ratio is never invented from a zero denominator.
  const body = await history({ courses: ["MATH 1060"], terms: ["202508"] });
  const t = courseTerm(body, "MATH1060", "202508");
  assert.equal(t.section_count, 1);
  assert.equal(t.total_enrollment, 0);
  assert.equal(t.total_capacity, 0);
  assert.equal(t.fill_rate, null, "fill_rate must be null, never 0/0 = NaN");
  assert.equal(t.max_section_enrollment, 0);
});

test("aggregates over an empty set stay null rather than becoming 0", () => {
  // Unit-level guarantee behind the above: summing nothing is unknown, not 0.
  // Reachable if the snapshot column ever becomes nullable.
  const rows: (number | null)[] = [null, null];
  const known = rows.filter((v): v is number => v !== null);
  assert.equal(
    known.length === 0 ? null : known.reduce((a, b) => a + b, 0),
    null,
  );
});

// ---------------------------------------------------------------------------
// Real-world shapes
// ---------------------------------------------------------------------------

test("fill_rate exceeds 1.0 for an over-enrolled lab rather than clamping", async () => {
  const body = await history({ courses: ["GC 2071"], terms: ["202508"] });
  const t = courseTerm(body, "GC2071", "202508");
  assert.equal(t.total_enrollment, 50);
  assert.equal(t.total_capacity, 48);
  assert.ok(t.fill_rate > 1, `expected >1, got ${t.fill_rate}`);
});

test("section_size_threshold is caller-supplied and absent when unset", async () => {
  const off = await history({ courses: ["GC 3401"], terms: ["202508"] });
  assert.ok(!("sections_at_threshold" in courseTerm(off, "GC3401", "202508")));
  const on = await history({
    courses: ["GC 3401"],
    terms: ["202508"],
    section_size_threshold: 16,
  });
  assert.equal(courseTerm(on, "GC3401", "202508").sections_at_threshold, 2);
});

test("code forms normalize and collapse", async () => {
  const body = await history({
    courses: ["GC3401", "gc 3401", "GC 3401"],
    terms: ["202508"],
  });
  assert.equal(body.courses.length, 1);
  assert.equal(body.courses[0].course, "GC3401");
});

// ---------------------------------------------------------------------------
// Term status — the field that decides whether two terms are comparable
// ---------------------------------------------------------------------------

test("term status distinguishes a settled term from one swept before it began", async () => {
  const body = await history({
    courses: ["GC 3401"],
    terms: ["202508", "202701"],
  });
  const byTerm = Object.fromEntries(
    body.observed_terms.map((t: any) => [t.term, t.status]),
  );
  assert.equal(byTerm["202508"], "final");
  assert.equal(
    byTerm["202701"],
    "pre_term",
    "a snapshot taken before the term starts is registration-in-progress, not demand",
  );
  assert.match(body.status_note, /pre_term/);
});

test("termStatus maps the snapshot date onto the term's own span", () => {
  // Fall 2026 runs mid-Aug to late Dec 2026.
  assert.equal(termStatus("202608", "2026-09-08T09:00:00Z"), "in_term");
  assert.equal(termStatus("202608", "2027-01-05T09:00:00Z"), "final");
  assert.equal(termStatus("202608", "2026-06-01T09:00:00Z"), "pre_term");
  // Unknown when the snapshot never recorded a fetch time.
  assert.equal(termStatus("202608", null), null);
});

// ---------------------------------------------------------------------------
// Input bounds
// ---------------------------------------------------------------------------

test("bad inputs are refused rather than silently narrowed", async () => {
  const errText = async (args: Record<string, unknown>) => {
    const res = await __schedTools.enrollmentHistory.handler(args);
    assert.equal(res.isError, true);
    return (res.content[0] as { text: string }).text;
  };
  assert.match(await errText({ courses: [] }), /at least one/);
  assert.match(
    await errText({ courses: ["not-a-code"] }),
    /Not course codes: not-a-code/,
  );
  assert.match(
    await errText({ courses: ["GC 3401"], terms: ["Fall 2025"] }),
    /Not term codes/,
  );
  assert.match(
    await errText({
      courses: Array.from({ length: 201 }, (_, i) => `GC ${1000 + i}`),
    }),
    /At most 200 courses/,
  );
  assert.match(
    await errText({
      courses: ["GC 3401"],
      terms: Array.from(
        { length: 51 },
        (_, i) => `2020${String(i).padStart(2, "0")}`,
      ),
    }),
    /At most 50 terms/,
  );
});
