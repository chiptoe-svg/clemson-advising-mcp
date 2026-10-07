// get-program-graph, end to end on the committed catalog.db (with the
// reviewed prerequisite rules loaded). STATE_DIR points at an empty temp
// dir, so no schedule snapshots exist: seasons must be omitted with a note,
// never invented.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "program-graph-tool-"));
process.env.STATE_DIR = STATE;

const { programGraph } = await import("../src/mcp-tools/program-graph.ts");

type Course = {
  code: string;
  min_prior_terms: number;
  status?: string;
  assumes?: string[];
  seasons?: unknown;
};

async function call(args: Record<string, unknown>) {
  const res = (await programGraph.handler(args)) as {
    isError?: boolean;
    content: { text: string }[];
  };
  return { res, body: res.isError ? null : JSON.parse(res.content[0].text) };
}

const GC = { program: "Graphic Communications, BS", catalog_year: "2026-2027" };

test("a major-year graph: Degree Works requirements, chains, a critical path", async () => {
  const { res, body } = await call(GC);
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.equal(body.requirement_source, "degree_works");
  const gc4480 = (body.courses as Course[]).find((c) => c.code === "GC 4480")!;
  assert.ok(gc4480.min_prior_terms >= 3);
  assert.ok(body.critical_path.length >= 3);
});

test("the response fits a small model's budget", async () => {
  const { res } = await call(GC);
  assert.ok(
    res.content[0].text.length <= 20000,
    `${res.content[0].text.length} bytes — trim fields, don't raise the budget`,
  );
});

test("a year with no Degree Works import says so and uses the plan", async () => {
  const { body } = await call({ ...GC, catalog_year: "2020-2021" });
  assert.equal(body.requirement_source, "catalog_plan");
  assert.ok(
    (body.notes as string[]).some((n) => /No Degree Works import/.test(n)),
  );
});

test("completed courses: messy codes normalized, bad entries reported, not guessed", async () => {
  const { body } = await call({
    ...GC,
    completed_courses: [
      "gc1020",
      "GC1040",
      " GC 1010 ",
      "GC1050",
      "not a course",
      "GC 1020:Q",
    ],
  });
  assert.deepEqual(body.ignored_completed, ["not a course", "GC 1020:Q"]);
  const gc2070 = (body.courses as Course[]).find((c) => c.code === "GC 2070")!;
  assert.equal(gc2070.status, "eligible");
});

test("grades: a known low grade blocks; no grade is an explicit assumption", async () => {
  const acct = { program: "Accounting, BS", catalog_year: "2026-2027" };
  const low = await call({ ...acct, completed_courses: ["ACCT 2010:D"] });
  const a = (low.body.courses as Course[]).find((c) => c.code === "ACCT 3030")!;
  assert.equal(a.status, "not_eligible");
  const none = await call({ ...acct, completed_courses: ["ACCT 2010"] });
  const b = (none.body.courses as Course[]).find(
    (c) => c.code === "ACCT 3030",
  )!;
  assert.equal(b.status, "eligible");
  assert.deepEqual(b.assumes, ["C or better in ACCT 2010"]);
});

test("with no schedule history, seasons are omitted with a note — never invented", async () => {
  const { body } = await call(GC);
  assert.ok((body.courses as Course[]).every((c) => c.seasons === undefined));
  assert.ok(
    (body.notes as string[]).some((n) =>
      /offering history unavailable/.test(n),
    ),
  );
});

test("an unknown program is an error that lists the programs", async () => {
  const { res } = await call({
    program: "Underwater Basketry, BS",
    catalog_year: "2026-2027",
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Marketing, BS/);
});

test("an invalid standing is an error, not ignored", async () => {
  const { res } = await call({ ...GC, standing: "super-senior" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /standing/);
});

// --- Hostile-review regressions (2026-10-06) --------------------------------

test("an F does not complete a course, and the entry says why", async () => {
  // Finding 3: "GC 1010:F" counted as completed, so GC 2070 read eligible.
  const { body } = await call({
    ...GC,
    completed_courses: ["GC 1010:F", "GC 1020:F", "GC 1040:F", "GC 1050:F"],
  });
  const gc2070 = (body.courses as Course[]).find((c) => c.code === "GC 2070")!;
  assert.equal(gc2070.status, "not_eligible");
  assert.ok(
    (body.ignored_completed as string[]).some(
      (e) => /GC 1010:F/.test(e) && /F/.test(e),
    ),
  );
});

test("a minor or certificate is refused, never an empty graph", async () => {
  // Finding 7: "Accounting Minor" returned requirements [] and courses [].
  const { res } = await call({
    program: "Accounting Minor",
    catalog_year: "2026-2027",
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /get-program-requirements/);
});

test("completed_courses that is not a list is an error, not silently ignored", async () => {
  // Finding 11: a comma-separated string returned no statuses and no note.
  const { res } = await call({ ...GC, completed_courses: "GC 1010, GC 1020" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /completed_courses/);
});

test("an unknown catalog year says so, not that the program is missing", async () => {
  // Minor 12, re-graded: the error led with "program is required".
  const { res } = await call({ ...GC, catalog_year: "2031-2032" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /catalog year/i);
  assert.doesNotMatch(res.content[0].text, /program is required/);
});
