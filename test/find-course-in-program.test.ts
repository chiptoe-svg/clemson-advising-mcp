// find-course-in-program (2026-08-27).
//
// Regression origin: "what is the PCID requirement for GC students" was
// answered "no such requirement exists". PCID 3040/3140 is a real one-of choice
// slot in the GC plan; the advisor had called only get-gc-requirement-rules,
// which reads the OTHER store. These tests pin that a course question is now
// answerable from one call, and — just as important — that a not-found is
// distinguishable from a wrong-store miss.

import assert from "node:assert/strict";
import test from "node:test";

import { findCourseInProgram } from "../src/mcp-tools/catalog.ts";
import { SKIP_NO_CORE_DB, requireArtifacts } from "./_artifacts.ts";

requireArtifacts("core-db");

const GC = "Graphic Communications, BS";
const YEAR = "2025-2026";

async function find(args: Record<string, unknown>) {
  const r = (await findCourseInProgram.handler(args)) as {
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  const text = r.content?.[0]?.text ?? "";
  return { raw: r, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

test("finds PCID as a choice slot in the GC plan — the case that regressed", { skip: SKIP_NO_CORE_DB }, async () => {
  const { json } = await find({ course: "PCID", program: GC, catalog_year: YEAR });
  assert.equal(json.found, true, "PCID must be found; answering 'no such requirement' was the bug");
  assert.equal(json.plan_appearances.length, 1);
  const slot = json.plan_appearances[0];
  assert.equal(slot.kind, "choice");
  assert.deepEqual(slot.choose_one_of, ["PCID 3040", "PCID 3140"]);
  assert.equal(slot.credits, 3);
  assert.equal(slot.where, "Junior/Second Semester");
});

test("a full course code resolves to the same slot", { skip: SKIP_NO_CORE_DB }, async () => {
  const { json } = await find({ course: "PCID 3040", program: GC, catalog_year: YEAR });
  assert.equal(json.found, true);
  assert.equal(json.matched_as, "course_code");
  assert.deepEqual(json.plan_appearances[0].choose_one_of, ["PCID 3040", "PCID 3140"]);
});

test("input is normalised (case, missing space, padding)", { skip: SKIP_NO_CORE_DB }, async () => {
  for (const raw of ["pcid3040", "  PcId  3040 ", "PCID  3040"]) {
    const { json } = await find({ course: raw, program: GC, catalog_year: YEAR });
    assert.equal(json.query, "PCID 3040", `${raw} should normalise`);
    assert.equal(json.found, true, `${raw} should be found`);
  }
});

test("a genuine absence is reported as authoritative, not as a shrug", { skip: SKIP_NO_CORE_DB }, async () => {
  const { json } = await find({ course: "BASKET 9999", program: GC, catalog_year: YEAR });
  assert.equal(json.found, false);
  assert.deepEqual(json.plan_appearances, []);
  assert.deepEqual(json.requirement_rule_mentions, []);
  // The note is the point: it tells the model both stores were searched, so it
  // does not repeat the "absent from my one query => does not exist" inference.
  assert.match(json._note, /covered BOTH/);
});

test("catalog_year defaults to the program's newest when omitted", { skip: SKIP_NO_CORE_DB }, async () => {
  const { json } = await find({ course: "PCID", program: GC });
  assert.ok(json.catalog_year, "a year must be resolved");
  assert.notEqual(json.catalog_year, "", "must not fall back to empty");
  assert.equal(json.found, true);
});

test("a missing program is refused with the standard message", async () => {
  const { raw, text } = await find({ course: "PCID" });
  assert.equal(raw.isError, true);
  assert.match(text, /program/i);
});

test("a malformed course argument is refused, not silently matched", async () => {
  for (const bad of ["", "   ", "!!!", "12345"]) {
    const { raw } = await find({ course: bad, program: GC, catalog_year: YEAR });
    assert.equal(raw.isError, true, `${JSON.stringify(bad)} should be refused`);
  }
});

test("the tool description tells the model a single-store not-found is not evidence", () => {
  const d = findCourseInProgram.tool.description ?? "";
  assert.match(d, /both/i);
  assert.match(d, /find-course-in-program|subject/i);
});
