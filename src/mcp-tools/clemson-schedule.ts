// src/mcp-tools/clemson-schedule.ts
// Deterministic schedule-conflict tools backed by the per-term SQLite snapshot.
import { parseTermCode, resolveTerm } from "../term-resolve.js";
import {
  openScheduleDb,
  getScheduleDbMeta,
  getMeetingsForCrns,
  getSectionsByCrn,
  resolveCrns,
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
        term: {
          type: "string",
          description:
            'Term: a code (202608) or a name ("Fall 2026"). Defaults to the current registration term.',
        },
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
    const fixedCrns = args.fixed_crns as string[] | undefined;
    const candidateCrns = args.candidate_crns as string[] | undefined;
    if (
      !Array.isArray(fixedCrns) ||
      !Array.isArray(candidateCrns) ||
      candidateCrns.length === 0
    )
      return err(
        "term, fixed_crns, and a non-empty candidate_crns array are required",
      );
    // This tool cannot answer without a snapshot, so the full resolver: it
    // names the available terms rather than failing bare.
    const resolved = resolveTerm(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in resolved) return err(resolved.error);
    const { term } = resolved;

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
            (c.crn_a !== crn ||
              fixedSet.has(c.crn_b) ||
              candidateCrns.includes(c.crn_b)) &&
            (c.crn_b !== crn ||
              fixedSet.has(c.crn_a) ||
              candidateCrns.includes(c.crn_a)),
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
          description:
            'Term: a code (202608) or a name ("Fall 2026"). Defaults to the current registration term.',
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

    // Parse but do NOT require a snapshot: reporting that a term has none is
    // this tool's entire job. What it must not do is report a term it failed
    // to understand as a term that was never ingested.
    const parsedTerm = parseTermCode(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in parsedTerm) return err(parsedTerm.error);
    const { term } = parsedTerm;

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

/**
 * Authoritative section rows by CRN, straight from the term snapshot.
 *
 * WHY IT EXISTS (2026-08-28). The advisor performs a host-side check that every
 * CRN in a model-proposed schedule is real before that schedule is rendered
 * into a printable document — the one artifact that leaves the building. A
 * model that fabricates a CRN believes it is correct, so the check cannot be
 * delegated back to the model; it has to be made against the snapshot. That
 * check used to read state/clemson/<term>.db off local disk, which works only
 * while the advisor and this server share a filesystem.
 *
 * The tools that already accept a CRN cannot serve it: get-course-details
 * returns Banner catalog prose (description, prerequisites, restrictions) and
 * check-conflicts returns only overlap windows. Neither returns the fields a
 * verification compares.
 *
 * NOT_FOUND IS THE LOAD-BEARING HALF of the response. A fabricated CRN that
 * came back as merely an absent row would be indistinguishable from a section
 * with no meetings, and that conflation is the exact failure the caller is
 * trying to catch.
 */
const sectionsByCrn: McpToolDefinition = {
  operation: "clemson.sections_by_crn",
  category: "scheduling",
  tool: {
    name: "get-sections-by-crn",
    description:
      "Look up one or more CRNs in a term's Banner snapshot and return what " +
      "the snapshot actually records for each: subject and course, section " +
      "number, credit hours, and every meeting (day, start/end time, building, " +
      "room). Use it to CONFIRM sections you already have CRNs for — checking a " +
      'proposed schedule against reality, or answering "what is CRN 81185". ' +
      "CRNs with no row come back in `not_found`, which is authoritative: the " +
      "snapshot was read and has no such CRN. For catalog prose (description, " +
      "prerequisites, restrictions) use get-course-details instead; for whether " +
      "sections clash, use check-conflicts. Read-only, no Banner load.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            'Term: a code (202608) or a name ("Fall 2026"). Defaults to the current registration term.',
        },
        crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs to look up. Duplicates are collapsed.",
        },
      },
      required: ["term", "crns"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        term: { type: "string" },
        has_snapshot: {
          type: "boolean",
          description:
            "False when this term has not been ingested. Distinct from an empty " +
            "result: no snapshot means NOTHING was checked, so `not_found` is " +
            "empty rather than listing every CRN as fake.",
        },
        snapshot_date: {
          type: ["string", "null"],
          description: "When the snapshot was ingested.",
        },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              crn: { type: "string" },
              subject_course: { type: "string" },
              section: { type: "string" },
              title: { type: "string" },
              credit_hours: {
                type: ["number", "null"],
                description:
                  "Null means the snapshot does not record it — not zero.",
              },
              meetings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    day: { type: "string", description: "M T W R F S U." },
                    start_min: {
                      type: ["number", "null"],
                      description:
                        "Minutes past midnight; null for an untimed meeting.",
                    },
                    end_min: { type: ["number", "null"] },
                    building: { type: ["string", "null"] },
                    room: { type: ["string", "null"] },
                  },
                  required: ["day"],
                },
              },
            },
            required: ["crn", "subject_course", "section", "title", "meetings"],
          },
        },
        not_found: {
          type: "array",
          items: { type: "string" },
          description:
            "CRNs the snapshot has no row for. AUTHORITATIVE when has_snapshot " +
            "is true: the snapshot was read and does not contain them.",
        },
      },
      required: ["term", "has_snapshot", "sections", "not_found"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.sections_by_crn");
    } catch (e) {
      return permissionErr(e);
    }
    // "Fall 2026" must resolve to 202608, not fall through to
    // has_snapshot:false — which reads as "that term was never ingested" about
    // a term whose snapshot was fetched this morning. Reproduced 2026-08-28.
    // Parse only: an absent snapshot is still reported, never implied.
    const parsedTerm = parseTermCode(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in parsedTerm) return err(parsedTerm.error);
    const { term } = parsedTerm;
    const crns = Array.isArray(args.crns)
      ? args.crns
          .filter((c): c is string => typeof c === "string")
          .map((c) => c.trim())
          .filter(Boolean)
      : [];
    if (crns.length === 0)
      return err("crns is required and must contain at least one CRN.");

    const db = openScheduleDb(term);
    if (!db) {
      // NOT an empty not_found list of every CRN. A term with no snapshot means
      // nothing was checked; saying otherwise would mark every real CRN fake.
      return okJson({
        term,
        has_snapshot: false,
        snapshot_date: null,
        sections: [],
        not_found: [],
        _note: `No snapshot for term ${term}, so no CRN could be checked.`,
      });
    }
    try {
      const meta = getScheduleDbMeta(db);
      const { sections, notFound } = getSectionsByCrn(db, term, crns);
      return okJson({
        term,
        has_snapshot: true,
        snapshot_date: meta.fetchedAt,
        sections,
        not_found: notFound,
      });
    } finally {
      db.close();
    }
  },
};

/**
 * CRNs for course + section pairs. The companion to get-sections-by-crn, for
 * the case where the caller has no CRN to look up: a Clemson Navigator
 * schedule export lists course and section but omits the CRN entirely.
 *
 * NULL MEANS "NO SINGLE MATCH" — nothing matched, or more than one did.
 * Ambiguity is reported as a null and never resolved by picking one, because
 * guessing between two sections silently places a student in a class they may
 * not be in.
 */
const resolveCrnsTool: McpToolDefinition = {
  operation: "clemson.resolve_crns",
  category: "scheduling",
  tool: {
    name: "resolve-crns",
    description:
      "Find the CRN for each course+section pair in a term's snapshot — for " +
      "schedule data that names courses and sections but carries no CRNs (a " +
      "Clemson Navigator export, a student typing their schedule out). Course " +
      'codes match with or without the space ("GC 3400" = "GC3400"). ' +
      "Results are aligned BY INDEX with the input. A null means NO SINGLE " +
      "match — either nothing matched or several did; it never guesses between " +
      "candidates. Read-only, no Banner load.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            'Term: a code (202608) or a name ("Fall 2026"). Defaults to the current registration term.',
        },
        sections: {
          type: "array",
          description:
            "Course + section pairs, in the order results should come back.",
          items: {
            type: "object",
            properties: {
              subject_course: {
                type: "string",
                description: 'e.g. "GC 3400" or "GC3400".',
              },
              section: { type: "string", description: 'e.g. "001".' },
            },
            required: ["subject_course", "section"],
          },
        },
      },
      required: ["term", "sections"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        term: { type: "string" },
        has_snapshot: {
          type: "boolean",
          description:
            "False when the term has not been ingested — nothing was resolved.",
        },
        crns: {
          type: "array",
          items: { type: ["string", "null"] },
          description:
            "Aligned by index with the input. Null = no single match (none, or ambiguous).",
        },
      },
      required: ["term", "has_snapshot", "crns"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.resolve_crns");
    } catch (e) {
      return permissionErr(e);
    }
    const parsedTerm = parseTermCode(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in parsedTerm) return err(parsedTerm.error);
    const { term } = parsedTerm;
    const raw = Array.isArray(args.sections) ? args.sections : [];
    const wanted = raw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({
        subjectCourse:
          typeof r.subject_course === "string" ? r.subject_course : "",
        section: typeof r.section === "string" ? r.section : "",
      }));
    if (wanted.length === 0) {
      return err(
        "sections is required and must contain at least one {subject_course, section}.",
      );
    }

    const db = openScheduleDb(term);
    if (!db) {
      return okJson({
        term,
        has_snapshot: false,
        crns: wanted.map(() => null),
        _note: `No snapshot for term ${term}, so no CRN could be resolved.`,
      });
    }
    try {
      return okJson({
        term,
        has_snapshot: true,
        crns: resolveCrns(db, term, wanted),
      });
    } finally {
      db.close();
    }
  },
};

/** Test-only handle on the tool definitions, so a test can drive a handler
 *  without standing up a server. */
export const __schedTools = {
  findConflictFree,
  scheduleFreshness,
  sectionsByCrn,
  resolveCrns: resolveCrnsTool,
};

registerTools([
  findConflictFree,
  scheduleFreshness,
  sectionsByCrn,
  resolveCrnsTool,
]);
