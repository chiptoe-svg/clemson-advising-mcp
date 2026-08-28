// test/mcp-registry-consistency.test.ts
//
// Cross-checks the three places an MCP operation's identity is declared:
// MCP_ALLOWED_OPERATIONS (the operation registry), SCOPE_OPERATIONS (the
// scope-token vocabulary), and policy/action-policy.yaml (the approval
// gate each operation's policyActionId points at). Drift between these is
// silent at runtime — a scope token that omits an operation just makes it
// unreachable for narrowly-scoped consumers, and a dangling policyActionId
// fails closed inside assertMcpOperation() only when someone finally calls
// it. This test catches both ahead of that.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_ALLOWED_OPERATIONS,
  SCOPE_OPERATIONS,
  expandScopes,
} from "../src/mcp-tools/permissions.ts";
import { getActionPolicy } from "../src/policy.ts";

test("MCP_ALLOWED_OPERATIONS and the union of SCOPE_OPERATIONS agree in both directions", () => {
  const allowed = new Set(Object.keys(MCP_ALLOWED_OPERATIONS));
  const scoped = new Set(Object.values(SCOPE_OPERATIONS).flat());

  const missingFromScopes = [...allowed]
    .filter((op) => !scoped.has(op))
    .sort();
  const extraInScopes = [...scoped].filter((op) => !allowed.has(op)).sort();

  assert.deepEqual(
    missingFromScopes,
    [],
    `operations in MCP_ALLOWED_OPERATIONS but not granted by any ` +
      `SCOPE_OPERATIONS token: ${missingFromScopes.join(", ") || "(none)"}`,
  );
  assert.deepEqual(
    extraInScopes,
    [],
    `operations named in SCOPE_OPERATIONS but not present in ` +
      `MCP_ALLOWED_OPERATIONS: ${extraInScopes.join(", ") || "(none)"}`,
  );
});

test("every MCP_ALLOWED_OPERATIONS.policyActionId exists in the loaded policy's actions", () => {
  const policy = getActionPolicy();
  const actionIds = new Set(policy.actions.map((a) => a.id));

  const missing = Object.entries(MCP_ALLOWED_OPERATIONS)
    .filter(([, spec]) => !actionIds.has(spec.policyActionId))
    .map(([operation, spec]) => `${operation} -> ${spec.policyActionId}`)
    .sort();

  assert.deepEqual(
    missing,
    [],
    `operations whose policyActionId is missing from ` +
      `policy/action-policy.yaml actions: ${missing.join(", ") || "(none)"}`,
  );
});

// --- scope granularity (2026-08-28) -----------------------------------------
//
// Scoping was all-or-nothing until now: `clemson` granted all 15 operations, so
// an agent that only needed class times had to be given the degree catalog and
// the audit engine too. That is the wrong granularity to issue the FIRST
// per-agent tokens at, since anything granted at pairing time tends to be
// grandfathered forever.

test("clemson.schedule and clemson.catalog exactly partition clemson", () => {
  const all = new Set(SCOPE_OPERATIONS["clemson"]);
  const schedule = new Set(SCOPE_OPERATIONS["clemson.schedule"]);
  const catalog = new Set(SCOPE_OPERATIONS["clemson.catalog"]);

  const union = new Set([...schedule, ...catalog]);
  assert.deepEqual(
    [...all].filter((op) => !union.has(op)),
    [],
    "an operation in `clemson` is reachable by no narrow scope — a new tool was " +
      "added without deciding which surface it belongs to",
  );
  assert.deepEqual(
    [...union].filter((op) => !all.has(op)),
    [],
    "a narrow scope grants an operation `clemson` does not",
  );
  // Disjoint: an operation in both would make least-privilege meaningless.
  assert.deepEqual(
    [...schedule].filter((op) => catalog.has(op)),
    [],
    "schedule and catalog scopes must not overlap",
  );
});

test("a schedule-scoped token cannot reach catalog operations", () => {
  const scoped = expandScopes(["clemson.schedule"]);
  assert.ok(scoped.has("clemson.search_classes"), "schedule ops must be granted");
  assert.ok(
    !scoped.has("clemson.gc_program_plan"),
    "a schedule-only agent must not reach the degree catalog",
  );
  assert.ok(
    !scoped.has("clemson.gc_audit_progress"),
    "a schedule-only agent must not reach the audit engine",
  );
});

test("a catalog-scoped token cannot reach schedule operations", () => {
  const scoped = expandScopes(["clemson.catalog"]);
  assert.ok(scoped.has("clemson.gc_program_plan"));
  assert.ok(!scoped.has("clemson.search_classes"));
});

test("both narrow scopes together equal the broad one", () => {
  const both = expandScopes(["clemson.schedule", "clemson.catalog"]);
  const broad = expandScopes(["clemson"]);
  assert.deepEqual([...both].sort(), [...broad].sort());
});
