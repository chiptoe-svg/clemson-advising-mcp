import assert from "node:assert/strict";
import test from "node:test";
import { selectRefreshTerms } from "../src/clemson-classes.ts";

// The exact getTerms shape observed 2026-08-26: Spring 2027 is published but
// View Only, so the old rule never snapshotted it (review F3).
const TERMS = [
  { code: "202701", description: "Spring 2027 (View Only)" },
  { code: "202608", description: "Fall 2026" },
  { code: "202605", description: "Summer 2026 (View Only)" },
  { code: "202601", description: "Spring 2026 (View Only)" },
];

test("refreshes the live term AND a published future View-Only term, not past ones", () => {
  assert.deepEqual(selectRefreshTerms(TERMS).map((t) => t.code), ["202701", "202608"]);
});

test("with no live term at all, nothing is refreshed (getTerms degraded)", () => {
  const allViewOnly = TERMS.map((t) => ({ ...t, description: t.description.replace(/ \(View Only\)|$/, " (View Only)") }));
  // every term View Only → maxLive 0 → every code > 0 would match; guard: no live term means no refresh
  const picked = selectRefreshTerms(allViewOnly.filter((t) => /View Only/.test(t.description)));
  assert.deepEqual(picked.map((t) => t.code), []);
});

test("two live terms plus one future View-Only term", () => {
  const terms = [
    { code: "202701", description: "Spring 2027 (View Only)" },
    { code: "202608", description: "Fall 2026" },
    { code: "202605", description: "Summer 2026" },
  ];
  assert.deepEqual(selectRefreshTerms(terms).map((t) => t.code), ["202701", "202608", "202605"]);
});
