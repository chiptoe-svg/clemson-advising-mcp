// Per-call usage accounting for the MCP HTTP servers — PRIVACY-SAFE BY
// CONSTRUCTION, and deliberately separate from audit.ts.
//
// audit.ts records WRITE INTENTS to state/decisions.jsonl (the IT-reviewable
// record of actions taken). The public (8766) and catalog (8767) servers expose
// only read tools, so they produce no audit rows at all — which is why "how much
// use came from where" was unanswerable before 2026-08-26. This module fills
// that gap with one append-only line per tools/call.
//
// What is recorded: timestamp, server name, the authenticated consumer id and
// its attested provider, and the tool name. NOT the arguments, and NOT the
// results — a course code is public, but there is no reason to accumulate a
// per-consumer query history to answer a volume question, and not collecting it
// is a stronger guarantee than redacting it. This mirrors the contract in
// src/advisor-analytics.ts: shape, never content.
//
// Best-effort by design: a failed write warns and returns. Usage accounting must
// never break a tool call. Set MCP_USAGE_ANALYTICS=off to disable.

import { appendFileSync, mkdirSync } from "fs";
import path from "path";

import { STATE_DIR } from "../config.js";
import { log } from "../log.js";

function analyticsDir(): string {
  return process.env.ADVISOR_ANALYTICS_DIR || path.join(STATE_DIR, "analytics");
}

export interface McpCallRecord {
  /** The server that served the call, e.g. "cuassistant-public". */
  server: string;
  /** Authenticated consumer id — the audit identity ("env-token" before pairing). */
  consumerId: string;
  /** The consumer's attested model backend, when it declared one. */
  provider?: string;
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
      ...(rec.provider !== undefined ? { provider: rec.provider } : {}),
      ...(rec.authMethod !== undefined ? { auth_method: rec.authMethod } : {}),
      ...(rec.subject !== undefined ? { subject: rec.subject } : {}),
      tool: rec.tool,
    };
    const dir = analyticsDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "mcp-calls.jsonl"), JSON.stringify(record) + "\n");
  } catch (err) {
    log.warn("mcp usage write failed", { err: String(err) });
  }
}
