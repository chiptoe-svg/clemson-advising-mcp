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
  type ProgramGraph,
  type Standing,
  type StudentState,
} from "../program-graph.js";
import {
  courseCodes,
  parsePrereq,
  requiredCodes,
  type Expr,
} from "../prereq-expr.js";
import {
  slackTerms,
  slotOf,
  whatIf,
  type SeasonLabels,
} from "../plan-whatif.js";
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

/** "ACCT 2010:C" / "acct2010" / "GC 3500:B@Summer 2026" / "GC 3500@202605"
 *  -> [code, grade|null, taken in a summer], or null if unusable. The term
 *  is optional; only its season is used (the GC 3500/4500 one-summer rule). */
function parseCompleted(raw: string): [string, string | null, boolean] | null {
  let s = raw.trim();
  let summer = false;
  const at = s.lastIndexOf("@");
  if (at >= 0) {
    const term = s.slice(at + 1).trim();
    const named = /^(spring|summer|fall)\s+\d{4}$/i.exec(term);
    const banner = /^\d{4}(01|05|08)$/.exec(term);
    if (!named && !banner) return null;
    summer = named ? named[1].toLowerCase() === "summer" : banner![1] === "05";
    s = s.slice(0, at).trim();
  }
  const colon = s.lastIndexOf(":");
  const codePart = colon >= 0 ? s.slice(0, colon) : s;
  const gradePart = colon >= 0 ? s.slice(colon + 1).trim() : null;
  const code = normalizeCourseCode(codePart);
  if (!code) return null;
  if (gradePart === null) return [code, null, summer];
  if (!/^[A-F][+-]?$/i.test(gradePart)) return null;
  return [code, gradePart.toUpperCase().replace(/[+-]/, ""), summer];
}

// Absent means the default, so a 40-55 course graph fits a small model's
// budget (same convention as compactSearchResult). A course's requirement
// memberships are NOT repeated on the course: each requirement node lists its
// courses, so the edge appears once.
const COMPACT_NOTE =
  "Course fields omitted when default: required_by / one_way_into absent = 0; " +
  "parse absent = complete; planned absent = not in the plan (reached only as " +
  "a prerequisite). Which requirement a course satisfies: see requirements[].courses." +
  " slack = fall/spring terms it can slip before graduation does (4 = 4+); " +
  "absent for completed, choice and unplanned courses, or if not computable.";

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

/**
 * Typed prerequisite edges, from the reviewed expressions: same_term when the
 * rule allows the course alongside (~), required when it is on every
 * satisfying path, one_of otherwise. Served so a renderer never needs its own
 * parser for the notation (two parsers drift).
 */
function typedEdges(graph: ReturnType<typeof buildProgramGraph>) {
  const edges: {
    from: string;
    to: string;
    kind: "required" | "one_of" | "same_term";
  }[] = [];
  for (const c of graph.courses) {
    if (!c.prereq) continue;
    const e = parsePrereq(c.prereq);
    const required = new Set(requiredCodes(e));
    const sameTerm = new Set<string>();
    const walk = (x: Expr): void => {
      if (x.t === "course" && x.concurrent) sameTerm.add(x.code);
      if (x.t === "and" || x.t === "or") x.of.forEach(walk);
    };
    walk(e);
    for (const code of courseCodes(e))
      edges.push({
        from: code,
        to: c.code,
        kind: sameTerm.has(code)
          ? "same_term"
          : required.has(code)
            ? "required"
            : "one_of",
      });
  }
  return edges;
}

export function parseStudentArgs(
  args: Record<string, unknown>,
): { student?: StudentState; ignored: string[] } | { error: string } {
  let standing: Standing | undefined;
  if (args.standing !== undefined) {
    if (
      typeof args.standing !== "string" ||
      !STANDINGS.includes(args.standing as Standing)
    )
      return { error: `standing must be one of: ${STANDINGS.join(", ")}.` };
    standing = args.standing as Standing;
  }
  if (
    args.completed_courses !== undefined &&
    !Array.isArray(args.completed_courses)
  )
    return {
      error:
        'completed_courses must be a LIST of course codes, e.g. ["GC 1010", "ACCT 2010:C"] — not one string.',
    };
  const ignored: string[] = [];
  if (Array.isArray(args.completed_courses)) {
    const completed = new Map<string, string | null>();
    const completedInSummer = new Set<string>();
    for (const raw of args.completed_courses) {
      const parsed = typeof raw === "string" ? parseCompleted(raw) : null;
      if (!parsed) ignored.push(String(raw));
      else if (parsed[1] === "F")
        ignored.push(
          `${String(raw).trim()} (an F does not complete the course)`,
        );
      else {
        completed.set(parsed[0], parsed[1]);
        if (parsed[2]) completedInSummer.add(parsed[0]);
      }
    }
    return {
      student: {
        completed,
        ...(completedInSummer.size ? { completedInSummer } : {}),
        ...(standing ? { standing } : {}),
      },
      ignored,
    };
  }
  if (standing) return { student: { completed: new Map(), standing }, ignored };
  return { ignored };
}

export function loadProgramGraph(
  program: string,
  year: string,
  student?: StudentState,
): { graph: ProgramGraph; planTerms: string[] } | { error: string } {
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(CATALOG_DB, { readonly: true, fileMustExist: true });
  } catch {
    return {
      error:
        "Could not open the Clemson catalog database. This is NOT the same as the program not existing.",
    };
  }
  try {
    const inputs = loadGraphInputs(db, year, program);
    if (inputs.plan.groups.length === 0)
      return {
        error: `"${program}" has no semester-by-semester plan in the ${year} catalog — it is likely a minor or certificate. Use get-program-requirements for what it requires.`,
      };
    return {
      graph: buildProgramGraph(inputs, student),
      planTerms: inputs.plan.groups.map((g) => g.label),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/catalog year/i.test(msg))
      return {
        error: `${msg}. Use list-catalog-years for valid catalog years.`,
      };
    return {
      error: /program/i.test(msg)
        ? missingProgramMessage(` ${msg}`)
        : `Program graph failed: ${msg}`,
    };
  } finally {
    db.close();
  }
}

/**
 * Season labels from observed offering history, with recorded department
 * decisions applied — the same composition as get-course-offerings. Absent
 * history is an error the caller reports, never "not offered".
 */
export function seasonLabelsFor(
  codes: string[],
): { labels: Map<string, Record<string, string>> } | { error: string } {
  try {
    const decisions = loadOfferingDecisions();
    const odb = openOfferingsDb();
    try {
      const observed = observedTerms(odb);
      if (observed.length === 0)
        throw new Error("no schedule snapshots are held");
      const key = (c: string) => c.replace(/\s+/g, "").toUpperCase();
      const per = offeringsFor(odb, codes.map(key));
      const labels = new Map<string, Record<string, string>>();
      for (const c of codes) {
        const seasons = applyDecisions(
          seasonRollup(observed, per.get(key(c)) ?? []),
          decisions.get(key(c)),
        );
        const l: Record<string, string> = {};
        for (const [season, r] of Object.entries(seasons)) l[season] = r.label;
        labels.set(c, l);
      }
      return { labels };
    } finally {
      odb.close();
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export const programGraph: McpToolDefinition = {
  operation: "clemson.program_graph",
  // Core, not a load-on-demand tail tool (Chip, 2026-10-07): in Cob_advisor's
  // benchmark the model reached for it in 7/24 planning trials, and 10 of the
  // misses never loaded the tail at all.
  category: "core",
  tool: {
    name: "get-program-graph",
    description:
      "The degree as a GRAPH for one program and catalog year, in ONE call: " +
      "every requirement (from Degree Works when imported, else the catalog " +
      "plan's slots and choices), every planned course with its term, its " +
      "prerequisite rule as a structured expression, how many terms must come " +
      "before it (min_prior_terms, a lower bound from the prerequisite chain), " +
      "standing_floor (the first term in THIS plan that meets a class-standing " +
      "rule), review_note (a reviewer's note or correction to the catalog " +
      "wording — say it), and which seasons it usually runs. Pass completed_courses " +
      '(optionally with grades, "ACCT 2010:C") and standing to get a status ' +
      "per course: eligible (take_with = must be taken the same term as " +
      "these), conditional (coursework done, but the listed conditions such as " +
      "instructor consent or a test score must be confirmed), not_eligible, or " +
      "undetermined (the rule could not be read — quote unresolved to the " +
      "student). assumes lists grade minimums taken as met because no grade " +
      "was given. coreqs must be taken in the same term. required_by counts " +
      "courses that need this one; one_way_into counts courses where it is " +
      "only one option. slack = how many terms a planned course can slip " +
      "before graduation does; pass current_term for a student behind the " +
      "plan, or slack is measured as if they were on it. Use this FIRST for multi-semester planning or " +
      "'what should I take next' — instead of calling get-course-details " +
      "course by course. For 'what if he delays X / takes a term off / takes " +
      "X earlier', call what-if-plan: it computes the answer. critical_path is ONE " +
      "longest prerequisite chain; start it early. Several chains can tie, and " +
      "a tie means ALL of them are critical, not a choice between them: " +
      "critical_courses lists every course on any longest chain (plan order, " +
      "then unplanned prerequisites) — lead with it. critical_paths shows up to " +
      "20 of the tied chains; critical_paths_total is how many there are. " +
      "Prerequisite expressions: " +
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
            'Courses already completed, e.g. ["GC 1010", "ACCT 2010:C", ' +
            '"GC 3500:B@Summer 2026"]. A grade after a colon is checked against ' +
            'minimum-grade rules; an optional @term ("Summer 2026" or 202605) ' +
            "says when it was taken.",
        },
        standing: {
          type: "string",
          enum: [...STANDINGS],
          description: "The student's class standing, if known.",
        },
        current_term: {
          type: "string",
          description:
            "The student's CURRENT plan term, as the plan labels it ('Junior/Second " +
            "Semester'), not a calendar term. Courses planned before it and not in " +
            "completed_courses are overdue: they move to the first term they can " +
            "use from now on, and the answer is measured from there." +
            " Adds graduation_slip_terms (terms already behind; 0 = on plan), " +
            "plan_graduation_term, graduation_term and behind (where each " +
            "overdue course lands); slack is then measured from now.",
        },
        include_edges: {
          type: "boolean",
          description:
            "For a renderer drawing the map: also return edges[{from, to, kind}] " +
            "with kind required / one_of / same_term. Omit when answering a student.",
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

    const sa = parseStudentArgs(args);
    if ("error" in sa) return err(sa.error);
    const loaded = loadProgramGraph(program, year, sa.student);
    if ("error" in loaded) return err(loaded.error);
    const { graph } = loaded;

    const s = seasonLabelsFor(graph.courses.map((c) => c.code));
    if ("error" in s)
      graph.notes.push(`offering history unavailable: ${s.error}`);
    else
      for (const c of graph.courses)
        (c as unknown as Record<string, unknown>).seasons = s.labels.get(
          c.code,
        );

    // How long each planned course can wait, from the what-if engine with the
    // same seasons. A course whose slack cannot be computed simply has none.
    const seasonMap =
      "error" in s ? undefined : (s.labels as Map<string, SeasonLabels>);
    const done = new Set(sa.student?.completed.keys() ?? []);
    if (
      args.current_term !== undefined &&
      typeof args.current_term !== "string"
    )
      return err(
        'current_term must be a plan term label, e.g. "Junior/Second Semester"',
      );
    let now = args.current_term as string | undefined;
    if (now !== undefined && slotOf(now) === null)
      return err(
        `current_term "${now}" is not a recognised plan term label (e.g. "Junior/Second Semester")`,
      );
    let position: Record<string, unknown> = {};
    if (now !== undefined) {
      try {
        const r = whatIf(
          graph,
          loaded.planTerms,
          {
            changes: [],
            completed: done,
            now,
            completedInSummer: sa.student?.completedInSummer,
          },
          seasonMap,
        );
        position = {
          current_term: now,
          plan_graduation_term: r.plan_graduation_term,
          graduation_term: r.graduation_term,
          graduation_slip_terms: r.graduation_slip_terms,
          behind: r.behind,
        };
      } catch (e) {
        // A plan with no senior year has no graduation to measure: the graph
        // still answers, as slack already does (review 6).
        graph.notes.push(
          `current_term not applied: ${e instanceof Error ? e.message : String(e)}`,
        );
        now = undefined;
      }
    }
    for (const c of graph.courses) {
      if (!c.planned || c.choice || done.has(c.code)) continue;
      const slack = slackTerms(
        graph,
        loaded.planTerms,
        c.code,
        done,
        seasonMap,
        {
          ...(now !== undefined ? { now } : {}),
          completedInSummer: sa.student?.completedInSummer,
        },
      );
      if (slack !== undefined)
        (c as unknown as Record<string, unknown>).slack = slack;
    }

    return okJson({
      ...graph,
      ...position,
      ...(args.include_edges === true ? { edges: typedEdges(graph) } : {}),
      courses: graph.courses.map(compactCourse),
      encoding_note: COMPACT_NOTE,
      ...(sa.ignored.length ? { ignored_completed: sa.ignored } : {}),
    });
  },
};

registerTools([programGraph]);
