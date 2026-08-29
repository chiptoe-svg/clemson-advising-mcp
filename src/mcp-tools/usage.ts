// Per-call usage accounting for the MCP HTTP servers — PRIVACY-SAFE BY
// CONSTRUCTION. Both servers expose only read tools, so this ledger is the one
// record of "how much use came from where": one append-only line per
// tools/call.
//
// What is recorded: timestamp, server name, the authenticated consumer id and
// the tool name. NOT the arguments, and NOT the
// results — a course code is public, but there is no reason to accumulate a
// per-consumer query history to answer a volume question, and not collecting it
// is a stronger guarantee than redacting it. This mirrors the contract in
// src/advisor-analytics.ts: shape, never content.
//
// Best-effort by design: a failed write warns and returns. Usage accounting must
// never break a tool call. Set MCP_USAGE_ANALYTICS=off to disable.

import { appendFileSync, mkdirSync } from "fs";
import path from "path";

import { STATE_DIR } from "../config-mcp.js";
import { log } from "../log.js";

function analyticsDir(): string {
  return process.env.MCP_ANALYTICS_DIR || path.join(STATE_DIR, "analytics");
}

/**
 * Longest tool name the ledger will store. The `unknown_tool` path records the
 * CALLER-SUPPLIED name, and an authenticated caller could otherwise append an
 * arbitrarily long line per request (an 800 KB name was reproduced, 2026-08-28
 * review) — a log that fills a disk is an availability defect.
 */
export const MAX_TOOL_NAME_RECORDED = 128;

export interface McpCallRecord {
  /** The server that served the call, e.g. "cuassistant-public". */
  server: string;
  /** Authenticated consumer id — the audit identity ("env-token" before pairing). */
  consumerId: string;
  /** The MCP tool name as exposed to clients. */
  tool: string;
  /**
   * How the caller authenticated. Recorded so an auth migration is legible in
   * the ledger itself: when OAuth arrives alongside registry tokens, "who is
   * still on the old scheme" is a grep rather than a guess.
   */
  authMethod?: string;
  /**
   * The end user, when the credential identifies a person (OAuth `sub`).
   * Absent for registry tokens, which identify an agent and not a human — that
   * absence is the honest signal that per-user attribution is not yet possible.
   */
  subject?: string;
  /**
   * Why the call did not reach a handler, when it did not: "unknown_tool" or
   * "out_of_scope". Absent for calls that were dispatched — including ones whose
   * handler then returned isError, which are the tool's own business, not the
   * gateway's.
   */
  outcome?: string;
}

/**
 * Append one usage line for a completed tools/call. Never throws.
 *
 * The file is state/analytics/mcp-calls.jsonl, alongside the advisor's
 * turns.jsonl, so both usage questions are answered from the same directory
 * (and swept by the same off-box backup job).
 */
export function recordMcpCall(rec: McpCallRecord): void {
  if (process.env.MCP_USAGE_ANALYTICS === "off") return;
  try {
    const record = {
      ts: new Date().toISOString(),
      server: rec.server,
      consumer_id: rec.consumerId,
      ...(rec.authMethod !== undefined ? { auth_method: rec.authMethod } : {}),
      ...(rec.subject !== undefined ? { subject: rec.subject } : {}),
      ...(rec.outcome !== undefined ? { outcome: rec.outcome } : {}),
      tool:
        rec.tool.length > MAX_TOOL_NAME_RECORDED
          ? `${rec.tool.slice(0, MAX_TOOL_NAME_RECORDED)}…(${rec.tool.length} chars)`
          : rec.tool,
    };
    const dir = analyticsDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, "mcp-calls.jsonl"),
      JSON.stringify(record) + "\n",
    );
  } catch (err) {
    log.warn("mcp usage write failed", { err: String(err) });
  }
}
