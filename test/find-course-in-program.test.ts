// find-course-in-program (2026-08-27).
//
// Regression origin: "what is the PCID requirement for GC students" was
// answered "no such requirement exists". PCID 3040/3140 is a real one-of choice
// slot in the GC plan; the advisor had called only get-requirement-rules,
// which reads the OTHER store. These tests pin that a course question is now
// answerable from one call, and — just as important — that a not-found is
// distinguishable from a wrong-store miss.

import assert from "node:assert/strict";
import test from "node:test";

import { findCourseInProgram } from "../src/mcp-tools/catalog.ts";
import { SKIP_NO_CORE_DB, requireCoreArtifacts } from "./_artifacts.ts";

requireCoreArtifacts();

const GC = "Graphic Communications, BS";
const YEAR = "2025-2026";

async function find(args: Record<string, unknown>) {
  const r = (await findCourseInProgram.handler(args)) as {
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  const text = r.content?.[0]?.text ?? "";
  return {
    raw: r,
    text,
    json: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })(),
  };
}

test(
  "finds PCID as a choice slot in the GC plan — the case that regressed",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const { json } = await find({
      course: "PCID",
      program: GC,
      catalog_year: YEAR,
    });
    assert.equal(
      json.found,
      true,
      "PCID must be found; answering 'no such requirement' was the bug",
    );
    assert.equal(json.plan_appearances.length, 1);
    const slot = json.plan_appearances[0];
    assert.equal(slot.kind, "choice");
    assert.deepEqual(slot.choose_one_of, ["PCID 3040", "PCID 3140"]);
    assert.equal(slot.credits, 3);
    assert.equal(slot.where, "Junior/Second Semester");
  },
);

test(
  "a full course code resolves to the same slot",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const { json } = await find({
      course: "PCID 3040",
      program: GC,
      catalog_year: YEAR,
    });
    assert.equal(json.found, true);
    assert.equal(json.matched_as, "course_code");
    assert.deepEqual(json.plan_appearances[0].choose_one_of, [
      "PCID 3040",
      "PCID 3140",
    ]);
  },
);

test(
  "input is normalised (case, missing space, padding)",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    for (const raw of ["pcid3040", "  PcId  3040 ", "PCID  3040"]) {
      const { json } = await find({
        course: raw,
        program: GC,
        catalog_year: YEAR,
      });
      assert.equal(json.query, "PCID 3040", `${raw} should normalise`);
      assert.equal(json.found, true, `${raw} should be found`);
    }
  },
);

// --- rules-only courses (adversarial review, 2026-08-27) ---
//
// THE GAP THIS CLOSES: every original test used PCID (plan-only) or a course
// that is nowhere. Nothing covered a course that exists ONLY in the requirement
// rules — so mutations breaking the rules half of the search survived the whole
// suite. Under them the tool returns `found: false` TOGETHER WITH the note
// saying both stores were searched and the absence is authoritative: a
// fabricated authoritative denial. That is the PCID wrong answer in mirror
// image, with more confidence attached.
//
// PHYS 1220 is such a course in GC 2025-2026: it appears in the Approved
// Laboratory Science Requirement rule and nowhere in the semester plan.

test(
  "finds a course that exists ONLY in the requirement rules",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const { json } = await find({
      course: "PHYS 1220",
      program: GC,
      catalog_year: YEAR,
    });
    assert.equal(json.found, true, "a rules-only course must be found");
    assert.deepEqual(
      json.plan_appearances,
      [],
      "PHYS 1220 is not in the semester plan",
    );
    assert.equal(
      json.requirement_rule_mentions.length,
      1,
      "it IS in a requirement rule",
    );
    assert.equal(
      json.requirement_rule_mentions[0].slot_type,
      "Approved Laboratory Science Requirement",
    );
    assert.match(json.requirement_rule_mentions[0].rule, /PHYS 1220/);
    assert.equal(
      json._note,
      undefined,
      "a found course must carry NO absence note",
    );
  },
);

test(
  "a rules-only hit still conforms to the mention shape",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    // The outputSchema declares requirement_rule_mentions items as objects with
    // required slot_type and rule. Both conformance cases in
    // test/mcp-output-schema.test.ts have an EMPTY array, so the item schema was
    // never entered and renaming these keys passed. This exercises it non-empty.
    const { json } = await find({
      course: "PHYS 1220",
      program: GC,
      catalog_year: YEAR,
    });
    for (const m of json.requirement_rule_mentions) {
      assert.equal(typeof m.slot_type, "string");
      assert.equal(typeof m.rule, "string");
      assert.ok(m.slot_type.length > 0 && m.rule.length > 0);
    }
  },
);

test(
  "a subject prefix matches across BOTH stores at once",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    // PHYS appears only in rules for this program-year; the prefix path must
    // reach the rules half too, not just the plan half.
    const { json } = await find({
      course: "PHYS",
      program: GC,
      catalog_year: YEAR,
    });
    assert.equal(json.found, true);
    assert.equal(json.matched_as, "subject_prefix");
    assert.ok(
      json.requirement_rule_mentions.length > 0,
      "subject-prefix search must cover requirement rules",
    );
  },
);

test(
  "plan appearances come back in catalog order",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    // ORDER BY rg.ordering, pi.ordering was unprotected: PCID has a single
    // appearance, so ordering was unobservable everywhere. GC 1010 vs a later
    // course pins that the plan is returned in the order the catalog states.
    const { json } = await find({
      course: "GC",
      program: GC,
      catalog_year: YEAR,
    });
    const wheres = json.plan_appearances.map((a: { where: string }) => a.where);
    assert.ok(wheres.length > 2, "GC should appear in several terms");
    const firstIdx = wheres.findIndex((w: string) => /Freshman|First/i.test(w));
    const lastIdx = wheres
      .map((w: string) => /Senior/i.test(w))
      .lastIndexOf(true);
    if (firstIdx !== -1 && lastIdx !== -1) {
      assert.ok(firstIdx < lastIdx, "earlier terms must precede later ones");
    }
  },
);

test(
  "bogus requirement rules are NEVER surfaced (reads the effective view)",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    // The code comment says "requirement_rule_effective — NEVER the raw table",
    // but swapping it to the raw table survived the whole suite: GC 2025-2026 has
    // no bogus rules, so both reads agree there.
    //
    // GC 2021-2022 does. ENSP 2000 appears in the PLAN, and also in a rule the
    // ingest derived from a footnote which says — verbatim — that ENSP 2000 "may
    // not be used to fulfill" that requirement. is_bogus_rule flags it; the view
    // drops it. Reading the raw table would quote a requirement the registrar
    // never stated, and one whose own source text contradicts it.
    const { json } = await find({
      course: "ENSP 2000",
      program: GC,
      catalog_year: "2021-2022",
    });
    assert.equal(
      json.found,
      true,
      "ENSP 2000 is genuinely in the 2021-2022 plan",
    );
    assert.ok(json.plan_appearances.length > 0);
    const slots = json.requirement_rule_mentions.map(
      (m: { slot_type: string }) => m.slot_type,
    );
    // The BOGUS rule must be absent...
    assert.ok(
      !slots.includes("Arts and Humanities (Non-Lit.) Requirement"),
      `the bogus Arts and Humanities rule must be filtered by the view; got ${JSON.stringify(slots)}`,
    );
    // ...while the legitimate one for the same course is still reported, so this
    // is proving the FILTER works, not merely that the search returned nothing.
    assert.ok(
      slots.includes("Science and Technology in Society Requirement"),
      "the non-bogus rule mentioning ENSP 2000 must still be surfaced",
    );
  },
);

test(
  "a genuine absence is reported as authoritative, not as a shrug",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const { json } = await find({
      course: "BASKET 9999",
      program: GC,
      catalog_year: YEAR,
    });
    assert.equal(json.found, false);
    assert.deepEqual(json.plan_appearances, []);
    assert.deepEqual(json.requirement_rule_mentions, []);
    // The note is the point: it tells the model both stores were searched, so it
    // does not repeat the "absent from my one query => does not exist" inference.
    assert.match(json._note, /covered BOTH/);
  },
);

test(
  "catalog_year defaults to the program's newest when omitted",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const { json } = await find({ course: "PCID", program: GC });
    assert.ok(json.catalog_year, "a year must be resolved");
    assert.notEqual(json.catalog_year, "", "must not fall back to empty");
    assert.equal(json.found, true);
  },
);

test("a missing program is refused with the standard message", async () => {
  const { raw, text } = await find({ course: "PCID" });
  assert.equal(raw.isError, true);
  assert.match(text, /program/i);
});

test("a malformed course argument is refused, not silently matched", async () => {
  for (const bad of ["", "   ", "!!!", "12345"]) {
    const { raw } = await find({
      course: bad,
      program: GC,
      catalog_year: YEAR,
    });
    assert.equal(raw.isError, true, `${JSON.stringify(bad)} should be refused`);
  }
});

test("the tool description tells the model a single-store not-found is not evidence", () => {
  const d = findCourseInProgram.tool.description ?? "";
  assert.match(d, /both/i);
  assert.match(d, /find-course-in-program|subject/i);
});
