// src/mcp-tools/clemson-advising.ts
// Catalog + schedule join tool for GC advising.
//
// find-requirement-sections opens the per-term schedule DB, ATTACHes
// gc_advisor.db, resolves the named requirement slot to its explicit course
// list in SQL, then routes each course's section-side filtering (fits_around_
// crns/days/exclude_days/no_meeting_before/after/open_seats_only) through the
// shared querySectionsEngine (src/mcp-tools/section-query.ts) — one call per
// explicit course code (the engine's own discriminator is subject+course
// number, not a course-code list, so this tool enforces the requirement
// discriminator itself and merges the per-course results). Prereq eligibility
// is checked in TypeScript (parse prereq_parsed JSON, test subset of
// completed_courses). Reshaped from the former find-eligible-sections; see
// .superpowers/sdd/task-6-brief.md.
import Database from "better-sqlite3";

import { GC_ADVISOR_DB } from "../config-mcp.js";
import { openScheduleDb, getScheduleDbMeta } from "../clemson-schedule-db.js";
import { querySectionsEngine, type EngineSection } from "./section-query.js";
import { resolveTerm } from "../term-resolve.js";
import { getGcRequirementRules as getGcRequirementRulesLive } from "../gc-curriculum.js";
import { UNTIMED_FILTER_NOTE } from "./section-query.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";
import {
  CATALOG_YEAR_ARG_DESCRIPTION,
  NAME_ALIAS_DESCRIPTION,
  PROGRAM_ARG_DESCRIPTION,
  YEAR_ALIAS_DESCRIPTION,
  missingProgramMessage,
  resolveCatalogYearArg,
  resolveProgramArg,
} from "./program-args.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequirementRule {
  slot_type: string;
  total_credits: number;
  explicit_courses: string[];
  raw_text: string;
}

interface CourseRow {
  code: string;
  prereq_text: string | null;
  prereq_parsed: string | null; // JSON array of course codes
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// gc_advisor stores course codes with a space ("GC 3010"); Banner's schedule DB
// stores subject_course spaceless ("GC3010"). Normalize both sides to spaceless
// upper-case before any cross-source comparison, or every join silently misses.
function normCode(code: string): string {
  return code.replace(/\s+/g, "").toUpperCase();
}

function getLatestProgramId(
  db: Database.Database,
  programName: string,
): number | null {
  const row = db
    .prepare(
      `SELECT p.id FROM program p
       JOIN catalog_year cy ON p.catalog_year_id = cy.id
       WHERE p.name = ?
       ORDER BY cy.label DESC LIMIT 1`,
    )
    .get(programName) as { id: number } | undefined;
  return row?.id ?? null;
}

// Year-aware sibling of getLatestProgramId — picks the program row for a
// specific catalog_year.label (e.g. "2025-2026") instead of always the
// newest, so a student grandfathered into an older catalog gets that
// catalog's requirement rule (course lists/credit totals can differ by year).
function getProgramIdForCatalogYear(
  db: Database.Database,
  programName: string,
  catalogYear: string,
): number | null {
  const row = db
    .prepare(
      `SELECT p.id FROM program p
       JOIN catalog_year cy ON p.catalog_year_id = cy.id
       WHERE p.name = ? AND cy.label = ? LIMIT 1`,
    )
    .get(programName, catalogYear) as { id: number } | undefined;
  return row?.id ?? null;
}

// The catalog_year LABEL a given program row belongs to — needed to call
// getGcRequirementRules (the gc_advisor query.py bridge, which takes a year
// string, not an id) when a requirement lookup misses and the valid slot
// list must be fetched for the redirect.
function getCatalogYearLabelForProgram(
  db: Database.Database,
  programId: number,
): string | null {
  const row = db
    .prepare(
      `SELECT cy.label FROM program p
       JOIN catalog_year cy ON p.catalog_year_id = cy.id
       WHERE p.id = ? LIMIT 1`,
    )
    .get(programId) as { label: string } | undefined;
  return row?.label ?? null;
}

// Split a catalog course code ("GC 3010", "gc3010", "GC 3010H") into the
// subject + course-number pieces querySectionsEngine's exact-match filter
// wants ({subject, courseNumber}, both upper-cased to match Banner's
// subject_course convention). Returns null for anything that doesn't fit the
// pattern (e.g. a wildcard rule name rather than a real course code).
function splitCourseCode(code: string): { subject: string; courseNumber: string } | null {
  const m = /^\s*([A-Za-z]{2,6})\s*(\d{3,4}[A-Za-z]?)\s*$/.exec(code);
  return m ? { subject: m[1].toUpperCase(), courseNumber: m[2].toUpperCase() } : null;
}

function nonEmptyStrArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string");
  return arr.length > 0 ? arr : undefined;
}

function getRequirementRule(
  db: Database.Database,
  programId: number,
  slotType: string,
): RequirementRule | null {
  const row = db
    .prepare(
      "SELECT slot_type, rule FROM requirement_rule_effective WHERE program_id = ? AND slot_type = ? LIMIT 1",
    )
    .get(programId, slotType) as { slot_type: string; rule: string } | undefined;
  if (!row) return null;
  let parsed: { total_credits?: number; explicit_courses?: string[]; raw_text?: string };
  try {
    parsed = JSON.parse(row.rule) as typeof parsed;
  } catch {
    return null;
  }
  return {
    slot_type: row.slot_type,
    total_credits: parsed.total_credits ?? 0,
    explicit_courses: parsed.explicit_courses ?? [],
    raw_text: parsed.raw_text ?? "",
  };
}

/**
 * Whether a student's completed courses satisfy a course's prerequisites.
 *
 * THREE STATES, NOT A BOOLEAN (2026-08-28). `prereq_parsed` is a FLAT LIST of
 * codes; the real rule lives in `prereq_text` and is frequently not a
 * conjunction. Treating the list as "all of these" produced confident FALSE
 * NEGATIVES on required coursework:
 *
 *   MKT 3010  prereq_text   "ECON 2000 or ECON 2110 or ECON 2120 or any
 *                            2000-level AGRB course; and sophomore standing"
 *             prereq_parsed ["ECON 2000","ECON 2110","ECON 2120"]
 *
 * A Marketing student holding ECON 2110 was told they were ineligible for the
 * gateway course of their own major. Measured across the catalog: 2,624 courses
 * carry prereq_text, 927 contain OR, 369 carry a grade minimum the flat list
 * drops, and 820 have prereq text that did not parse AT ALL — those last read as
 * prereq-FREE, which is the OPPOSITE error and admits students who cannot enrol.
 *
 * So the answer is "yes", "no", or "I cannot tell from this" — and the third is
 * a permanent state, not a placeholder. A future prereq expression in core
 * resolves the OR structure; it does not make a grade minimum, a standing gate,
 * a consent requirement, or an unparsed text determinate. Those live here
 * forever. (Endorsed as the end state by the core maintainer, 2026-08-28.)
 *
 * Callers already receive `prereqText` alongside this field, so an
 * "undetermined" answer costs them nothing: the real rule is in their hands.
 *
 * This is the same defect shape as the PCID miss (find-course-in-program):
 * a tool reading its own partial view and reporting a confident negative.
 */
export type PrereqEligibility = "eligible" | "not_eligible" | "undetermined";

/** OR / grade / standing / consent markers that a flat code list cannot express. */
const PREREQ_UNDETERMINABLE =
  /\bor\b|\bconcurrent|\bconsent\b|\bpermission\b|\bstanding\b|\bminimum grade\b|\bgrade of\b|\bC or better\b/i;

export function checkPrereqEligible(
  prereqParsed: string | null,
  completedCourses: Set<string>,
  prereqText: string | null = null,
): PrereqEligibility {
  // No stated prerequisite at all: genuinely eligible.
  const hasText = typeof prereqText === "string" && prereqText.trim() !== "";
  if (!prereqParsed) {
    // Text present but nothing parsed (820 courses) — the rule exists and we
    // cannot read it. Reporting "eligible" here is a false POSITIVE.
    return hasText ? "undetermined" : "eligible";
  }
  let codes: string[];
  try {
    codes = JSON.parse(prereqParsed) as string[];
  } catch {
    return hasText ? "undetermined" : "eligible";
  }
  if (!Array.isArray(codes) || codes.length === 0) {
    return hasText ? "undetermined" : "eligible";
  }
  // completedCourses is already normalized (spaceless upper); normalize each code too.
  const satisfiedAll = codes.every((c) => completedCourses.has(normCode(c)));
  // ALL of a flat list satisfied implies the rule holds under any reading —
  // an OR is satisfied a fortiori — so "eligible" is safe even when the text
  // carries structure this function cannot parse.
  if (satisfiedAll) return "eligible";
  // Not all satisfied. Only a text we can be confident is a pure conjunction
  // justifies "not_eligible"; anything else is undetermined.
  if (hasText && PREREQ_UNDETERMINABLE.test(prereqText)) return "undetermined";
  return "not_eligible";
}

// ---------------------------------------------------------------------------
// MCP tool
// ---------------------------------------------------------------------------

/** Injectable for tests — defaults to the real gc_advisor query.py bridge.
 *  Mirrors core-search.ts's makeSearchClasses/makeGetCourseDetails DI idiom,
 *  needed here so the unknown-requirement redirect (which shells out to
 *  gc_advisor for the valid slot list) is testable without a real
 *  subprocess. */
export interface FindRequirementSectionsDeps {
  getGcRequirementRules: typeof getGcRequirementRulesLive;
}

export function makeFindRequirementSections(
  deps: Partial<FindRequirementSectionsDeps> = {},
): McpToolDefinition {
  const getReqRules = deps.getGcRequirementRules ?? getGcRequirementRulesLive;
  return {
  operation: "clemson.find_requirement_sections",
  category: "core",
  tool: {
    name: "find-requirement-sections",
    description:
      "Find sections that fill a named degree requirement slot and that the " +
      "student is eligible to take (prerequisites checked against " +
      "completed_courses). `prereqEligible` is THREE-VALUED — \"eligible\", " +
      "\"not_eligible\", or \"undetermined\" — never a boolean. " +
      "\"undetermined\" means the stated rule cannot be decided from the " +
      "structured data (it contains OR, a grade minimum, a standing or consent " +
      "gate, or did not parse); READ `prereqText` and say what the rule " +
      "actually is rather than reporting the student ineligible. Roughly a " +
      "third of Clemson courses with prerequisites fall in this class. " +
      "Requires requirement — the requirement slot " +
      "name; an unknown name returns the valid slot list — and program, " +
      "which has no default. Optional: catalog_year (defaults to the " +
      "program's latest), completed_courses, fits_around_crns, days, " +
      "no_meeting_before, no_meeting_after, exclude_days, open_seats_only. " +
      "Term is optional — defaults to the current registration term.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            "Term code (202608) or text ('Spring 2027'). Defaults to the " +
            "current registration term.",
        },
        requirement: {
          type: "string",
          description:
            "Requirement slot to fill, from get-gc-requirement-rules, " +
            "e.g. 'Specialty Area Requirement'. An unknown value returns " +
            "the valid slot list for the resolved program/catalog year.",
        },
        completed_courses: {
          type: "array",
          items: { type: "string" },
          description:
            "Course codes the student has completed, e.g. [\"GC 1010\"] " +
            "— used only for prereq gating, no identity or grade data needed.",
        },
        fits_around_crns: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional CRNs already on the student's schedule. Excludes a " +
            "section if any of its meetings time-conflicts (same day, " +
            "overlapping interval) with any meeting of these CRNs.",
        },
        days: {
          type: "string",
          description:
            "Optional day pattern using M T W R F S U, e.g. 'MWF' — a " +
            "section qualifies only if EVERY one of its meeting days is " +
            "in this set." + UNTIMED_FILTER_NOTE,
        },
        no_meeting_before: {
          type: "string",
          description:
            "Optional HHMM string, e.g. '0900'. Excludes a section if ANY " +
            "of its meetings starts before this time." + UNTIMED_FILTER_NOTE,
        },
        no_meeting_after: {
          type: "string",
          description:
            "Optional HHMM string, e.g. '1700'. Excludes a section if ANY " +
            "of its meetings ends after this time." + UNTIMED_FILTER_NOTE,
        },
        exclude_days: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional day codes to avoid, e.g. ['F'] (M T W R F S U). " +
            "Excludes a section if ANY of its meetings falls on one of " +
            "these days." + UNTIMED_FILTER_NOTE,
        },
        open_seats_only: {
          type: "boolean",
          description:
            "Optional. If true, excludes sections with seats_available <= 0.",
        },
        program: { type: "string", description: PROGRAM_ARG_DESCRIPTION },
        catalog_year: {
          type: "string",
          description:
            CATALOG_YEAR_ARG_DESCRIPTION +
            " Optional here: omit it to use the latest catalog year for the " +
            "program, or pass an older one for a grandfathered student. The " +
            "year actually used is echoed back as catalog_year.",
        },
      },
      // `program` is deliberately NOT in `required`, even though it has no
      // default: the advisor fills an omitted program from the session's
      // selection inside execute (advisor-agent.ts's withSessionDefaults),
      // which runs AFTER the harness validates the model's own arguments —
      // a schema-required program would reject the call before that fill can
      // happen. The handler is the enforcement point; the description says so.
      required: ["requirement"],
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.find_requirement_sections");
    } catch (e) {
      return permissionErr(e);
    }

    const resolved = resolveTerm(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in resolved) return err(resolved.error);
    const term = resolved.term;

    const requirement =
      typeof args.requirement === "string" ? args.requirement.trim() : "";
    if (!requirement) {
      return err(
        "requirement is required — the requirement slot name (from " +
          "get-gc-requirement-rules), e.g. 'Specialty Area Requirement'.",
      );
    }

    const programName = resolveProgramArg(args);
    if (!programName) return err(missingProgramMessage());

    const catalogYear = resolveCatalogYearArg(args) ?? undefined;

    const completedCoursesArr = Array.isArray(args.completed_courses)
      ? (args.completed_courses as unknown[]).filter(
          (c): c is string => typeof c === "string",
        )
      : [];

    const fitsAroundCrns = nonEmptyStrArr(args.fits_around_crns);
    const days =
      typeof args.days === "string" && args.days ? args.days : undefined;
    const excludeDays = nonEmptyStrArr(args.exclude_days);
    const noMeetingBefore =
      typeof args.no_meeting_before === "string" && args.no_meeting_before
        ? args.no_meeting_before
        : undefined;
    const noMeetingAfter =
      typeof args.no_meeting_after === "string" && args.no_meeting_after
        ? args.no_meeting_after
        : undefined;
    const openSeatsOnly = args.open_seats_only === true;

    const appliedConstraints: Record<string, unknown> = {};
    if (catalogYear) appliedConstraints.catalog_year = catalogYear;
    if (fitsAroundCrns) appliedConstraints.fits_around_crns = fitsAroundCrns;
    if (days) appliedConstraints.days = days.toUpperCase();
    if (excludeDays) appliedConstraints.exclude_days = excludeDays.map((d) => d.toUpperCase());
    if (noMeetingBefore) appliedConstraints.no_meeting_before = noMeetingBefore;
    if (noMeetingAfter) appliedConstraints.no_meeting_after = noMeetingAfter;
    if (openSeatsOnly) appliedConstraints.open_seats_only = true;

    const schedDb = openScheduleDb(term);
    if (!schedDb)
      return err(
        `No Banner snapshot available for term ${term}. Try again after the 05:00 daily refresh.`,
      );

    try {
      // ATTACH the catalog DB so we can query it alongside the schedule.
      schedDb.prepare("ATTACH DATABASE ? AS catalog").run(GC_ADVISOR_DB);

      const programId = catalogYear
        ? getProgramIdForCatalogYear(schedDb, programName, catalogYear)
        : getLatestProgramId(schedDb, programName);
      if (programId === null) {
        return err(
          catalogYear
            ? `Program "${programName}" not found for catalog year "${catalogYear}" in gc_advisor.db. ` +
                "Check the year and name with get-gc-program-plan, or omit catalog_year for the latest."
            : `Program "${programName}" not found in gc_advisor.db. ` +
                "Check the name with get-gc-program-plan.",
        );
      }

      // The year the answer is actually built from, echoed on every response
      // so the caller never has to guess which catalog it got.
      const resolvedYear =
        catalogYear ?? getCatalogYearLabelForProgram(schedDb, programId);

      const rule = getRequirementRule(schedDb, programId, requirement);
      if (!rule) {
        // Unknown slot — the discriminator redirect: list the valid slot
        // names inline (from gc_advisor's req-rules bridge) rather than
        // making the caller round-trip to get-gc-requirement-rules itself.
        const yearLabel = resolvedYear;
        let validSlots: string[] = [];
        try {
          const rows = (await getReqRules(yearLabel ?? "", programName)) as unknown;
          if (Array.isArray(rows)) {
            validSlots = rows
              .map((r) =>
                r && typeof r === "object" && typeof (r as { slot_type?: unknown }).slot_type === "string"
                  ? (r as { slot_type: string }).slot_type
                  : null,
              )
              .filter((s): s is string => s !== null);
          }
        } catch {
          // gc_advisor unreachable — fall through with an empty valid-slot
          // list rather than failing the whole call with a subprocess error.
        }
        return err(
          `Unknown requirement "${requirement}" for program "${programName}"` +
            `${yearLabel ? ` (${yearLabel})` : ""}. ` +
            (validSlots.length > 0
              ? `Valid requirement slots: ${validSlots.join(", ")}.`
              : "No requirement slots could be found for this program/catalog year."),
        );
      }

      const meta = getScheduleDbMeta(schedDb);

      if (rule.explicit_courses.length === 0) {
        return okJson({
          term,
          term_description: meta.termDescription,
          program: programName,
          catalog_year: resolvedYear,
          requirement,
          total_credits_required: rule.total_credits,
          sections: [],
          applied_constraints: appliedConstraints,
          data_as_of: meta.fetchedAt,
          _source: `Clemson University Online Catalog (gc_advisor) + Banner schedule ${meta.fetchedAt}`,
          note:
            "This requirement rule has no explicit course list — it may be " +
            "satisfied by a declared minor or a broad course category. " +
            "Use get-gc-requirement-rules for the full raw_text.",
        });
      }

      // Discriminator enforcement: querySectionsEngine's own bounding filter
      // is subject+courseNumber (a single course), not a course-code list —
      // it has no guard for "any of these N explicit courses" — so THIS tool
      // enforces the requirement's course list itself: one engine call per
      // explicit course (exact subject_course match), merging the results.
      // Every scheduling-side filter (fits_around_crns/days/exclude_days/
      // no_meeting_before/after/open_seats_only) is applied identically on
      // every call, reusing the engine's SQL + day/time/fit logic verbatim
      // instead of re-deriving it here.
      const merged: EngineSection[] = [];
      const unparseableCourses: string[] = [];
      const narrowedCourses: string[] = [];
      for (const code of rule.explicit_courses) {
        const split = splitCourseCode(code);
        if (!split) {
          unparseableCourses.push(code);
          continue;
        }
        const engineResult = querySectionsEngine({
          term,
          subject: split.subject,
          courseNumber: split.courseNumber,
          days,
          excludeDays,
          noMeetingBefore,
          noMeetingAfter,
          openSeatsOnly,
          fitsAroundCrns,
          max: 500,
        });
        if ("error" in engineResult) return err(engineResult.error);
        if (engineResult.needsNarrowing) {
          // A single explicit course offering >15 sections in one term is an
          // edge case the engine's NARROW_THRESHOLD doesn't expect a caller
          // to hit per-course — note it rather than silently dropping those
          // sections from the merged result.
          narrowedCourses.push(code);
          continue;
        }
        merged.push(...engineResult.sections);
      }
      merged.sort((a, b) => b.seatsAvailable - a.seatsAvailable);

      const noteParts: string[] = [];
      if (unparseableCourses.length > 0) {
        noteParts.push(
          `${unparseableCourses.length} course code(s) in this requirement's list ` +
            `could not be parsed and were skipped: ${unparseableCourses.join(", ")}.`,
        );
      }
      if (narrowedCourses.length > 0) {
        noteParts.push(
          `${narrowedCourses.length} course(s) offer more sections than can be listed ` +
            `here and were omitted — narrow with days/exclude_days/no_meeting_before/after: ` +
            `${narrowedCourses.join(", ")}.`,
        );
      }

      if (merged.length === 0) {
        return okJson({
          term,
          term_description: meta.termDescription,
          program: programName,
          catalog_year: resolvedYear,
          requirement,
          total_credits_required: rule.total_credits,
          sections: [],
          applied_constraints: appliedConstraints,
          data_as_of: meta.fetchedAt,
          _source: `Clemson University Online Catalog (gc_advisor) + Banner schedule ${meta.fetchedAt}`,
          note:
            noteParts.length > 0
              ? noteParts.join(" ")
              : "No sections are offered in this term for this requirement's course list.",
        });
      }

      // subject_course is spaceless ("GC3010"); catalog.course.code is spaced
      // ("GC 3010"). Compare space-insensitively and key the map spaceless so
      // the per-section lookup below (keyed on subjectCourse) hits.
      const subjectCourses = [...new Set(merged.map((s) => s.subjectCourse))];
      const scPhs = subjectCourses.map(() => "?").join(",");
      const courseRows = schedDb
        .prepare(
          `SELECT code, prereq_text, prereq_parsed
           FROM catalog.course WHERE REPLACE(code, ' ', '') IN (${scPhs})`,
        )
        .all(...subjectCourses) as CourseRow[];
      const courseMap = new Map(courseRows.map((c) => [normCode(c.code), c]));
      const completedSet = new Set(completedCoursesArr.map(normCode));

      const sections = merged.map((s) => {
        const courseInfo = courseMap.get(normCode(s.subjectCourse));
        return {
          ...s,
          prereqEligible: checkPrereqEligible(
            courseInfo?.prereq_parsed ?? null,
            completedSet,
            courseInfo?.prereq_text ?? null,
          ),
          prereqText: courseInfo?.prereq_text ?? null,
        };
      });

      const result: Record<string, unknown> = {
        term,
        term_description: meta.termDescription,
        program: programName,
        catalog_year: resolvedYear,
        requirement,
        total_credits_required: rule.total_credits,
        total_matched: sections.length,
        sections,
        applied_constraints: appliedConstraints,
        data_as_of: meta.fetchedAt,
        _source: `Clemson University Online Catalog (gc_advisor) + Banner schedule ${meta.fetchedAt}`,
      };
      if (noteParts.length > 0) result.note = noteParts.join(" ");

      return okJson(result);
    } finally {
      try {
        schedDb.prepare("DETACH DATABASE catalog").run();
      } catch {
        /* ok */
      }
      schedDb.close();
    }
  },
  };
}

export const findRequirementSections: McpToolDefinition = makeFindRequirementSections();

// ---------------------------------------------------------------------------
// get-program-requirements — surfaces the requirement_rule_effective rows (gc_advisor's bogus-filtered view) in
// gc_advisor.db for any program (minor, certificate, or the GC BS), by name.
// Unlike find-requirement-sections this does NOT open a Banner schedule
// snapshot — it's a pure read of the catalog DB, so the GC program-loaded
// restriction that gates that tool doesn't apply here: any of the 133
// minors/certificates plus the GC BS can be looked up.
// ---------------------------------------------------------------------------

interface ProgramRow {
  id: number;
  name: string;
  year: string;
}

export const getProgramRequirements: McpToolDefinition = {
  operation: "clemson.gc_program_requirements",
  category: "curriculum-extras",
  tool: {
    name: "get-program-requirements",
    description:
      "Get the requirement rules a Clemson MINOR or CERTIFICATE requires " +
      "(total credits, required courses, elective rules) from the catalog. " +
      "Use for 'what does the Accounting minor require?'. Partial/misspelled " +
      "names return candidate program names to pick from. Some majors also " +
      "have a full semester-by-semester plan — the response lists which " +
      "(programs_with_full_plan); use get-gc-program-plan for those. " +
      "Takes program + catalog_year; there is no default program.",
    inputSchema: {
      type: "object" as const,
      properties: {
        program: {
          type: "string",
          description:
            "Program name, e.g. 'Accounting Minor' or 'Cybersecurity Minor'. " +
            "Any catalog program — minor, certificate, or major — not only " +
            "the eight selectable degree programs. A partial name returns " +
            "candidates. Required; there is no default.",
        },
        catalog_year: {
          type: "string",
          description:
            CATALOG_YEAR_ARG_DESCRIPTION + " Optional; defaults to the latest.",
        },
        name: { type: "string", description: NAME_ALIAS_DESCRIPTION },
        year: { type: "string", description: YEAR_ALIAS_DESCRIPTION },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_program_requirements");
    } catch (e) {
      return permissionErr(e);
    }

    const name = resolveProgramArg(args);
    if (!name)
      return err(
        missingProgramMessage(
          " This tool also accepts any minor or certificate by its full " +
            "catalog name.",
        ),
      );

    const year = resolveCatalogYearArg(args) ?? undefined;

    let db: Database.Database;
    try {
      db = new Database(GC_ADVISOR_DB, { readonly: true });
    } catch {
      return err(
        `Could not open the Clemson catalog database (gc_advisor.db). It may not be loaded yet.`,
      );
    }

    try {
      const exactRow = db
        .prepare(
          `SELECT p.id, p.name, cy.label AS year FROM program p
           JOIN catalog_year cy ON p.catalog_year_id = cy.id
           WHERE LOWER(p.name) = LOWER(?) ${year ? "AND cy.label = ?" : ""}
           ORDER BY cy.label DESC LIMIT 1`,
        )
        .get(...(year ? [name, year] : [name])) as ProgramRow | undefined;

      if (!exactRow) {
        const candidates = db
          .prepare(
            "SELECT DISTINCT name FROM program WHERE name LIKE ? ORDER BY name LIMIT 20",
          )
          .all(`%${name}%`) as { name: string }[];

        if (candidates.length > 0) {
          return okJson({
            query: name,
            candidates: candidates.map((c) => c.name),
            note: "No exact match — pick one of these program names and call again.",
          });
        }

        return err(
          `No Clemson program matches "${name}". Check the spelling, or ask for a minor/certificate by its full name.`,
        );
      }

      const ruleRows = db
        .prepare("SELECT slot_type, rule FROM requirement_rule_effective WHERE program_id = ?")
        .all(exactRow.id) as { slot_type: string; rule: string }[];

      const requirements: Record<string, unknown>[] = [];
      for (const row of ruleRows) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.rule) as Record<string, unknown>;
        } catch {
          continue;
        }
        requirements.push({ slot_type: row.slot_type, ...parsed });
      }

      const withPlan = db
        .prepare(
          `SELECT DISTINCT p.name FROM plan_item pi
           JOIN requirement_group rg ON pi.group_id = rg.id
           JOIN program p ON rg.program_id = p.id
           JOIN catalog_year cy ON p.catalog_year_id = cy.id
           WHERE cy.label = ? ORDER BY p.name`,
        )
        .all(exactRow.year) as { name: string }[];

      return okJson({
        program: exactRow.name,
        catalog_year: exactRow.year,
        requirements,
        _source: "Clemson Online Catalog (gc_advisor)",
        programs_with_full_plan: withPlan.map((r) => r.name),
      });
    } finally {
      db.close();
    }
  },
};

registerTools([
  findRequirementSections,
  getProgramRequirements,
]);
