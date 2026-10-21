// src/mcp-tools/what-if-plan.ts
// what-if-plan: "what happens to graduation if he delays GC 3400 / takes a
// co-op term / moves a course earlier?" answered deterministically from the
// program graph. Built because models handed the graph still derived the
// answer wrong (Cob_advisor T8b, 2026-10-20). A warning, never a promise:
// see the caveat in every response.

import { normalizeCourseCode } from "../catalog-read.js";
import { whatIf, type PlanChange, type SeasonLabels } from "../plan-whatif.js";
import { assertMcpOperation } from "./permissions.js";
import {
  CATALOG_YEAR_ARG_DESCRIPTION,
  PROGRAM_ARG_DESCRIPTION,
  missingProgramMessage,
  resolveCatalogYearArg,
  resolveProgramArg,
} from "./program-args.js";
import {
  loadProgramGraph,
  parseStudentArgs,
  seasonLabelsFor,
} from "./program-graph.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

/** One raw change object -> PlanChange, or an error message. */
function toChange(raw: unknown, i: number): PlanChange | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return `changes[${i}] must be an object`;
  const r = raw as Record<string, unknown>;
  if (r.skip_term !== undefined) {
    if (
      r.course !== undefined ||
      r.delay_terms !== undefined ||
      r.move_to !== undefined
    )
      return `changes[${i}]: skip_term stands alone — no course, delay_terms or move_to`;
    if (typeof r.skip_term !== "string")
      return `changes[${i}]: skip_term must be a plan term, e.g. 'Junior/Second Semester'`;
    return { skipTerm: r.skip_term };
  }
  const code =
    typeof r.course === "string" ? normalizeCourseCode(r.course) : null;
  if (!code)
    return `changes[${i}] needs course (with delay_terms or move_to) or skip_term`;
  if (r.move_to !== undefined && typeof r.move_to !== "string")
    return `changes[${i}]: move_to must be a plan term, e.g. 'Senior/First Semester'`;
  return {
    course: code,
    ...(r.delay_terms !== undefined
      ? { delayTerms: Number(r.delay_terms) }
      : {}),
    ...(r.move_to !== undefined ? { moveTo: r.move_to as string } : {}),
  };
}

export const whatIfPlanTool: McpToolDefinition = {
  operation: "clemson.plan_whatif",
  category: "core",
  tool: {
    name: "what-if-plan",
    description:
      "What happens to graduation if the plan changes? Computed for a " +
      "program + catalog year — do not work it out from get-program-graph " +
      "yourself. changes is a short list: {course, delay_terms} or {course, " +
      "move_to} moves a course later or earlier (a retake is a move), and " +
      "{skip_term} is a term the student takes nothing from the plan (co-op, " +
      "study abroad, a term off). It keeps corequisites together, pushes " +
      "every later course whose prerequisites force it (skipping terms a " +
      "course is not usually offered), flags a course moved earlier than its " +
      "prerequisites allow, and returns slips_graduation, the courses that " +
      "move (from, to, because), prereq_problems, and a verdict sentence to " +
      "quote with its caveat. Pass completed_courses so finished courses " +
      "stay put. Relative to the published plan's term order; no course-load " +
      "check; offerings are history, not a guarantee; Degree Works decides " +
      "what counts. Read-only, no login.",
    inputSchema: {
      type: "object" as const,
      properties: {
        program: { type: "string", description: PROGRAM_ARG_DESCRIPTION },
        catalog_year: {
          type: "string",
          description: CATALOG_YEAR_ARG_DESCRIPTION,
        },
        changes: {
          type: "array",
          description:
            "1-6 changes. Each is {course, delay_terms} (fall/spring terms " +
            "later; 'the following fall' from a fall term = 2), {course, " +
            "move_to} (a plan term such as 'Senior/First Semester', earlier " +
            "or later), or {skip_term} (a plan term with nothing taken).",
          items: {
            type: "object",
            properties: {
              course: { type: "string" },
              delay_terms: { type: "integer" },
              move_to: { type: "string" },
              skip_term: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        completed_courses: {
          type: "array",
          items: { type: "string" },
          description:
            'Courses already completed, e.g. ["GC 1010", "GC 1040"].',
        },
      },
      required: ["program", "catalog_year", "changes"],
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.plan_whatif");
    } catch (e) {
      return permissionErr(e);
    }
    const program = resolveProgramArg(args);
    if (!program) return err(missingProgramMessage());
    const year = resolveCatalogYearArg(args);
    if (!year) return err("catalog_year is required (see list-catalog-years)");
    if (!Array.isArray(args.changes))
      return err(
        "changes must be a LIST, e.g. [{course: 'GC 3400', delay_terms: 2}].",
      );
    const changes: PlanChange[] = [];
    for (const [i, raw] of (args.changes as unknown[]).entries()) {
      const c = toChange(raw, i);
      if (typeof c === "string") return err(c);
      changes.push(c);
    }

    const sa = parseStudentArgs(args);
    if ("error" in sa) return err(sa.error);
    const loaded = loadProgramGraph(program, year, sa.student);
    if ("error" in loaded) return err(loaded.error);

    const notes: string[] = [];
    const s = seasonLabelsFor(loaded.graph.courses.map((c) => c.code));
    const seasons =
      "error" in s ? undefined : (s.labels as Map<string, SeasonLabels>);
    if ("error" in s) notes.push(`offering history unavailable: ${s.error}`);

    try {
      const result = whatIf(
        loaded.graph,
        loaded.planTerms,
        { changes, completed: new Set(sa.student?.completed.keys() ?? []) },
        seasons,
      );
      return okJson({
        program,
        catalog_year: year,
        ...result,
        ...(notes.length ? { notes } : {}),
        ...(sa.ignored.length ? { ignored_completed: sa.ignored } : {}),
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([whatIfPlanTool]);
