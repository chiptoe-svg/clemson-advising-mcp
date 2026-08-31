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

test("a missing policy file refuses to load rather than degrading to zero actions", async () => {
  // Fail-closed was already true (no actions → every tool refused); what was
  // missing was the noise. A server that starts with an empty tool list and
  // 401s valid tokens looks healthy to the install verifier.
  const { execFileSync } = await import("node:child_process");
  const path = await import("node:path");
  let out = "";
  let code = 0;
  try {
    out = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        "import('./src/policy.ts').then(() => console.log('LOADED'))",
      ],
      {
        env: {
          ...process.env,
          POLICY_DIR: path.join(process.cwd(), "no-such-policy-dir"),
        },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    code = err.status ?? 1;
    out = err.stderr ?? "";
  }
  assert.notEqual(code, 0, "loading the policy module must fail");
  assert.match(out, /cannot read the action policy/);
});
