// A tripwire for DEPARTMENT POLICY DOCS — the one served surface with no
// other check on it.
//
// WHY (2026-09-11). departments/gc/SKILL.md said the GC internships "must be in
// the summer". The real rule is that at most ONE of GC 3500 / GC 4500 may be —
// each can be fall, spring or summer. The advisor served that bullet through
// get-department-doc and quoted it to force a spring-GC-3500 student's GC 4500
// into a term they did not need. The doc was WORSE THAN ABSENT: a plausible,
// confidently-stated wrong rule that nothing downstream questioned.
//
// Served SKILL docs already have a guard — test/skill-doc-limitations.test.ts
// fails on any toolset change and forces a human to re-read the limitations.
// Department docs had none, and they are precisely the files asserting rules
// NO test can derive: they come from conversations with a program owner, not
// from catalog data. Nothing in this repository observes a policy change.
//
// So this file checks the two things that CAN be checked mechanically:
//
//   1. FRESHNESS. Every department doc carries a dated review stamp. Policy
//      drifts silently, and the only real defence is a person re-confirming
//      it — so the test forces that on a catalog-year cadence rather than
//      pretending an automated check could verify a rule.
//
//   2. CITED COURSES EXIST. A doc naming a course the catalog does not have is
//      stale in a way that IS derivable. Clemson renumbers (MGT 4230 became
//      MGT 3030 in Fall 2024, observed in the registrar audits), and a policy
//      bullet citing the old code keeps reading perfectly while being wrong.
//
// What this CANNOT catch is the internship bug itself — a well-formed rule
// about real courses that is simply not the policy. Only the owner can. That
// is the point of the date: it puts a human back in the loop on a schedule,
// because there is no oracle for "is this still true?".
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DEPT_DIR = "departments";
const CATALOG_DB = process.env.CATALOG_DB || "core/db/catalog.db";

/**
 * How long a department policy statement may stand unreviewed.
 *
 * A little over a catalog year: the catalog turns annually, so a doc reviewed
 * during one cycle should not start failing partway through the next. Long
 * enough not to nag, short enough that no rule survives two catalog years
 * without a person looking at it again.
 */
const MAX_REVIEW_AGE_DAYS = 400;

/**
 * `<!-- policy-reviewed: 2026-09-11 by C. Tonkin (GC program owner) -->`
 * or, for a doc that records no policy at all:
 * `<!-- policy-reviewed: 2026-09-11 no-policy-asserted -->`
 *
 * The second form still carries a date on purpose. "This department has no
 * recorded policy" is itself a claim that goes stale — a department can adopt
 * a rule while the document keeps quietly saying nothing is recorded.
 */
const STAMP_RE =
  /<!--\s*policy-reviewed:\s*(\d{4}-\d{2}-\d{2})\s+(no-policy-asserted|by\s+(.+?))\s*-->/;

function deptDocs(): Array<{ dept: string; file: string; text: string }> {
  return fs
    .readdirSync(DEPT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      dept: d.name,
      file: path.join(DEPT_DIR, d.name, "SKILL.md"),
    }))
    .filter((d) => fs.existsSync(d.file))
    .map((d) => ({ ...d, text: fs.readFileSync(d.file, "utf-8") }));
}

const DOCS = deptDocs();

test("there is at least one department doc to check", () => {
  assert.ok(DOCS.length > 0, "no departments/*/SKILL.md found");
});

for (const { dept, file, text } of DOCS) {
  test(`${dept}: carries a dated policy-review stamp`, () => {
    const m = STAMP_RE.exec(text);
    assert.ok(
      m,
      `${file} has no review stamp. Department policy comes from a program ` +
        `owner, not from data, so nothing else can tell when it went stale. ` +
        `Add:\n` +
        `  <!-- policy-reviewed: YYYY-MM-DD by <name> -->\n` +
        `or, if the document records no policy:\n` +
        `  <!-- policy-reviewed: YYYY-MM-DD no-policy-asserted -->`,
    );
  });

  test(`${dept}: the review is recent enough to still be trusted`, () => {
    const m = STAMP_RE.exec(text);
    assert.ok(m, `${file}: no stamp (see the previous test)`);
    const reviewed = new Date(`${m![1]}T00:00:00Z`);
    assert.ok(!Number.isNaN(reviewed.getTime()), `${file}: unparseable date`);
    const ageDays = (Date.now() - reviewed.getTime()) / 86_400_000;
    assert.ok(
      ageDays >= -1,
      `${file}: review date ${m![1]} is in the future — a stamp is a record ` +
        `of a review that happened, never a promise of one`,
    );
    assert.ok(
      ageDays <= MAX_REVIEW_AGE_DAYS,
      `${file}: last reviewed ${m![1]}, ${Math.round(ageDays)} days ago ` +
        `(limit ${MAX_REVIEW_AGE_DAYS}). RE-CONFIRM THIS DOCUMENT WITH THE ` +
        `PROGRAM OWNER, then update the stamp. Do not just bump the date: the ` +
        `defect this guards against is a rule that reads perfectly and is not ` +
        `the policy (2026-09-11, GC internships).`,
    );
  });

  test(`${dept}: every course code it cites exists in the catalog`, () => {
    if (!fs.existsSync(CATALOG_DB)) return; // catalog not built in this checkout
    const codes = [...new Set(text.match(/\b[A-Z]{2,5} \d{4}\b/g) ?? [])];
    if (codes.length === 0) return;
    const db = new Database(CATALOG_DB, { readonly: true });
    try {
      const stmt = db.prepare("SELECT 1 FROM course WHERE code = ? LIMIT 1");
      const missing = codes.filter((c) => stmt.get(c) === undefined);
      assert.deepEqual(
        missing,
        [],
        `${file} cites course codes the catalog does not have: ` +
          `${missing.join(", ")}. Clemson renumbers courses (MGT 4230 became ` +
          `MGT 3030 in Fall 2024), and a policy bullet citing a retired code ` +
          `reads perfectly while being wrong.`,
      );
    } finally {
      db.close();
    }
  });
}
