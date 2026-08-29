import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { McpPermissionDeniedError } from "./permissions.js";

/**
 * Disclosure category — which surfaces a tool is expected to show up on.
 * "core" is always shown; "curriculum-extras" and "meta" are progressively
 * de-emphasized by consumers (e.g. the advisor's derived tool catalogue).
 */
export type ToolCategory = "core" | "curriculum-extras" | "scheduling" | "meta";

/** _meta key `registerTools` stamps onto every tool's `Tool._meta`. */
export const TOOL_CATEGORY_META_KEY = "cuassistant/category";

export interface McpToolDefinition {
  operation: string;
  tool: Tool;
  category: ToolCategory;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export function ok(text: string): CallToolResult {
  return { content: [{ type: "text" as const, text }] };
}

// Minified deliberately: tool results are read by models, not humans, and the
// 2-space indent this used to emit cost ~36% of every response in whitespace.
// Large results (a 50-section class search) were pushing agent requests over
// the context limit. Use a JSON formatter if you need to read one by eye.
//
// STRUCTURED OUTPUT (2026-08-27). Every tool used to return its payload only as
// JSON stuffed inside a text block, so a model had to parse a string to reach a
// field. `structuredContent` hands it the object directly, and a tool that also
// declares `outputSchema` tells the model what it will get BEFORE calling —
// which is tool-selection information, and tool selection is precisely what
// failed in the 2026-08-27 PCID miss.
//
// The text block is still emitted, always. The spec says a server returning
// structuredContent SHOULD also return equivalent text content for backward
// compatibility, and every client we have today reads the text. This is
// additive: no existing consumer changes behaviour.
//
// Only a plain object becomes structuredContent — the field is specified as an
// object, so an array or scalar payload is left as text alone rather than
// wrapped in an invented envelope that no schema would describe. Tools whose
// natural result is a list should return `{ items: [...] }` if they want
// structured output (see listGcCatalogYears).
export function okJson(data: unknown): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
  if (isPlainObject(data)) result.structuredContent = data;
  return result;
}

/** True for a non-null, non-array object literal — the only shape structuredContent accepts. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function err(text: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text: `Error: ${text}` }],
    isError: true,
  };
}

/** Render a permission error from assertMcpOperation as a tool result. */
export function permissionErr(e: unknown): CallToolResult {
  if (e instanceof McpPermissionDeniedError) {
    return err(e.message);
  }
  return err(`unexpected permission error: ${String(e)}`);
}
