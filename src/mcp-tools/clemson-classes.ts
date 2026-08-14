// Clemson public class-schedule tools — backed by Banner 9 Browse Classes.
//
// Read-only, no login, works on or off the Clemson network. No Graph token and
// no Microsoft consent are involved; the only backend is the public Banner
// self-service search at regssb.sis.clemson.edu (see src/clemson-classes.ts).

import {
  listClemsonTerms,
  type ClemsonSearchResult,
} from "../clemson-classes.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

// A 50-section search used to serialize to ~12k tokens, which alone could push
// an agent request over a 64k context window. The reductions below are all
// lossless — nothing an agent can act on is dropped:
//
//   * `term` / `termDescription` are identical on every row (Banner binds one
//     term per query), so they move to the envelope.
//   * `waitCount` / `waitCapacity` are omitted when zero. Absent means zero;
//     they are NOT hoisted, because `waitCapacity` genuinely varies per row
//     (172 of 10,726 Fall 2026 sections carry a nonzero waitlist capacity) and
//     hoisting a single value would silently misreport those.
//   * null fields and empty arrays are omitted — absent already means "none".
//
// Deliberately NOT omitted: `seatsAvailable: 0`. Zero seats means the section
// is FULL, which is the single most decision-relevant value in the payload;
// omitting it would make "full" indistinguishable from "not reported".
const OMIT_WHEN_ZERO = new Set(["waitCount", "waitCapacity"]);

function stripEmpty<T extends object>(obj: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(
      ([k, v]) =>
        v !== null &&
        !(Array.isArray(v) && v.length === 0) &&
        !(v === 0 && OMIT_WHEN_ZERO.has(k)),
    ),
  );
}

// Wire shape for search results: hoists the row-constant term fields, drops
// empties, and tells the agent when it is looking at a truncated list.
export function compactSearchResult(
  result: ClemsonSearchResult,
): Record<string, unknown> {
  const first = result.sections[0];
  const out: Record<string, unknown> = {
    totalCount: result.totalCount,
    snapshotDate: result.snapshotDate,
    scope: result.scope,
  };
  if (first) {
    out.term = first.term;
    out.termDescription = first.termDescription;
  }
  if (result.sections.length < result.totalCount) {
    out.truncated = true;
    out.hint =
      `Showing ${result.sections.length} of ${result.totalCount} sections. ` +
      "Narrow with courseNumber or openOnly, or page with offset — " +
      "re-running the same search returns the same rows.";
  }
  out.sections = result.sections.map(({ term, termDescription, ...rest }) =>
    stripEmpty({ ...rest, meetings: rest.meetings.map(stripEmpty) }),
  );
  return out;
}

const listTerms: McpToolDefinition = {
  operation: "clemson.list_terms",
  tool: {
    name: "list-clemson-terms",
    description:
      "Do NOT call this if a term or any CRN is already given; use " +
      "check-conflicts or search-classes directly — both default to the " +
      "current registration term on their own. Only for discovering a valid " +
      "term code when none is known. Read-only, no login.",
    inputSchema: {
      type: "object" as const,
      properties: {
        max: {
          type: "integer",
          description: "Max terms to return (default 20).",
        },
      },
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.list_terms");
    } catch (e) {
      return permissionErr(e);
    }
    const max = typeof args.max === "number" ? args.max : 20;
    const terms = await listClemsonTerms(max);
    if (terms === null) return err("Clemson term list unavailable.");
    return okJson({ terms });
  },
};

registerTools([listTerms]);
