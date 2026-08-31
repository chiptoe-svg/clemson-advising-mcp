// Shared program / catalog-year argument handling for the catalog tools.
//
// Phase B unified the keys: every catalog tool takes `program` and
// `catalog_year`. The old `name` / `year` keys stay accepted as DEPRECATED
// ALIASES for one release so nothing breaks the day the servers restart —
// after that they can be deleted here and in each tool's inputSchema.
//
// The other half of the change is what ISN'T here any more: these tools used
// to default a missing program to "Graphic Communications, BS", so a Marketing
// question was silently answered with the GC plan (review finding D10). A
// missing program is now an error that names the programs on offer.
//
// Each tool's inputSchema is CLOSED (additionalProperties: false), and on the
// advisor path that is enforced, not decorative: pi-ai's validateToolArguments
// (typebox) runs inside pi-agent-core's prepareToolCall, BEFORE execute, so a
// misspelled key hard-fails with "must not have additional properties" rather
// than being dropped and silently defaulted. Two consequences worth keeping in
// mind when editing these schemas: (1) a key must be DECLARED before the
// advisor's session defaulting may inject it (advisor-agent.ts's
// SESSION_DEFAULT_ARGS), and (2) deleting a deprecated alias from a schema
// turns every caller still passing it into a hard failure, not a fallback.
// src/mcp-tools/server.ts itself does NOT validate, so a direct MCP client
// gets whatever validation it does on its own side; the handlers' own checks
// are what protect that path.

import Database from "better-sqlite3";

import { CATALOG_DB } from "../config-mcp.js";
import { formatProgramList, listProgramOptions } from "../catalog-read.js";

/** Schema blurb for the canonical `program` key. */
export const PROGRAM_ARG_DESCRIPTION =
  "Program name exactly as the catalog spells it, e.g. 'Marketing, BS'. " +
  "Required — there is no default program; an omitted or unknown value " +
  "returns the list of programs to choose from.";

/** Schema blurb for the canonical `catalog_year` key. */
export const CATALOG_YEAR_ARG_DESCRIPTION =
  "Catalog year label, e.g. '2026-2027' (from list-catalog-years).";

export const NAME_ALIAS_DESCRIPTION =
  "Deprecated alias for `program`, accepted for one release. Use `program`.";

export const YEAR_ALIAS_DESCRIPTION =
  "Deprecated alias for `catalog_year`, accepted for one release. Use `catalog_year`.";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Canonical `program`, falling back to the deprecated `name` alias. */
export function resolveProgramArg(
  args: Record<string, unknown>,
): string | null {
  return str(args.program) ?? str(args.name);
}

/** Canonical `catalog_year`, falling back to the deprecated `year` alias. */
export function resolveCatalogYearArg(
  args: Record<string, unknown>,
): string | null {
  return str(args.catalog_year) ?? str(args.year);
}

/**
 * The error a catalog tool returns when no program reached it. Names the
 * programs on offer so the caller can retry without a second round trip; falls
 * back to a plain sentence if the catalog DB cannot be read.
 */
export function missingProgramMessage(extra = ""): string {
  // Read the catalog DIRECTLY, not through the advisor's MCP-backed helper.
  // This runs INSIDE the catalog server; routing it through MCP would have the
  // server call itself over HTTP to build an error message. The advisor's web
  // surface has the opposite requirement — it must not touch the file — so the
  // two deliberately read the same data by different routes.
  let names: string[] = [];
  try {
    const db = new Database(CATALOG_DB, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      names = listProgramOptions(db).programs.map((p) => p.name);
    } finally {
      db.close();
    }
  } catch {
    names = [];
  }
  const list =
    names.length > 0
      ? ` Choose one of: ${formatProgramList(names)}.`
      : " Use list-catalog-years and get-program-requirements to discover valid program names.";
  return (
    "program is required — this tool has no default program, because " +
    "defaulting it answered questions about the wrong degree." +
    list +
    extra
  );
}
