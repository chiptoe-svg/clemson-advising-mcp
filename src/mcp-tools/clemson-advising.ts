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

import { GC_ADVISOR_DB } from "../config.js";
import { openScheduleDb, getScheduleDbMeta } from "../clemson-schedule-db.js";
import { searchClemsonClasses } from "../clemson-classes.js";
import { querySectionsEngine, type EngineSection } from "./section-query.js";
import { resolveTerm } from "../term-resolve.js";
import { getGcRequirementRules as getGcRequirementRulesLive } from "../gc-curriculum.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Live-seat refresh (opt-in). When a caller passes refresh:true, overlay live
// Banner seat counts onto a snapshot-derived result — a TARGETED re-query of
// only the subjects already in the result, never a full-term reingest. Capped
// so a broad, many-subject result can't fan out into a live-Banner storm.
// ---------------------------------------------------------------------------

/** Max distinct subjects to re-query live before we decline and ask to narrow. */
export const MAX_REFRESH_SUBJECTS = 8;

/** A section object as returned by the advising tools (snake_case seat fields). */
export interface OverlaySection {
  crn: string;
  subject_course: string;
  seats_available: number;
  enrollment: number;
  max_enrollment: number;
  open: boolean;
}

/** The only live-seat fields the overlay reads back, per section. */
interface LiveSeatRow {
  crn: string;
  enrollment: number;
  maxEnrollment: number;
  seatsAvailable: number;
  open: boolean;
}

type LiveFetcher = (params: {
  term: string;
  subject: string;
  refresh: true;
}) => Promise<{ sections: LiveSeatRow[] } | null>;

/** Subject prefix of a subject_course, e.g. "GC3010"/"GC 3010" -> "GC". */
function subjectOf(subjectCourse: string): string {
  const m = /^([A-Za-z]+)/.exec(subjectCourse.trim());
  return m ? m[1].toUpperCase() : "";
}

/**
 * Overlay live Banner seat counts onto `sections` IN PLACE and return a summary
 * describing what happened. Groups by subject, re-queries each subject live
 * (capped at MAX_REFRESH_SUBJECTS), and updates seats for every CRN it can
 * match; unmatched CRNs keep their snapshot numbers and are counted as stale.
 * A subject whose live query fails leaves its CRNs stale rather than erroring
 * the whole call.
 */
export async function overlayLiveSeats(
  term: string,
  sections: OverlaySection[],
  fetchLive: LiveFetcher = searchClemsonClasses,
): Promise<Record<string, unknown>> {
  const subjects = [...new Set(sections.map((s) => subjectOf(s.subject_course)))].filter(Boolean);

  if (subjects.length > MAX_REFRESH_SUBJECTS) {
    return {
      refreshed: false,
      reason: "too_many_subjects",
      subject_count: subjects.length,
      note:
        `Live refresh spans ${subjects.length} subjects (max ${MAX_REFRESH_SUBJECTS}). ` +
        `Seats shown are from the daily snapshot — narrow the search (a subject, ` +
        `tighter days/time, or more open seats) and refresh again for live counts.`,
    };
  }

  const results = await Promise.allSettled(
    subjects.map((subject) => fetchLive({ term, subject, refresh: true })),
  );

  const live = new Map<string, LiveSeatRow>();
  const subjectsFailed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      for (const sec of r.value.sections) live.set(sec.crn, sec);
    } else {
      subjectsFailed.push(subjects[i]);
    }
  });

  let updated = 0;
  let stale = 0;
  for (const s of sections) {
    const hit = live.get(s.crn);
    if (hit) {
      s.seats_available = hit.seatsAvailable;
      s.enrollment = hit.enrollment;
      s.max_enrollment = hit.maxEnrollment;
      s.open = hit.open;
      updated++;
    } else {
      stale++;
    }
  }

  return {
    refreshed: updated > 0,
    seats_as_of: new Date().toISOString(),
    subjects_queried: subjects,
    subjects_failed: subjectsFailed,
    crns_updated: updated,
    crns_stale: stale,
    ...(subjectsFailed.length || stale
      ? {
          note:
            "Some sections could not be refreshed live and still show snapshot " +
            "seats (crns_stale). Confirm those in Banner.",
        }
      : {}),
  };
}

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
      "SELECT slot_type, rule FROM requirement_rule WHERE program_id = ? AND slot_type = ? LIMIT 1",
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

function checkPrereqEligible(
  prereqParsed: string | null,
  completedCourses: Set<string>,
): boolean {
  if (!prereqParsed) return true;
  let codes: string[];
  try {
    codes = JSON.parse(prereqParsed) as string[];
  } catch {
    return true;
  }
  if (!Array.isArray(codes) || codes.length === 0) return true;
  // prereq_parsed is a flat list of codes; ALL must be completed.
  // (Simplification — raw_text may have OR logic; agent can read prereq_text for full rule.)
  // completedCourses is already normalized (spaceless upper); normalize each code too.
  return codes.every((c) => completedCourses.has(normCode(c)));
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
  tool: {
    name: "find-requirement-sections",
    description:
      "Find sections that fill a named degree requirement slot and that the " +
      "student is eligible to take (prerequisites checked against " +
      "completed_courses). Requires requirement — the requirement slot " +
      "name; an unknown name returns the valid slot list. Optional: " +
      "completed_courses, fits_around_crns, days, no_meeting_before, " +
      "no_meeting_after, exclude_days, open_seats_only, program, " +
      "catalog_year. Term is optional — defaults to the current " +
      "registration term.",
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
            "in this set.",
        },
        no_meeting_before: {
          type: "string",
          description:
            "Optional HHMM string, e.g. '0900'. Excludes a section if ANY " +
            "of its meetings starts before this time.",
        },
        no_meeting_after: {
          type: "string",
          description:
            "Optional HHMM string, e.g. '1700'. Excludes a section if ANY " +
            "of its meetings ends after this time.",
        },
        exclude_days: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional day codes to avoid, e.g. ['F'] (M T W R F S U). " +
            "Excludes a section if ANY of its meetings falls on one of " +
            "these days.",
        },
        open_seats_only: {
          type: "boolean",
          description:
            "Optional. If true, excludes sections with seats_available <= 0.",
        },
        program: {
          type: "string",
          description:
            "GC program name (default 'Graphic Communications, BS').",
        },
        catalog_year: {
          type: "string",
          description:
            "Optional catalog year label, e.g. '2025-2026', to pick the " +
            "requirement rule for a student grandfathered into an older " +
            "catalog. Default: latest catalog year for program.",
        },
      },
      required: ["requirement"],
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

    const programName =
      typeof args.program === "string" && args.program
        ? args.program
        : "Graphic Communications, BS";

    const catalogYear =
      typeof args.catalog_year === "string" && args.catalog_year
        ? args.catalog_year
        : undefined;

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

      const rule = getRequirementRule(schedDb, programId, requirement);
      if (!rule) {
        // Unknown slot — the discriminator redirect: list the valid slot
        // names inline (from gc_advisor's req-rules bridge) rather than
        // making the caller round-trip to get-gc-requirement-rules itself.
        const yearLabel = catalogYear ?? getCatalogYearLabelForProgram(schedDb, programId);
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
          prereqEligible: checkPrereqEligible(courseInfo?.prereq_parsed ?? null, completedSet),
          prereqText: courseInfo?.prereq_text ?? null,
        };
      });

      const result: Record<string, unknown> = {
        term,
        term_description: meta.termDescription,
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
// get-program-requirements — surfaces the requirement_rule rows in
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
  tool: {
    name: "get-program-requirements",
    description:
      "Get the requirement rules a Clemson MINOR or CERTIFICATE requires " +
      "(total credits, required courses, elective rules) from the catalog. " +
      "Use for 'what does the Accounting minor require?'. Partial/misspelled " +
      "names return candidate program names to pick from. NOTE: only " +
      "Graphic Communications, BS has a full semester-by-semester plan — use " +
      "get-gc-program-plan for that; other full majors are not loaded.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Program name, e.g. 'Accounting Minor' or 'Cybersecurity Minor'. " +
            "A partial name returns candidates.",
        },
        year: {
          type: "string",
          description:
            "Optional catalog year, e.g. '2025-2026'. Defaults to the latest.",
        },
      },
      required: ["name"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_program_requirements");
    } catch (e) {
      return permissionErr(e);
    }

    const name = args.name as string | undefined;
    if (!name || typeof name !== "string" || !name.trim())
      return err("name is required");

    const year =
      typeof args.year === "string" && args.year ? args.year : undefined;

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
        .prepare("SELECT slot_type, rule FROM requirement_rule WHERE program_id = ?")
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

      return okJson({
        program: exactRow.name,
        catalog_year: exactRow.year,
        requirements,
        _source: "Clemson Online Catalog (gc_advisor)",
        note:
          "Minor/certificate requirement rules. Only Graphic Communications, " +
          "BS has a full semester-by-semester plan (get-gc-program-plan).",
      });
    } finally {
      db.close();
    }
  },
};

// Report when a term's Banner snapshot was last ingested — the "data as of"
// for every seat/section/time/room answer. Reads only the snapshot's meta row,
// so it puts no load on Banner and is safe to call freely.
export const scheduleFreshness: McpToolDefinition = {
  operation: "clemson.schedule_freshness",
  tool: {
    name: "get-schedule-freshness",
    description:
      "Report when the Banner class-schedule snapshot for a term was last " +
      "ingested — the 'data as of' time behind every seat count, section, " +
      "meeting time, and room this assistant reports. Read-only and cheap: it " +
      "reads only the snapshot's metadata, with NO Banner load. Use it to tell " +
      "an advisor how current the seat numbers are, or to check whether a term " +
      "has been ingested yet. The snapshot refreshes automatically each morning " +
      "(~05:00 Eastern). Returns has_snapshot:false for a term not yet ingested.",
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
          `No Banner snapshot for term ${term} yet. Snapshots are ingested ` +
          `automatically each morning (~05:00 Eastern).`,
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

registerTools([
  findRequirementSections,
  getProgramRequirements,
  scheduleFreshness,
]);
