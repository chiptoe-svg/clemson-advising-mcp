import assert from "node:assert/strict";
import test from "node:test";

import { shouldRegisterMcpTool } from "../src/mcp-tools/server.ts";
import { isMcpOperationExposed } from "../src/mcp-tools/permissions.ts";
import type { McpToolDefinition } from "../src/mcp-tools/types.ts";

function fakeTool(operation?: string): McpToolDefinition {
  return {
    // Deliberately allowed to be undefined: these tests cover the case where a
    // tool is registered without an operation, which the type forbids but a
    // hand-written definition could still do.
    operation: operation as string,
    category: "meta",
    tool: {
      name: operation ?? "missing-operation",
      description: "test tool",
      inputSchema: { type: "object" },
    },
    async handler() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

test("MCP registration fails closed when a tool has no operation mapping", () => {
  assert.equal(shouldRegisterMcpTool(fakeTool(undefined)), false);
});

test("an operation not in the allow-list is not exposed", () => {
  assert.equal(isMcpOperationExposed("todo.delete_task"), false);
});

test("list-clemson-terms is exposed (read-only, no-auth public data)", () => {
  assert.equal(isMcpOperationExposed("clemson.list_terms"), true);
});
