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
