// src/mcp-tools/program-graph.ts
// get-program-graph: one major x catalog year as a graph, in one call —
// requirement nodes, planned courses with reviewed prerequisite rules, chain
// bounds, the critical path, seasons from observed offering history, and (given
// a student's courses) a per-course status. Replaces a per-course
// get-course-details loop for planning. Never decides whether a requirement
// is satisfied: that is Degree Works.

import Database from "better-sqlite3";

import { CATALOG_DB } from "../config-mcp.js";
import { normalizeCourseCode } from "../catalog-read.js";
import {
  observedTerms,
  offeringsFor,
  openOfferingsDb,
  seasonRollup,
} from "../clemson-offerings-db.js";
import {
  applyDecisions,
  loadOfferingDecisions,
} from "../offering-decisions.js";
import {
  buildProgramGraph,
  loadGraphInputs,
  type Standing,
  type StudentState,
} from "../program-graph.js";
import { assertMcpOperation } from "./permissions.js";
import {
  CATALOG_YEAR_ARG_DESCRIPTION,
  PROGRAM_ARG_DESCRIPTION,
  missingProgramMessage,
  resolveCatalogYearArg,
  resolveProgramArg,
} from "./program-args.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const STANDINGS: readonly Standing[] = [
  "freshman",
  "sophomore",
  "junior",
  "senior",
];

/** "ACCT 2010:C" / "acct2010" -> [code, grade|null], or null if unusable. */
function parseCompleted(raw: string): [string, string | null] | null {
  const s = raw.trim();
  const colon = s.lastIndexOf(":");
  const codePart = colon >= 0 ? s.slice(0, colon) : s;
  const gradePart = colon >= 0 ? s.slice(colon + 1).trim() : null;
  const code = normalizeCourseCode(codePart);
  if (!code) return null;
  if (gradePart === null) return [code, null];
  if (!/^[A-F][+-]?$/i.test(gradePart)) return null;
  return [code, gradePart.toUpperCase().replace(/[+-]/, "")];
}

// Absent means the default, so a 40-55 course graph fits a small model's
// budget (same convention as compactSearchResult). A course's requirement
// memberships are NOT repeated on the course: each requirement node lists its
// courses, so the edge appears once.
const COMPACT_NOTE =
  "Course fields omitted when default: required_by / one_way_into absent = 0; " +
  "parse absent = complete; planned absent = not in the plan (reached only as " +
  "a prerequisite). Which requirement a course satisfies: see requirements[].courses.";

function compactCourse(
  c: ReturnType<typeof buildProgramGraph>["courses"][number],
) {
  const {
    requirements: _r,
    required_by,
    one_way_into,
    parse,
    planned,
    ...rest
  } = c;
  return {
    ...rest,
    ...(planned ? { planned } : {}),
    ...(parse !== "complete" ? { parse } : {}),
    ...(required_by ? { required_by } : {}),
    ...(one_way_into ? { one_way_into } : {}),
  };
}

export const programGraph: McpToolDefinition = {
  operation: "clemson.program_graph",
  category: "curriculum-extras",
  tool: {
    name: "get-program-graph",
    description:
      "The degree as a GRAPH for one program and catalog year, in ONE call: " +
      "every requirement (from Degree Works when imported, else the catalog " +
      "plan's slots and choices), every planned course with its term, its " +
      "prerequisite rule as a structured expression, how many terms must come " +
      "before it (min_prior_terms, a lower bound from prerequisites and class " +
      "standing), and which seasons it usually runs. Pass completed_courses " +
      '(optionally with grades, "ACCT 2010:C") and standing to get a status ' +
      "per course: eligible (take_with = must be taken the same term as " +
      "these), conditional (coursework done, but the listed conditions such as " +
      "instructor consent or a test score must be confirmed), not_eligible, or " +
      "undetermined (the rule could not be read — quote unresolved to the " +
      "student). assumes lists grade minimums taken as met because no grade " +
      "was given. coreqs must be taken in the same term. required_by counts " +
      "courses that need this one; one_way_into counts courses where it is " +
      "only one option. Use this FIRST for multi-semester planning, 'what " +
      "should I take next', or 'what happens if I delay X' — instead of " +
      "calling get-course-details course by course. critical_path is the " +
      "longest prerequisite chain; start it early. Prerequisite expressions: " +
      "& = all, | = any, ~ = may be taken the same term, >=C = minimum grade, " +
      '[standing:junior] etc. are conditions to confirm, ?"..." is a clause ' +
      "to read to the student verbatim. It never decides whether a " +
      "requirement is satisfied — that is Degree Works. Read-only, no login.",
    inputSchema: {
      type: "object" as const,
      properties: {
        program: { type: "string", description: PROGRAM_ARG_DESCRIPTION },
        catalog_year: {
          type: "string",
          description: CATALOG_YEAR_ARG_DESCRIPTION,
        },
        completed_courses: {
          type: "array",
          items: { type: "string" },
          description:
            'Courses already completed, e.g. ["GC 1010", "ACCT 2010:C"]. A ' +
            "grade after a colon is checked against minimum-grade rules.",
        },
        standing: {
          type: "string",
          enum: [...STANDINGS],
          description: "The student's class standing, if known.",
        },
      },
      required: ["program", "catalog_year"],
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.program_graph");
    } catch (e) {
      return permissionErr(e);
    }
    const program = resolveProgramArg(args);
    if (!program) return err(missingProgramMessage());
    const year = resolveCatalogYearArg(args);
    if (!year) return err("catalog_year is required (see list-catalog-years)");

    let standing: Standing | undefined;
    if (args.standing !== undefined) {
      if (
        typeof args.standing !== "string" ||
        !STANDINGS.includes(args.standing as Standing)
      )
        return err(`standing must be one of: ${STANDINGS.join(", ")}.`);
      standing = args.standing as Standing;
    }

    let student: StudentState | undefined;
    const ignored: string[] = [];
    if (Array.isArray(args.completed_courses)) {
      const completed = new Map<string, string | null>();
      for (const raw of args.completed_courses) {
        const parsed = typeof raw === "string" ? parseCompleted(raw) : null;
        if (!parsed) ignored.push(String(raw));
        else completed.set(parsed[0], parsed[1]);
      }
      student = { completed, ...(standing ? { standing } : {}) };
    } else if (standing) {
      student = { completed: new Map(), standing };
    }

    let db: InstanceType<typeof Database>;
    try {
      db = new Database(CATALOG_DB, { readonly: true, fileMustExist: true });
    } catch {
      return err(
        "Could not open the Clemson catalog database. This is NOT the same as the program not existing.",
      );
    }
    let graph: ReturnType<typeof buildProgramGraph>;
    try {
      graph = buildProgramGraph(loadGraphInputs(db, year, program), student);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(
        /program|year/i.test(msg)
          ? missingProgramMessage(msg)
          : `Program graph failed: ${msg}`,
      );
    } finally {
      db.close();
    }

    // Seasons from observed offering history, with recorded department
    // decisions applied — the same composition as get-course-offerings. Absent
    // history is reported, never turned into "not offered".
    try {
      const decisions = loadOfferingDecisions();
      const odb = openOfferingsDb();
      try {
        const observed = observedTerms(odb);
        if (observed.length === 0)
          throw new Error("no schedule snapshots are held");
        const key = (c: string) => c.replace(/\s+/g, "").toUpperCase();
        const per = offeringsFor(
          odb,
          graph.courses.map((c) => key(c.code)),
        );
        for (const c of graph.courses) {
          const seasons = applyDecisions(
            seasonRollup(observed, per.get(key(c.code)) ?? []),
            decisions.get(key(c.code)),
          );
          const labels: Record<string, string> = {};
          for (const [season, r] of Object.entries(seasons))
            labels[season] = r.label;
          (c as unknown as Record<string, unknown>).seasons = labels;
        }
      } finally {
        odb.close();
      }
    } catch (e) {
      graph.notes.push(
        `offering history unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return okJson({
      ...graph,
      courses: graph.courses.map(compactCourse),
      encoding_note: COMPACT_NOTE,
      ...(ignored.length ? { ignored_completed: ignored } : {}),
    });
  },
};

registerTools([programGraph]);
