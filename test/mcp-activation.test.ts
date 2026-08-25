import assert from "node:assert/strict";
import test from "node:test";

import {
  McpPermissionDeniedError,
  assertMcpOperation,
  isMcpOperationExposed,
} from "../src/mcp-tools/permissions.ts";

// This repo's registry (post mailcal-split prune) declares only clemson.* and
// host.list_skills/host.get_skill_docs, all approval=none. These tests cover
// the generic exposure/assertion behavior — not any surface-specific rule —
// using real ids from the pruned registry.

test("active, approval=none operations are exposed", () => {
  for (const op of [
    "clemson.list_terms",
    "clemson.search_classes",
    "clemson.find_alternatives",
    "clemson.check_conflicts",
    "host.list_skills",
    "host.get_skill_docs",
  ]) {
    assert.equal(isMcpOperationExposed(op), true, `${op} should be exposed`);
  }
});

test("an operation absent from the allow-list is neither exposed nor assertable", () => {
  assert.equal(isMcpOperationExposed("bogus.operation"), false);
  assert.throws(
    () => assertMcpOperation("bogus.operation"),
    (err) =>
      err instanceof McpPermissionDeniedError &&
      /not in the allow-list/.test(err.message),
  );
});

test("assertMcpOperation returns the spec for an exposed operation", () => {
  const spec = assertMcpOperation("clemson.list_terms");
  assert.equal(spec.backend, "external-http");
  assert.equal(spec.policyActionId, "clemson.list_terms");
});

test("public_data_only and local_state_only constraints are unconditional passes", () => {
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.search_classes", {
      input: { subject: "CPSC", term: "202608" },
    }),
  );
  assert.doesNotThrow(() =>
    assertMcpOperation("host.list_skills", { input: {} }),
  );
});
