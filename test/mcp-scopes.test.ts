import assert from "node:assert/strict";
import test from "node:test";

import {
  SCOPE_OPERATIONS,
  allExposedOperations,
  expandScopes,
  isValidScopeToken,
} from "../src/mcp-tools/permissions.ts";

test("isValidScopeToken accepts the clemson token and rejects unknown/removed ones", () => {
  assert.equal(isValidScopeToken("clemson"), true);
  assert.equal(isValidScopeToken("bogus"), false);
  // mail:read was a valid scope before the mailcal split; it must not survive.
  assert.equal(isValidScopeToken("mail:read"), false);
});

test("expandScopes(undefined) returns the full exposed set", () => {
  assert.deepEqual(expandScopes(undefined), allExposedOperations());
  assert.deepEqual(expandScopes([]), allExposedOperations());
});

test("expandScopes(['clemson']) equals exactly the 14 clemson operations, and excludes host.list_skills", () => {
  const s = expandScopes(["clemson"]);
  const expected = new Set([
    "clemson.list_terms",
    "clemson.search_classes",
    "clemson.find_alternatives",
    "clemson.check_conflicts",
    "clemson.course_details",
    "clemson.find_conflict_free_schedule",
    "clemson.gc_catalog_years",
    "clemson.gc_program_plan",
    "clemson.gc_requirement_rules",
    "clemson.gc_gen_ed",
    "clemson.gc_audit_progress",
    "clemson.find_requirement_sections",
    "clemson.gc_program_requirements",
    "clemson.schedule_freshness",
  ]);
  assert.equal(s.size, 14);
  assert.deepEqual(s, expected);
  assert.equal(s.has("host.list_skills"), false);
});

test("every operation named in SCOPE_OPERATIONS is a real, exposed operation", () => {
  const exposed = allExposedOperations();
  for (const [token, ops] of Object.entries(SCOPE_OPERATIONS)) {
    for (const op of ops) {
      assert.ok(exposed.has(op), `${token} -> ${op} should be exposed`);
    }
  }
});

test("unknown scope tokens contribute nothing (no silent widening)", () => {
  assert.equal(expandScopes(["bogus:write"]).size, 0);
  assert.equal(
    expandScopes(["clemson", "bogus"]).has("clemson.list_terms"),
    true,
  );
  assert.equal(expandScopes(["clemson", "bogus"]).size, 14);
});
