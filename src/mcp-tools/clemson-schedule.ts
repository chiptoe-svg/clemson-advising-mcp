// src/mcp-tools/clemson-schedule.ts
// Deterministic schedule-conflict tools backed by the per-term SQLite snapshot.
import {
  openScheduleDb,
  getScheduleDbMeta,
  getMeetingsForCrns,
  findConflicts,
  type ConflictPair,
} from "../clemson-schedule-db.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const findConflictFree: McpToolDefinition = {
  operation: "clemson.find_conflict_free_schedule",
  // A scheduling primitive, not curriculum: its own on-demand category so the
  // model doesn't have to load "curriculum-extras" to build a schedule.
  category: "scheduling",
  tool: {
    name: "find-conflict-free-schedule",
    description:
      "Given fixed CRNs (already committed) and candidate CRNs (options to " +
      "consider), returns which candidates can be added without time conflicts. " +
      "Each candidate is checked against every fixed CRN and against every " +
      "other candidate. Returns conflict_free candidates and details of any " +
      "conflicts for the rest. Reads the daily Banner snapshot. Do not use " +
      "this just to check a short, already-chosen CRN list — use " +
      "check-conflicts for that.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: { type: "string", description: "Term code, e.g. 202608." },
        fixed_crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs already locked in the schedule.",
        },
        candidate_crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs to evaluate.",
        },
      },
      required: ["term", "fixed_crns", "candidate_crns"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.find_conflict_free_schedule");
    } catch (e) {
      return permissionErr(e);
    }
    const term = args.term as string | undefined;
    const fixedCrns = args.fixed_crns as string[] | undefined;
    const candidateCrns = args.candidate_crns as string[] | undefined;
    if (
      !term ||
      !Array.isArray(fixedCrns) ||
      !Array.isArray(candidateCrns) ||
      candidateCrns.length === 0
    )
      return err("term, fixed_crns, and a non-empty candidate_crns array are required");

    const db = openScheduleDb(term);
    if (!db)
      return err(
        `No snapshot available for term ${term}. Run the daily refresh or try again after 05:00.`,
      );
    try {
      const allCrns = [...new Set([...fixedCrns, ...candidateCrns])];
      const meetings = getMeetingsForCrns(db, term, allCrns);
      const allConflicts = findConflicts(meetings);

      const fixedSet = new Set(fixedCrns);

      type CandidateResult = {
        crn: string;
        conflict_free: boolean;
        conflicts: ConflictPair[];
      };

      const results: CandidateResult[] = candidateCrns.map((crn) => {
        const conflicts = allConflicts.filter(
          (c) =>
            (c.crn_a === crn || c.crn_b === crn) &&
            (c.crn_a !== crn || fixedSet.has(c.crn_b) || candidateCrns.includes(c.crn_b)) &&
            (c.crn_b !== crn || fixedSet.has(c.crn_a) || candidateCrns.includes(c.crn_a)),
        );
        return { crn, conflict_free: conflicts.length === 0, conflicts };
      });

      return okJson({
        term,
        snapshot_date: getScheduleDbMeta(db).fetchedAt,
        fixed_crns: fixedCrns,
        candidates: results,
        conflict_free: results.filter((r) => r.conflict_free).map((r) => r.crn),
      });
    } finally {
      db.close();
    }
  },
};

// get-schedule-freshness — moved here from clemson-advising.ts (2026-08-26): it
// reads only the Banner snapshot's meta row, so it belongs with the schedule
// tools on the public server, beside list-clemson-terms.
// Report when a term's Banner snapshot was last ingested — the "data as of"
// for every seat/section/time/room answer. Reads only the snapshot's meta row,
// so it puts no load on Banner and is safe to call freely.
export const scheduleFreshness: McpToolDefinition = {
  operation: "clemson.schedule_freshness",
  category: "meta",
  tool: {
    name: "get-schedule-freshness",
    description:
      "Report when the Banner class-schedule snapshot for a term was last " +
      "ingested — the 'data as of' time behind every seat count, section, " +
      "meeting time, and room this assistant reports. Read-only and cheap: it " +
      "reads only the snapshot's metadata, with NO Banner load. Use it to tell " +
      "an advisor how current the seat numbers are, or to check whether a term " +
      "has been ingested yet. The current registration term's snapshot refreshes " +
      "automatically each morning (~05:00 Eastern); other terms are ingested on " +
      "demand. Returns has_snapshot:false for a term not yet ingested.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description: "Term code, e.g. 202608 (Fall 2026).",
        },
      },
      required: ["term"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.schedule_freshness");
    } catch (e) {
      return permissionErr(e);
    }

    const term = args.term as string | undefined;
    if (!term) return err("term is required, e.g. 202608.");

    const schedDb = openScheduleDb(term);
    if (!schedDb) {
      return okJson({
        term,
        has_snapshot: false,
        note:
          `No Banner snapshot for term ${term} yet. The current registration ` +
          `term refreshes each morning (~05:00 Eastern); other terms are ` +
          `ingested on demand.`,
      });
    }

    try {
      const meta = getScheduleDbMeta(schedDb);
      const parsed = meta.fetchedAt ? Date.parse(meta.fetchedAt) : NaN;
      const ageHours = Number.isNaN(parsed)
        ? null
        : Math.max(0, Math.round((Date.now() - parsed) / 3_600_000));
      return okJson({
        term,
        term_description: meta.termDescription,
        has_snapshot: true,
        data_as_of: meta.fetchedAt,
        age_hours: ageHours,
        _source: `Banner schedule ${meta.fetchedAt}`,
      });
    } finally {
      schedDb.close();
    }
  },
};

registerTools([findConflictFree, scheduleFreshness]);

