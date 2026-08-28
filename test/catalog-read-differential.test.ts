// Differential test: src/catalog-read.ts (Node) vs core/scripts/query.py (Python).
//
// This is the verification that matters for the port. The new implementation is
// NOT checked against tests its author wrote from the same mental model that
// produced it — it is checked against the implementation it replaces, across the
// entire corpus. The Python was written at another time, from the catalog, by
// someone else; that is what makes it a decorrelated oracle (working rule 9).
//
// Any difference is a defect in the Node port until proven otherwise.
//
// Skips without the core DB or the Python venv, like every other artifact-
// dependent test; REQUIRE_ARTIFACTS=1 (npm run test:gate) turns those skips into
// hard failures so the port can never be "verified" by a suite that quietly
// skipped it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  GC_ADVISOR_DB,
  GC_ADVISOR_PYTHON,
  GC_ADVISOR_QUERY,
} from "../src/config.ts";
import {
  getCourse,
  getGenEd,
  getProgramPlan,
  getRequirementRules,
  listCatalogYears,
  openCatalog,
} from "../src/catalog-read.ts";
import { SKIP_NO_CORE_DB, SKIP_NO_CORE_PYTHON, requireArtifacts } from "./_artifacts.ts";

requireArtifacts("core-db", "core-python");

const SKIP = SKIP_NO_CORE_DB || SKIP_NO_CORE_PYTHON;

/** Run the Python CLI and parse its JSON. Returns null on a non-zero exit. */
function python(args: string[]): unknown {
  try {
    const out = execFileSync(GC_ADVISOR_PYTHON, [GC_ADVISOR_QUERY, "--db", GC_ADVISOR_DB, ...args], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Deep-compare after normalising key order. Property ORDER differs freely
 * between JSON.stringify in two languages and carries no meaning; property
 * PRESENCE and values carry all of it.
 */
function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = normalise((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

function assertSame(node: unknown, py: unknown, what: string): void {
  assert.deepEqual(normalise(node), normalise(py), `${what}: Node output differs from Python`);
}

test("listCatalogYears matches query.py years", { skip: SKIP }, () => {
  const db = openCatalog(GC_ADVISOR_DB);
  try {
    assertSame(listCatalogYears(db), python(["years"]), "years");
  } finally {
    db.close();
  }
});

test("getProgramPlan matches query.py for EVERY program x catalog year", { skip: SKIP }, () => {
  const db = openCatalog(GC_ADVISOR_DB);
  try {
    const pairs = db
      .prepare(
        `SELECT p.name AS name, cy.label AS year
           FROM program p JOIN catalog_year cy ON cy.id = p.catalog_year_id
          WHERE p.kind IN ('major','pre_business')
          ORDER BY cy.label, p.name`,
      )
      .all() as Array<{ name: string; year: string }>;
    assert.ok(pairs.length > 0, "expected program-years to compare");

    let compared = 0;
    for (const { name, year } of pairs) {
      const py = python(["program-plan", "--year", year, "--name", name]);
      if (py === null) continue; // Python refused this pair; nothing to compare
      assertSame(getProgramPlan(db, year, name), py, `program-plan ${name} ${year}`);
      compared++;
    }
    // A silently-empty comparison would make this test decorative.
    assert.ok(compared > 0, "no program-plan pairs were actually compared");
    console.log(`      compared ${compared} program-plan pairs`);
  } finally {
    db.close();
  }
});

test("getRequirementRules matches query.py for EVERY program x catalog year", { skip: SKIP }, () => {
  const db = openCatalog(GC_ADVISOR_DB);
  try {
    const pairs = db
      .prepare(
        `SELECT p.name AS name, cy.label AS year
           FROM program p JOIN catalog_year cy ON cy.id = p.catalog_year_id
          WHERE p.kind IN ('major','pre_business')
          ORDER BY cy.label, p.name`,
      )
      .all() as Array<{ name: string; year: string }>;

    let compared = 0;
    for (const { name, year } of pairs) {
      const py = python(["req-rules", "--year", year, "--name", name]);
      if (py === null) continue;
      // This is the case that carries semantics: the bogus filter (materialised
      // in requirement_rule_effective) and the advisor allow/deny merge.
      assertSame(getRequirementRules(db, year, name), py, `req-rules ${name} ${year}`);
      compared++;
    }
    assert.ok(compared > 0, "no req-rules pairs were actually compared");
    console.log(`      compared ${compared} req-rules pairs`);
  } finally {
    db.close();
  }
});

test("getGenEd matches query.py for every catalog year", { skip: SKIP }, () => {
  const db = openCatalog(GC_ADVISOR_DB);
  try {
    let compared = 0;
    for (const year of listCatalogYears(db)) {
      const py = python(["gen-ed", "--year", year]);
      if (py === null) continue;
      assertSame(getGenEd(db, year), py, `gen-ed ${year}`);
      compared++;
    }
    assert.ok(compared > 0, "no gen-ed years were actually compared");
    console.log(`      compared ${compared} gen-ed years`);
  } finally {
    db.close();
  }
});

test("getCourse matches query.py across a sample of real course codes", { skip: SKIP }, () => {
  const db = openCatalog(GC_ADVISOR_DB);
  try {
    const codes = (
      db.prepare("SELECT code FROM course ORDER BY code LIMIT 40").all() as Array<{ code: string }>
    ).map((r) => r.code);
    assert.ok(codes.length > 0);
    for (const code of codes) {
      const py = python(["course", "--code", code]);
      if (py === null) continue;
      assertSame(getCourse(db, code), py, `course ${code}`);
    }
    // A code that does not exist must be null in both, not an error in one.
    assertSame(getCourse(db, "ZZZZ 9999"), python(["course", "--code", "ZZZZ 9999"]), "course ZZZZ 9999");
  } finally {
    db.close();
  }
});

test("an unknown year and an unknown program both throw, as Python raises KeyError", { skip: SKIP }, () => {
  const db = openCatalog(GC_ADVISOR_DB);
  try {
    assert.throws(() => getProgramPlan(db, "1899-1900", "Anything"), /Unknown catalog year/);
    const year = listCatalogYears(db)[0]!;
    assert.throws(() => getProgramPlan(db, year, "No Such Program"), /No program/);
    assert.throws(() => getRequirementRules(db, year, "No Such Program"), /No program/);
  } finally {
    db.close();
  }
});

test("the differential harness would actually catch a difference", { skip: SKIP }, () => {
  // Red-proof for the comparison itself: if assertSame silently passed on
  // mismatched input, every test above would be decorative.
  assert.throws(() => assertSame({ a: 1 }, { a: 2 }, "sanity"));
  assert.throws(() => assertSame([1, 2], [1], "sanity"));
  // ...but key ORDER must not be treated as a difference.
  assert.doesNotThrow(() => assertSame({ a: 1, b: 2 }, { b: 2, a: 1 }, "sanity"));
});
