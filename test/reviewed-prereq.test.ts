// Reviewed prerequisite corrections reach EVERY prerequisite answer, not only
// get-program-graph. Cob_advisor 2026-10-20: "finished GC 1010, 1020, 1040 —
// can she take GC 2070?" went 0/4 on RCD qwen3.8-27b. Every trial called
// get-course-details, read the catalog wording, and said yes; the reviewed
// rule (GC 1050 also required) lived only in the graph. The reverse lookup
// was wrong both ways too: GC 1050 did not list GC 2070, and COOP 1010 still
// listed GC 3020 after the review removed it. Runs on the committed catalog.db.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-"));

const { getCourseDetails, getCourseFacts } =
  await import("../src/mcp-tools/core-search.ts");
const { getCourse } = await import("../src/mcp-tools/catalog.ts");

async function body(
  tool: { handler: (a: Record<string, unknown>) => Promise<unknown> },
  args: Record<string, unknown>,
) {
  const res = (await tool.handler(args)) as {
    isError?: boolean;
    content: { text: string }[];
  };
  assert.equal(res.isError, undefined, res.content[0].text);
  return JSON.parse(res.content[0].text);
}

test("get-course-details carries the reviewed correction next to the catalog wording", async () => {
  const b = await body(getCourseDetails, { course_code: "GC 2070" });
  assert.match(b.review_note, /GC 1050/);
  assert.match(b.reviewed_prereq, /GC 1050/);
  assert.match(b.prereq_text, /GC 1040/, "catalog wording stays, verbatim");
});

test("a course with no reviewer note gets no review fields", async () => {
  const b = await body(getCourseDetails, { course_code: "GC 3400" });
  assert.equal(b.review_note, undefined);
  assert.equal(b.reviewed_prereq, undefined);
});

test("get-course-facts carries it too", async () => {
  const b = await body(getCourseFacts, { courses: ["GC 2070", "GC 3020"] });
  const by = Object.fromEntries(
    (b.courses as { code: string }[]).map((c) => [c.code, c]),
  ) as Record<string, { review_note?: string }>;
  assert.match(by["GC 2070"].review_note ?? "", /GC 1050/);
  assert.match(by["GC 3020"].review_note ?? "", /COOP 1010/);
});

test("catalog get-course carries it too", async () => {
  const b = await body(getCourse, { course: "GC 2070" });
  assert.match(b.review_note, /GC 1050/);
});

test("reverse lookup follows the reviewed rule: GC 1050 is a prerequisite for GC 2070", async () => {
  const b = await body(getCourse, {
    course: "GC 1050",
    dependents_subject: "GC",
  });
  const d = (
    b.prerequisite_for.dependents as { code: string; review_note?: string }[]
  ).find((x) => x.code === "GC 2070");
  assert.ok(d, JSON.stringify(b.prerequisite_for));
  assert.match(
    d!.review_note ?? "",
    /GC 1050/,
    "the wording alone would not show why",
  );
});

test("reverse lookup drops what the review removed: COOP 1010 is not a prerequisite for GC 3020", async () => {
  const b = await body(getCourse, {
    course: "COOP 1010",
    dependents_subject: "GC",
  });
  const codes = (b.prerequisite_for.dependents as { code: string }[]).map(
    (x) => x.code,
  );
  assert.ok(!codes.includes("GC 3020"), codes.join(", "));
});

test("both servers give the same reverse answer", async () => {
  const a = await body(getCourse, { course: "GC 1050" });
  const b = await body(getCourseDetails, { course_code: "GC 1050" });
  assert.deepEqual(a.prerequisite_for, b.prerequisite_for);
});

// --- prereq_expr on get-course-facts (2026-10-27) ----------------------------
// The advisor's graduation planner reads get-course-facts and had to guess a
// rule's structure from prereq_text; it gives up on any rule mixing "and" with
// "or" (373 catalog rules), so GC 4500 reached it as "undetermined". Every
// course with a current reviewed rule now carries the structured expression,
// whether or not the reviewer left a note worth telling the student.

test("get-course-facts: prereq_expr for every reviewed rule, note or not", async () => {
  const b = await body(getCourseFacts, {
    courses: ["GC 4500", "GC 2070", "GC 2990"],
  });
  const by = Object.fromEntries(
    (b.courses as { code: string }[]).map((c) => [c.code, c]),
  ) as Record<
    string,
    { prereq_expr?: string; review_note?: string; reviewed_prereq?: string }
  >;
  // A rule with no shown note: expression only, no correction fields.
  assert.equal(
    by["GC 4500"].prereq_expr,
    "GC 3500 & (GC 4060 | GC 4400) & ~COOP 2020",
  );
  assert.equal(by["GC 4500"].review_note, undefined);
  assert.equal(by["GC 4500"].reviewed_prereq, undefined);
  // A correction: the expression AND the fields that tell the student.
  assert.match(by["GC 2070"].prereq_expr ?? "", /GC 1050/);
  assert.match(by["GC 2070"].review_note ?? "", /GC 1050/);
  // No reviewed rule: absent, so the caller falls back to prereq_text.
  assert.equal(by["GC 2990"].prereq_expr, undefined);
});
