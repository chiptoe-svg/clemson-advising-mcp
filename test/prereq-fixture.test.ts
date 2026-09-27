// test/prereq-fixture.test.ts
// Invariants over the hand-reviewed prerequisite fixture and what was loaded
// from it. They read core/db/catalog.db (tracked in git, so CI has it).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { courseCodes, parsePrereq } from "../src/prereq-expr.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const db = new Database(path.join(ROOT, "core/db/catalog.db"), { readonly: true });
const fixture = JSON.parse(
  fs.readFileSync(path.join(ROOT, "core/prereqs/plan-courses.json"), "utf-8"),
) as Record<string, { text: string; expr: string; note?: string }>;

const PLAN_COURSES_WITH_TEXT = db
  .prepare(
    `WITH pc AS (
       SELECT course_code AS c FROM plan_item WHERE course_code IS NOT NULL
       UNION SELECT j.value FROM plan_item, json_each(plan_item.one_of) j WHERE one_of IS NOT NULL)
     SELECT c.code, c.prereq_text FROM course c JOIN pc ON pc.c = c.code
     WHERE coalesce(trim(c.prereq_text), '') <> '' ORDER BY c.code`,
  )
  .all() as { code: string; prereq_text: string }[];

test("every plan course with prerequisite text has a fixture entry", () => {
  const missing = PLAN_COURSES_WITH_TEXT.filter((r) => !fixture[r.code]).map((r) => r.code);
  assert.deepEqual(missing, []);
});

test("every fixture expression parses", () => {
  for (const [code, e] of Object.entries(fixture)) {
    assert.doesNotThrow(() => parsePrereq(e.expr), code);
  }
});

test("no course code is dropped or invented: expression codes == codes in the source text", () => {
  // Both sides come from the SOURCE, so neither can drift to agree with the other.
  const CODE = /\b([A-Z]{2,5}) ?(\d{4})\b/g;
  for (const [code, e] of Object.entries(fixture)) {
    const inText = [...new Set([...e.text.matchAll(CODE)].map((m) => `${m[1]} ${m[2]}`))].sort();
    const inExpr = [...courseCodes(parsePrereq(e.expr))].sort();
    assert.deepEqual(inExpr, inText, code);
  }
});

test("the loaded table matches the fixture and every row is current", () => {
  const rows = db
    .prepare(
      "SELECT p.code, p.expr, p.source_text_hash, c.prereq_text FROM prereq_expression p JOIN course c USING(code)",
    )
    .all() as { code: string; expr: string; source_text_hash: string; prereq_text: string }[];
  assert.equal(rows.length, Object.keys(fixture).length, "load the fixture: core/scripts/load_prereq_expressions.py");
  for (const r of rows) {
    assert.equal(r.expr, fixture[r.code]?.expr, r.code);
    const h = crypto.createHash("sha256").update(r.prereq_text, "utf8").digest("hex");
    assert.equal(r.source_text_hash, h, `${r.code} is stale`);
  }
});
