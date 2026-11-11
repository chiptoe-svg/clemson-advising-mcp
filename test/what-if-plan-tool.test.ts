// test/what-if-plan-tool.test.ts
// what-if-plan end to end on the committed catalog.db. STATE_DIR is an
// empty temp dir, so no offering history exists: the answer must still come
// back, with the every-fall-and-spring assumption stated.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "what-if-plan-"));
process.env.STATE_DIR = STATE;

const { whatIfPlanTool } = await import("../src/mcp-tools/what-if-plan.ts");

const GC = { program: "Graphic Communications, BS", catalog_year: "2026-2027" };

async function call(args: Record<string, unknown>) {
  const res = (await whatIfPlanTool.handler(args)) as {
    isError?: boolean;
    content: { text: string }[];
  };
  return { res, body: res.isError ? null : JSON.parse(res.content[0].text) };
}

test("T8b: GC 3400 two terms later does not slip graduation", async () => {
  const { res, body } = await call({
    ...GC,
    changes: [{ course: "gc3400", delay_terms: 2 }],
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.equal(body.slips_graduation, false);
  assert.match(body.verdict, /does not slip/);
  assert.ok(
    body.moves.some(
      (m: { code: string; to: string }) =>
        m.code === "GC 4440" && m.to === "Senior/Second Semester",
    ),
  );
  assert.ok(
    body.assumptions.some((a: string) => /every fall and spring/.test(a)),
  );
  assert.match(body.caveat, /published/);
});

test("a skipped term is accepted and answered", async () => {
  const { res, body } = await call({
    ...GC,
    changes: [{ skip_term: "Junior/Second Semester" }],
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.equal(typeof body.slips_graduation, "boolean");
  // Nothing may remain in, or be pushed into, the skipped term.
  assert.ok(
    body.moves.every((m: { to: string }) => m.to !== "Junior/Second Semester"),
  );
});

test("malformed changes are errors", async () => {
  for (const changes of [
    [],
    "GC 3400 delay 2",
    [{ course: "GC 3400", skip_term: "Junior/Second Semester" }],
    [{ delay_terms: 2 }],
  ]) {
    const { res } = await call({ ...GC, changes });
    assert.equal(res.isError, true, JSON.stringify(changes));
  }
});

test("a course not in the plan is an error naming it", async () => {
  const { res } = await call({
    ...GC,
    changes: [{ course: "MATH 9999", delay_terms: 1 }],
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /MATH 9999/);
});

test("a completed course cannot be moved", async () => {
  const { res } = await call({
    ...GC,
    changes: [{ course: "GC 3400", delay_terms: 1 }],
    completed_courses: ["GC 3400"],
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /already completed/);
});

test("current_term: a delay is measured from the student's rebased plan", async () => {
  const { res, body } = await call({
    ...GC,
    changes: [{ course: "GC 4400", delay_terms: 1 }],
    current_term: "Senior/First Semester",
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.equal(body.plan_graduation_term, "Senior/Second Semester");
  assert.equal(typeof body.graduation_slip_terms, "number");
  assert.ok(Array.isArray(body.behind));
});

test("current_term alone, with no changes, reports how far behind the student is", async () => {
  const { res, body } = await call({
    ...GC,
    changes: [],
    current_term: "Senior/Second Semester",
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.ok(body.graduation_slip_terms >= 1);
  assert.match(body.verdict, /behind the published plan/);
});

test("completed_courses: an @term marks a GC 3500 taken in summer, for the one-summer rule", async () => {
  const move = (done: string[]) =>
    call({
      ...GC,
      changes: [{ course: "GC 4500", move_to: "Senior/Summer" }],
      completed_courses: done,
    });
  const summer = await move(["GC 3500:B@Summer 2026"]);
  assert.equal(summer.res.isError, true);
  assert.match(summer.res.content[0].text, /only one of GC 3500 and GC 4500/);
  const banner = await move(["GC 3500@202605"]);
  assert.equal(banner.res.isError, true);
  const fall = await move(["GC 3500@Fall 2025"]);
  assert.equal(fall.res.isError, undefined, fall.res.content[0].text);
  // An unreadable term is reported, never guessed.
  const bad = await call({
    ...GC,
    changes: [{ course: "GC 4400", delay_terms: 1 }],
    completed_courses: ["GC 3500@Winter 2026"],
  });
  assert.deepEqual(bad.body.ignored_completed, ["GC 3500@Winter 2026"]);
});

test("review: a GC student far behind gets an answer, in labels the tools accept back", async () => {
  const { slotOf } = await import("../src/plan-whatif.ts");
  const { res, body } = await call({
    ...GC,
    changes: [],
    current_term: "Sixth Year/Second Semester",
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.ok(body.graduation_slip_terms > 0);
  assert.notEqual(slotOf(body.graduation_term), null, body.graduation_term);
});

test("GC's department planning rules apply: GC 4440 follows the second internship", async () => {
  const { res, body } = await call({
    ...GC,
    changes: [{ course: "GC 4500", move_to: "Senior/First Semester" }],
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  const m = body.moves.find((x: { code: string }) => x.code === "GC 4440");
  assert.equal(m?.to, "Senior/Second Semester");
  assert.match(m.because, /GC 4500/);
  assert.ok(
    body.assumptions.some((a: string) =>
      /^Not checked here \(department rule\): An internship term/.test(a),
    ),
    body.assumptions.join(" | "),
  );
});

test("GC 4060 and GC 4400 in one term is a warning, not a move", async () => {
  const { res, body } = await call({
    ...GC,
    changes: [{ course: "GC 4060", move_to: "Junior/Second Semester" }],
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.equal(body.slips_graduation, false);
  assert.match(
    body.department_warnings[0],
    /GC 4060 and GC 4400 are both in Junior\/Second Semester: .*discouraged/,
  );
});
