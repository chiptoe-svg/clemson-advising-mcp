import assert from "node:assert/strict";
import test from "node:test";

import {
  SCOPE_OPERATIONS,
  allExposedOperations,
  expandScopes,
  BASELINE_OPERATIONS,
  isValidScopeToken,
} from "../src/mcp-tools/permissions.ts";

test("isValidScopeToken accepts clemson and host, rejects unknown/removed ones", () => {
  assert.equal(isValidScopeToken("clemson"), true);
  assert.equal(isValidScopeToken("host"), true);
  assert.equal(isValidScopeToken("bogus"), false);
  // mail:read was a valid scope before the mailcal split; it must not survive.
  assert.equal(isValidScopeToken("mail:read"), false);
});

test("expandScopes(undefined) returns the full exposed set", () => {
  assert.deepEqual(expandScopes(undefined), allExposedOperations());
  assert.deepEqual(expandScopes([]), allExposedOperations());
});

// The full enumeration of what "clemson" grants used to be hand-pinned here;
// that is exactly what test/mcp-registry-consistency.test.ts now checks
// structurally (every MCP_ALLOWED_OPERATIONS key is covered by some scope,
// and vice versa) — so this only keeps the property a registry-wide equality
// check can't express: that "clemson" grants clemson.* operations plus the
// shared baseline and NOTHING else. The skill-doc operations were once kept
// out of it; since 2026-09-25 they are baseline for every recognized scope
// (see BASELINE_OPERATIONS for why). What must still never leak is any other
// host.* operation, and department data — the property with a stated harm.
test("expandScopes(['clemson']) grants clemson.* operations plus the baseline, nothing else", () => {
  const s = expandScopes(["clemson"]);
  assert.ok(s.size > 0);
  for (const op of s) {
    assert.ok(
      /^clemson\./.test(op) || BASELINE_OPERATIONS.includes(op),
      `clemson granted ${op}, which is neither clemson.* nor baseline`,
    );
  }
  assert.equal(s.has("clemson.department_rules"), false, "department data must not leak");
  assert.equal(s.has("clemson.department_docs"), false, "department docs must not leak");
});

test("expandScopes(['host']) grants only the host.* skill-doc operations", () => {
  const s = expandScopes(["host"]);
  assert.deepEqual(s, new Set(["host.list_skills", "host.get_skill_docs"]));
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
  assert.deepEqual(
    expandScopes(["clemson", "bogus"]),
    expandScopes(["clemson"]),
  );
});
