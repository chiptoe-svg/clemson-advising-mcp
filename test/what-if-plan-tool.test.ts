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
