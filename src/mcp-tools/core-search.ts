// src/mcp-tools/core-search.ts
//
// The four "front door" tools on the public MCP server (8766): search-classes,
// find-alternatives, check-conflicts, get-course-details. This is the
// task-aligned replacement for search-clemson-classes, get-clemson-section-
// details, find-clemson-instructor-classes, get-clemson-room-availability
// (all formerly in clemson-classes.ts) and check-schedule-conflicts (formerly
// in clemson-schedule.ts) — a breaking, no-aliases change by design. See
// .superpowers/sdd/task-5-brief.md.
//
// Every front door resolves term FIRST via resolveTerm (Task 1, src/term-
// resolve.ts): a TermError becomes `err(<its error text>)` verbatim — the
// "redirect" that steers a model toward a valid term instead of guessing one.
// search-classes and find-alternatives then compose querySectionsEngine
// (Task 2, ./section-query.ts) — the shared snapshot-backed filter pipeline.
// querySectionsEngine itself enforces NO required discriminator, so each tool
// here supplies its own (subject/course_number, current_crns, crns,
// course_code/crn) to avoid an unbounded scan.
import {
  searchClemsonClasses as searchClemsonClassesLive,
  getClemsonSectionDetails as getClemsonSectionDetailsLive,
  type ClemsonSection,
} from "../clemson-classes.js";
import { getGcCourse as getGcCourseLive } from "../gc-curriculum.js";
import { findCoreqs as findCoreqsLive } from "./gc-coreqs.js";
import Database from "better-sqlite3";
import {
  openScheduleDb,
  getScheduleDbMeta,
  getMeetingsForCrns,
  findConflicts,
} from "../clemson-schedule-db.js";
import {
  querySectionsEngine,
  matchesInstructor,
  matchesBuildingRoom,
  matchesDayTimeFilters,
  type EngineSection,
  type EngineMeeting,
} from "./section-query.js";
import { resolveTerm } from "../term-resolve.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Tool descriptions — VERBATIM from task-5-brief.md, plus the needsNarrowing
// top-page sentences from the 2026-08-16 T3 display fix. These are the design
// artifact; test/core-search.test.ts asserts literal substrings against them.
// ---------------------------------------------------------------------------

const SEARCH_CLASSES_DESCRIPTION =
  "Search Clemson class sections by subject and/or course number. Optional " +
  "filters: instructor, building_room, days, no_meeting_before, no_meeting_after, " +
  "open_seats_only. Term is optional — defaults to the current registration term; " +
  "accepts names like 'Spring 2027' or codes. Do NOT use this to check conflicts " +
  "(check-conflicts) or to find what fits an existing schedule (find-alternatives). " +
  "Large result sets return the top sections by open seats plus a needsNarrowing summary.";

const FIND_ALTERNATIVES_DESCRIPTION =
  "Find sections that fit around a student's existing schedule without time " +
  "conflicts. Requires current_crns — the CRNs the student is keeping. Optional: " +
  "subject, credits, days, no_meeting_before, no_meeting_after, exclude_days, " +
  "open_seats_only. Returns options ready for show-schedule-options. Term is " +
  "optional — defaults to the current registration term. When many fit, the " +
  "response contains the top sections by open seats plus a needsNarrowing " +
  "summary — show a few, don't ask first.";

const CHECK_CONFLICTS_DESCRIPTION =
  "Check which CRNs in a schedule have time conflicts, pair by pair. Optional " +
  "candidate_crns tests whether adding sections would conflict with crns. " +
  "Deterministic, from the daily snapshot. Term is optional — defaults to the " +
  "current registration term.";

const GET_COURSE_DETAILS_DESCRIPTION =
  "Details for one course or one section: description, prerequisites, " +
  "corequisites, restrictions (course_code also includes credits). Pass " +
  "course_code (e.g. 'GC 3010') for catalog information, or crn for a " +
  "specific section. Not a search — use search-classes to find sections. " +
  "Each entry in coreqs carries source: 'catalog_coreq' is authoritative; " +
  "'inferred_from_description' was guessed from catalog prose — say so and " +
  "tell the student to confirm it rather than stating it as fact.";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function strArrOrUndef(v: unknown): string[] | undefined {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : undefined;
}

// Live-search sections (search-classes' refresh:true path) come back as
// ClemsonSection, not EngineSection — map them so the response carries the
// same field set regardless of whether it served from the snapshot engine or
// a live Banner query. Task 7's display handoff depends on this shape: crn,
// subjectCourse, title, creditHours, enrollment, maxEnrollment,
// seatsAvailable, instructors, meetings.
function toEngineMeetings(meetings: ClemsonSection["meetings"]): EngineMeeting[] {
  const out: EngineMeeting[] = [];
  for (const m of meetings) {
    if (!m.beginTime || !m.endTime) continue; // untimed/online — no day rows
    for (const day of m.days) {
      if (!day.trim()) continue;
      out.push({
        day,
        start: m.beginTime,
        end: m.endTime,
        building: m.building,
        room: m.room,
      });
    }
  }
  return out;
}

function toEngineSections(sections: ClemsonSection[]): EngineSection[] {
  return sections.map((s) => ({
    crn: s.crn,
    subjectCourse: s.subjectCourse,
    title: s.title,
    creditHours: s.creditHours,
    enrollment: s.enrollment,
    maxEnrollment: s.maxEnrollment,
    seatsAvailable: s.seatsAvailable,
    instructors: s.instructors.map((i) => i.name),
    meetings: toEngineMeetings(s.meetings),
  }));
}

/** CRNs in `crns` that don't have a section row for `term` in the snapshot. */
function findMissingCrns(
  db: Database.Database,
  term: string,
  crns: string[],
): string[] {
  if (crns.length === 0) return [];
  const placeholders = crns.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT crn FROM sections WHERE term = ? AND crn IN (${placeholders})`)
    .all(term, ...crns) as Array<{ crn: string }>;
  const existing = new Set(rows.map((r) => r.crn));
  return crns.filter((c) => !existing.has(c));
}

// ---------------------------------------------------------------------------
// search-classes
// ---------------------------------------------------------------------------

/** Injectable for tests — defaults to the real live-Banner search. */
export interface SearchClassesDeps {
  searchLive: typeof searchClemsonClassesLive;
}

export function makeSearchClasses(
  deps: Partial<SearchClassesDeps> = {},
): McpToolDefinition {
  const searchLive = deps.searchLive ?? searchClemsonClassesLive;
  return {
    operation: "clemson.search_classes",
    category: "core",
    tool: {
      name: "search-classes",
      description: SEARCH_CLASSES_DESCRIPTION,
      inputSchema: {
        type: "object" as const,
        properties: {
          term: {
            type: "string",
            description:
              "Term code (202608) or text ('Spring 2027'). Defaults to the " +
              "current registration term.",
          },
          subject: {
            type: "string",
            description:
              "Subject abbreviation, e.g. CPSC. Required unless course_number is given.",
          },
          course_number: {
            type: "string",
            description: "Course number, e.g. 1010. Required unless subject is given.",
          },
          instructor: {
            type: "string",
            description: "Faculty name substring, e.g. 'Cox'.",
          },
          building_room: {
            type: "string",
            description: "Building and/or room substring, e.g. 'Godfrey 205'.",
          },
          days: {
            type: "string",
            description: "Day pattern using M T W R F S U, e.g. 'MWF'.",
          },
          no_meeting_before: {
            type: "string",
            description: "HHMM — exclude sections with any meeting starting earlier.",
          },
          no_meeting_after: {
            type: "string",
            description: "HHMM — exclude sections with any meeting ending later.",
          },
          open_seats_only: {
            type: "boolean",
            description: "Only return sections with seats available.",
          },
          max: {
            type: "integer",
            description: "Max sections to return (default 50, capped at 500).",
          },
          offset: {
            type: "integer",
            description: "Page offset for paging (default 0).",
          },
          refresh: {
            type: "boolean",
            description:
              "Force a live Banner query instead of the daily snapshot " +
              "(slower; use only when you need up-to-the-minute seat counts).",
          },
        },
      },
    },
    async handler(args) {
      try {
        assertMcpOperation("clemson.search_classes");
      } catch (e) {
        return permissionErr(e);
      }
      const resolved = resolveTerm(strOrUndef(args.term));
      if ("error" in resolved) return err(resolved.error);
      const { term } = resolved;

      const subject = strOrUndef(args.subject);
      const courseNumber = strOrUndef(args.course_number);
      if (!subject && !courseNumber) {
        return err(
          "subject or course_number is required to scope the search (e.g. " +
            "subject: 'CPSC') — an unscoped whole-term search is not " +
            "supported; add a subject and/or course_number.",
        );
      }

      if (args.refresh === true) {
        const result = await searchLive({
          term,
          subject,
          courseNumber,
          openOnly: Boolean(args.open_seats_only),
          max: numOrUndef(args.max),
          offset: numOrUndef(args.offset),
          refresh: true,
        });
        if (result === null) {
          return err(
            "Clemson class search unavailable — Banner did not return data after retries. Try again shortly.",
          );
        }

        // Banner's live search has no instructor/building_room/days/
        // no_meeting_before/no_meeting_after params — it only scopes by
        // term/subject/courseNumber/openOnly. Apply ALL of search-classes'
        // other advertised filters here, client-side, with the SAME
        // semantics querySectionsEngine uses (matchesInstructor/
        // matchesBuildingRoom/matchesDayTimeFilters in section-query.ts), so
        // refresh:true can't silently return unfiltered results a caller
        // believes are scoped. totalCount is recomputed post-filter —
        // Banner's count describes the pre-filter page, not what's actually
        // returned.
        let sections = toEngineSections(result.sections);
        const instructorFilter = strOrUndef(args.instructor);
        const buildingRoomFilter = strOrUndef(args.building_room);
        const daysFilter = strOrUndef(args.days);
        const noMeetingBeforeFilter = strOrUndef(args.no_meeting_before);
        const noMeetingAfterFilter = strOrUndef(args.no_meeting_after);
        if (instructorFilter) {
          sections = sections.filter((s) =>
            matchesInstructor(s.instructors, instructorFilter),
          );
        }
        if (buildingRoomFilter) {
          sections = sections.filter((s) =>
            matchesBuildingRoom(s.meetings, buildingRoomFilter),
          );
        }
        if (daysFilter || noMeetingBeforeFilter || noMeetingAfterFilter) {
          sections = sections.filter((s) =>
            matchesDayTimeFilters(s.meetings, {
              days: daysFilter,
              noMeetingBefore: noMeetingBeforeFilter,
              noMeetingAfter: noMeetingAfterFilter,
            }),
          );
        }

        return okJson({
          totalCount: sections.length,
          snapshotDate: result.snapshotDate,
          scope: result.scope,
          sections,
        });
      }

      const engineResult = querySectionsEngine({
        term,
        subject,
        courseNumber,
        instructor: strOrUndef(args.instructor),
        buildingRoom: strOrUndef(args.building_room),
        days: strOrUndef(args.days),
        noMeetingBefore: strOrUndef(args.no_meeting_before),
        noMeetingAfter: strOrUndef(args.no_meeting_after),
        openSeatsOnly: Boolean(args.open_seats_only),
        max: numOrUndef(args.max),
        offset: numOrUndef(args.offset),
      });
      if ("error" in engineResult) return err(engineResult.error);
      return okJson(engineResult);
    },
  };
}

export const searchClasses: McpToolDefinition = makeSearchClasses();

// ---------------------------------------------------------------------------
// find-alternatives
// ---------------------------------------------------------------------------

export const findAlternatives: McpToolDefinition = {
  operation: "clemson.find_alternatives",
  category: "core",
  tool: {
    name: "find-alternatives",
    description: FIND_ALTERNATIVES_DESCRIPTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            "Term code (202608) or text ('Spring 2027'). Defaults to the " +
            "current registration term.",
        },
        current_crns: {
          type: "array",
          items: { type: "string" },
          description:
            "CRNs the student is keeping — candidates must not conflict with these.",
        },
        subject: {
          type: "string",
          description: "Subject abbreviation, e.g. CPSC.",
        },
        credits: {
          type: "number",
          description: "Exact credit hours to match.",
        },
        days: {
          type: "string",
          description: "Day pattern using M T W R F S U, e.g. 'MWF'.",
        },
        no_meeting_before: {
          type: "string",
          description: "HHMM — exclude sections with any meeting starting earlier.",
        },
        no_meeting_after: {
          type: "string",
          description: "HHMM — exclude sections with any meeting ending later.",
        },
        exclude_days: {
          type: "array",
          items: { type: "string" },
          description: "Days to avoid entirely, e.g. ['F'].",
        },
        open_seats_only: {
          type: "boolean",
          description: "Only return sections with seats available.",
        },
      },
      required: ["current_crns"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.find_alternatives");
    } catch (e) {
      return permissionErr(e);
    }
    const resolved = resolveTerm(strOrUndef(args.term));
    if ("error" in resolved) return err(resolved.error);

    const currentCrns = strArrOrUndef(args.current_crns);
    if (!currentCrns || currentCrns.length === 0) {
      return err("current_crns is required — the CRNs the student is keeping.");
    }

    const engineResult = querySectionsEngine({
      term: resolved.term,
      subject: strOrUndef(args.subject),
      credits: typeof args.credits === "number" ? args.credits : undefined,
      days: strOrUndef(args.days),
      excludeDays: strArrOrUndef(args.exclude_days),
      noMeetingBefore: strOrUndef(args.no_meeting_before),
      noMeetingAfter: strOrUndef(args.no_meeting_after),
      openSeatsOnly: Boolean(args.open_seats_only),
      fitsAroundCrns: currentCrns,
    });
    if ("error" in engineResult) return err(engineResult.error);
    return okJson(engineResult);
  },
};

// ---------------------------------------------------------------------------
// check-conflicts
// ---------------------------------------------------------------------------

export const checkConflicts: McpToolDefinition = {
  operation: "clemson.check_conflicts",
  category: "core",
  tool: {
    name: "check-conflicts",
    description: CHECK_CONFLICTS_DESCRIPTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            "Term code (202608) or text ('Spring 2027'). Defaults to the " +
            "current registration term.",
        },
        crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs to check for conflicts, pair by pair.",
        },
        candidate_crns: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional — CRNs to test against crns without adding them to the fixed set.",
        },
      },
      required: ["crns"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.check_conflicts");
    } catch (e) {
      return permissionErr(e);
    }
    const resolved = resolveTerm(strOrUndef(args.term));
    if ("error" in resolved) return err(resolved.error);
    const term = resolved.term;

    const crns = strArrOrUndef(args.crns);
    if (!crns || crns.length === 0) {
      return err("crns is required — a non-empty array of CRNs to check.");
    }
    const candidateCrns = strArrOrUndef(args.candidate_crns);

    const db = openScheduleDb(term);
    if (!db) {
      return err(
        `No Banner snapshot available for term ${term}. Try again after the daily refresh.`,
      );
    }
    try {
      const allCrns = [...new Set([...crns, ...(candidateCrns ?? [])])];
      const missing = findMissingCrns(db, term, allCrns);
      if (missing.length > 0) {
        return err(
          `Unknown CRN${missing.length > 1 ? "s" : ""} for term ${term}: ${missing.join(", ")}`,
        );
      }

      const baseConflicts = findConflicts(getMeetingsForCrns(db, term, crns));
      const conflictingCrns = new Set(baseConflicts.flatMap((c) => [c.crn_a, c.crn_b]));
      const result: Record<string, unknown> = {
        term,
        snapshot_date: getScheduleDbMeta(db).fetchedAt,
        crns_checked: crns,
        conflict_free: crns.filter((c) => !conflictingCrns.has(c)),
        conflicts: baseConflicts,
        has_conflicts: baseConflicts.length > 0,
      };

      if (candidateCrns && candidateCrns.length > 0) {
        const fixedSet = new Set(crns);
        const allConflicts = findConflicts(getMeetingsForCrns(db, term, allCrns));
        result.candidates = candidateCrns.map((crn) => {
          const crnConflicts = allConflicts.filter(
            (c) =>
              (c.crn_a === crn && fixedSet.has(c.crn_b)) ||
              (c.crn_b === crn && fixedSet.has(c.crn_a)),
          );
          return { crn, conflict_free: crnConflicts.length === 0, conflicts: crnConflicts };
        });
      }

      return okJson(result);
    } finally {
      db.close();
    }
  },
};

// ---------------------------------------------------------------------------
// get-course-details
// ---------------------------------------------------------------------------

/** Injectable for tests — defaults to the real catalog/Banner lookups. */
export interface GetCourseDetailsDeps {
  getGcCourse: typeof getGcCourseLive;
  getClemsonSectionDetails: typeof getClemsonSectionDetailsLive;
  findCoreqs: typeof findCoreqsLive;
}

export function makeGetCourseDetails(
  deps: Partial<GetCourseDetailsDeps> = {},
): McpToolDefinition {
  const getCourse = deps.getGcCourse ?? getGcCourseLive;
  const getSectionDetails = deps.getClemsonSectionDetails ?? getClemsonSectionDetailsLive;
  const findCoreqs = deps.findCoreqs ?? findCoreqsLive;
  return {
    operation: "clemson.course_details",
    category: "core",
    tool: {
      name: "get-course-details",
      description: GET_COURSE_DETAILS_DESCRIPTION,
      inputSchema: {
        type: "object" as const,
        properties: {
          course_code: {
            type: "string",
            description: 'Course code, e.g. "GC 3010" or "MKTG 3010".',
          },
          crn: {
            type: "string",
            description: "Course Reference Number, e.g. 85865.",
          },
          term: {
            type: "string",
            description:
              "Term code (202608) or text ('Spring 2027'). Only used with crn; " +
              "defaults to the current registration term.",
          },
        },
      },
    },
    async handler(args) {
      try {
        assertMcpOperation("clemson.course_details");
      } catch (e) {
        return permissionErr(e);
      }
      const courseCode = strOrUndef(args.course_code);
      const crn = strOrUndef(args.crn);
      if (!courseCode && !crn) {
        return err(
          "course_code or crn is required — pass course_code (e.g. 'GC 3010') " +
            "for catalog information, or crn for a specific section.",
        );
      }

      // Term resolution is CRN-only: the course_code path (getGcCourse) never
      // consumes term, and the schema says as much ("Only used with crn").
      // Resolving it unconditionally meant a course_code-only lookup could
      // fail on a term/snapshot error it promised immunity from.
      if (courseCode) {
        try {
          const c = await getCourse(courseCode);
          const coreqs = findCoreqs(courseCode);
          const body: Record<string, unknown> = { ...(c as object) };
          // Same convention as compactSearchResult (clemson-classes.ts):
          // absent means "none" — omit rather than including an empty array.
          if (coreqs.length > 0) body.coreqs = coreqs;
          return okJson(body);
        } catch (e) {
          return err(
            `GC course lookup failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      const resolved = resolveTerm(strOrUndef(args.term));
      if ("error" in resolved) return err(resolved.error);

      const details = await getSectionDetails(resolved.term, crn!);
      if (details === null) return err("Clemson section details unavailable.");
      return okJson(details);
    },
  };
}

export const getCourseDetails: McpToolDefinition = makeGetCourseDetails();

// ---------------------------------------------------------------------------

registerTools([searchClasses, findAlternatives, checkConflicts, getCourseDetails]);
