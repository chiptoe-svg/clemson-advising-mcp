// The usage ledger is append-only and unrotated, so what goes into a line has
// to be bounded. The `unknown_tool` path records the CALLER-SUPPLIED name.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_TOOL_NAME_RECORDED,
  recordMcpCall,
} from "../src/mcp-tools/usage.ts";

test("a caller-supplied tool name is truncated in the ledger, not stored verbatim", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advising-mcp-ledger-"));
  const prev = {
    dir: process.env.MCP_ANALYTICS_DIR,
    off: process.env.MCP_USAGE_ANALYTICS,
  };
  process.env.MCP_ANALYTICS_DIR = dir;
  delete process.env.MCP_USAGE_ANALYTICS; // npm test sets it off; this test needs a write
  try {
    recordMcpCall({
      server: "t",
      consumerId: "c",
      tool: "x".repeat(800_000),
      outcome: "unknown_tool",
    });
    const line = fs
      .readFileSync(path.join(dir, "mcp-calls.jsonl"), "utf-8")
      .trim();
    assert.ok(
      line.length < MAX_TOOL_NAME_RECORDED + 200,
      `ledger line is ${line.length} bytes`,
    );
    const rec = JSON.parse(line) as { tool: string };
    assert.ok(rec.tool.startsWith("x".repeat(MAX_TOOL_NAME_RECORDED)));
    assert.match(
      rec.tool,
      /800000 chars/,
      "the original length is kept, the content is not",
    );
  } finally {
    if (prev.dir === undefined) delete process.env.MCP_ANALYTICS_DIR;
    else process.env.MCP_ANALYTICS_DIR = prev.dir;
    if (prev.off !== undefined) process.env.MCP_USAGE_ANALYTICS = prev.off;
  }
});
