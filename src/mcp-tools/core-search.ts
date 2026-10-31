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
import {
  getGcCourse as getGcCourseLive,
  getGcCourseDependents as getGcCourseDependentsLive,
} from "../gc-curriculum.js";
import { normalizeCourseCode } from "../catalog-read.js";
import { findCoreqs as findCoreqsLive } from "./gc-coreqs.js";
import Database from "better-sqlite3";
import {
  openScheduleDb,
  getScheduleDbMeta,
  getMeetingsForCrns,
  findConflicts,
  getSectionsByCrn,
  writeScheduleSlice,
} from "../clemson-schedule-db.js";
import {
  querySectionsEngine,
  matchesInstructor,
  matchesBuildingRoom,
  namesRoom,
  pageOrNarrow,
  matchesDayTimeFilters,
  type EngineSection,
  type EngineMeeting,
  UNTIMED_FILTER_NOTE,
} from "./section-query.js";
import { toEasternIso } from "../eastern-time.js";
import { log } from "../log.js";
import { resolveTerm } from "../term-resolve.js";
import { REVIEW_FIELDS_NOTE, reviewFieldsFor } from "../reviewed-prereq.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Tool descriptions — VERBATIM from task-5-brief.md, plus the needsNarrowing
// top-page sentences from the 2026-08-16 T3 display fix. These are the design
// artifact; test/core-search.test.ts asserts literal substrings against them.
// ---------------------------------------------------------------------------

const SEARCH_CLASSES_DESCRIPTION =
  "Search Clemson class sections by subject and/or course number, or by " +
  "room (building_room 'Godfrey 201' alone: what meets in that room). Optional " +
  "filters: instructor, building_room, days, no_meeting_before, no_meeting_after, " +
  "open_seats_only. Term is optional — defaults to the current registration term; " +
  "accepts names like 'Spring 2027' or codes. Do NOT use this to check conflicts " +
  "(check-conflicts) or to find what fits an existing schedule, including a " +
  "replacement when swapping out a section (find-alternatives). " +
  "For who teaches what — one person's teaching in a term, or every " +
  "instructor of a subject — call get-instructor-classes or " +
  "get-teaching-load (scheduling tools) instead of listing sections " +
  "course by course. " +
  "A result too large to list is CUT: it returns the top sections by open " +
  "seats plus a `truncated` block that states the cut in words. Never answer " +
  '"what was offered" or "how many" from a truncated page — those sections ' +
  "are the emptiest ones, not a sample; narrow the query or page " +
  "(offset: 0, then the next offset each page gives; max up to 500). " +
  'Sections carry part_of_term verbatim ("1" full term, "H1"/' +
  '\"H2\" Summer 1/2, \"MMA\"..\"MMD\" mini-mesters; null on snapshots ' +
  "taken before 2026-09-08).";

const FIND_ALTERNATIVES_DESCRIPTION =
  "Find sections that fit around a student's existing schedule without time " +
  'conflicts — including to SWAP or REPLACE a section ("swap out X", ' +
  '"drop X for something else"). Requires current_crns — the CRNs the ' +
  "student is KEEPING, not the one being dropped. For a swap, also pass " +
  "replacing_crn: the dropped section's subject and credit hours become the " +
  "default filters, and it is never offered back. Optional: replacing_crn, " +
  "subject, credits, days, no_meeting_before, no_meeting_after, exclude_days, " +
  "open_seats_only. Returns options ready to present side by side. Term is " +
  "optional — defaults to the current registration term. When many fit, the " +
  "response contains the top sections by open seats plus a needsNarrowing " +
  "summary and a `truncated` block — show a few, don't ask first, but do not " +
  "report the page as the complete set of what fits. To check SPECIFIC " +
  'courses ("which of these required courses could she add?"), pass ' +
  "courses: ['GC 3460', 'GC 4400', ...] instead of subject: every listed " +
  "course gets a verdict from ALL its sections (fits, the sections that " +
  "fit, or the kept CRNs blocking each one), never cut.";

const CHECK_CONFLICTS_DESCRIPTION =
  "Check which CRNs in a schedule have time conflicts, pair by pair. Optional " +
  "candidate_crns tests whether adding sections would conflict with crns. " +
  "Deterministic, from the daily snapshot. Term is optional — defaults to the " +
  "current registration term.";

const GET_COURSE_DETAILS_DESCRIPTION =
  "Details for one course or one section: description, prerequisites, " +
  "corequisites, restrictions (course_code also includes credits). With " +
  "course_code it also answers the reverse question — prerequisite_for: the " +
  'courses whose prerequisite names this one ("what is GC 3460 a ' +
  'prerequisite for?"), each with its own prerequisite wording to quote; ' +
  "include_chain for everything further down. For planning across " +
  "several courses or semesters, call get-program-graph (catalog server) " +
  "once instead of this tool course by course. " +
  "For who teaches what — one person's teaching in a term, or every " +
  "instructor of a subject — call get-instructor-classes or " +
  "get-teaching-load (scheduling tools) instead of listing sections " +
  "course by course. " +
  "Pass " +
  "course_code (e.g. 'GC 3010') for catalog information, or crn for a " +
  "specific section. Not a search — use search-classes to find sections. " +
  "Each entry in coreqs comes from the catalog's structured corequisite " +
  "field (source 'catalog_coreq'); a course with none listed returns an " +
  "empty coreqs list — do not infer one. " +
  REVIEW_FIELDS_NOTE;

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
function toEngineMeetings(
  meetings: ClemsonSection["meetings"],
): EngineMeeting[] {
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
    // Live Banner results carry it too, so a refresh:true page reports the
    // same session codes as a snapshot page.
    partOfTerm: s.partOfTerm ?? null,
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
    .prepare(
      `SELECT crn FROM sections WHERE term = ? AND crn IN (${placeholders})`,
    )
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
  writeBack?: typeof writeScheduleSlice;
}

// An empty search is not proof of absence (2026-10-27: "Godfrey 205 — no T/Th
// sections at all" was an empty result reported as fact). Say so, and echo the
// filters that ran so the model can see which one was too narrow.
const ABSENCE_NOTE =
  "No sections matched these filters. This is not evidence that none exist: " +
  "check the filter values (building_room matches every word, e.g. " +
  "'Godfrey 205'; days use MTWRF), widen one filter, or try refresh: true " +
  "before saying there are none.";

// Filters Banner never sees: a live 0 under one of these is still only "none
// matched", so it keeps the hedge.
const NARROWING_ARGS = [
  "instructor",
  "building_room",
  "days",
  "no_meeting_before",
  "no_meeting_after",
  "open_seats_only",
];

function withAbsenceNote<T extends { totalCount: number; scope?: string }>(
  result: T,
  term: string,
  args: Record<string, unknown>,
  termName?: string,
): T | (T & { note: string; filters_applied: Record<string, unknown> }) {
  if (result.totalCount !== 0) return result;
  const filters_applied: Record<string, unknown> = { term };
  for (const k of [
    "subject",
    "course_number",
    "instructor",
    "building_room",
    "days",
    "no_meeting_before",
    "no_meeting_after",
    "open_seats_only",
    "refresh",
  ]) {
    if (args[k] !== undefined && args[k] !== "" && args[k] !== false)
      filters_applied[k] = args[k];
  }
  // A live 0 with no client-side filter is Banner's own answer, confirmed
  // against a term that answers (searchClemsonClasses' control): say it
  // plainly, so a real "not offered" is not hedged (Cob_advisor 2026-10-28).
  const narrowed = NARROWING_ARGS.some(
    (k) => args[k] !== undefined && args[k] !== "" && args[k] !== false,
  );
  if (result.scope === "live" && !narrowed) {
    const subject = strOrUndef(args.subject)?.toUpperCase();
    const number = strOrUndef(args.course_number);
    const what =
      subject && number
        ? `${subject} ${number}`
        : (subject ?? `course number ${number}`);
    const at = toEasternIso(new Date().toISOString()).slice(11, 16);
    return {
      ...result,
      note: `Banner lists no ${termName ?? term} sections of ${what} (live, checked ${at} ET).`,
      filters_applied,
    };
  }
  return { ...result, note: ABSENCE_NOTE, filters_applied };
}

export function makeSearchClasses(
  deps: Partial<SearchClassesDeps> = {},
): McpToolDefinition {
  const searchLive = deps.searchLive ?? searchClemsonClassesLive;
  const writeBack = deps.writeBack ?? writeScheduleSlice;
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
            description:
              "Course number, e.g. 1010. Required unless subject is given.",
          },
          instructor: {
            type: "string",
            description:
              "Faculty name: every word must appear in the name, any order, e.g. 'Cox' or 'Carl Hollingsworth'.",
          },
          building_room: {
            type: "string",
            description:
              "Building and/or room: every word must appear, any order, e.g. " +
              "'Godfrey 201'. A room (a word with a number) needs no subject: " +
              "'Godfrey 201' alone lists everything in that room.",
          },
          days: {
            type: "string",
            description:
              "Day pattern using M T W R F S U, e.g. 'MWF'." +
              UNTIMED_FILTER_NOTE,
          },
          no_meeting_before: {
            type: "string",
            description:
              "HHMM — exclude sections with any meeting starting earlier." +
              UNTIMED_FILTER_NOTE,
          },
          no_meeting_after: {
            type: "string",
            description:
              "HHMM — exclude sections with any meeting ending later." +
              UNTIMED_FILTER_NOTE,
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
            description:
              "Page offset. Giving it pages through every match (most open seats first) instead of the narrowed top page; each cut page names the next offset.",
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
      const roomScope =
        !args.refresh && namesRoom(strOrUndef(args.building_room));
      if (!subject && !courseNumber && !roomScope) {
        return err(
          "subject or course_number is required to scope the search (e.g. " +
            "subject: 'CPSC') — an unscoped whole-term search is not " +
            "supported; add a subject and/or course_number, or name a room " +
            "in building_room (e.g. 'Godfrey 201'; not with refresh).",
        );
      }

      if (args.refresh === true) {
        const instructorFilter = strOrUndef(args.instructor);
        const buildingRoomFilter = strOrUndef(args.building_room);
        const daysFilter = strOrUndef(args.days);
        const noMeetingBeforeFilter = strOrUndef(args.no_meeting_before);
        const noMeetingAfterFilter = strOrUndef(args.no_meeting_after);
        const live = (max?: number, offset?: number) =>
          searchLive({
            term,
            subject,
            courseNumber,
            openOnly: Boolean(args.open_seats_only),
            max,
            offset,
            refresh: true,
          });
        const unavailable = err(
          "Clemson class search unavailable — Banner did not return data after retries. Try again shortly.",
        );

        // Banner's live search has no instructor/building_room/days/
        // no_meeting_before/no_meeting_after params — it only scopes by
        // term/subject/courseNumber/openOnly. Apply ALL of search-classes'
        // other advertised filters here, client-side, with the SAME
        // semantics querySectionsEngine uses (matchesInstructor/
        // matchesBuildingRoom/matchesDayTimeFilters in section-query.ts), so
        // refresh:true can't silently return unfiltered results a caller
        // believes are scoped. Filters run on EVERY page Banner has, never one
        // page (2026-10-27: 50 of 87 GC sections hid Godfrey 205); a scan that
        // can't finish is an error, never a short list; and the result goes
        // through the snapshot path's pageOrNarrow, so too many matches come
        // back as a PARTIAL RESULT asking for a narrower query.
        const MAX_PAGES = 20;
        const got: ClemsonSection[] = [];
        const totals = new Set<number>();
        let result: Awaited<ReturnType<typeof live>> = null;
        for (let i = 0; i < MAX_PAGES; i++) {
          result = await live(500, got.length);
          if (result === null) return unavailable;
          totals.add(result.totalCount);
          got.push(...result.sections);
          if (got.length >= result.totalCount || result.sections.length === 0)
            break;
        }
        if (result === null || got.length < result.totalCount)
          return unavailable;

        // Pages come from separate Banner sessions, so they can disagree: a
        // row repeated on one page and another skipped while the row count
        // still reaches totalCount, or a section dropped between pages that
        // shifts the offsets (hostile review, 2026-10-27). Keep one copy per
        // CRN; the fetch is complete only when every page reported the same
        // total and the distinct CRNs reach it.
        const fetched = [...new Map(got.map((s) => [s.crn, s])).values()];
        const whole = totals.size === 1 && fetched.length >= result.totalCount;
        const complete = !args.open_seats_only && whole;

        // Write the whole fetch (before the client-side filters) back into
        // the snapshot, so the next non-refresh answer agrees with this one.
        // An incomplete fetch updates what it got and deletes nothing. A
        // failed write never fails the search.
        if (subject) {
          try {
            writeBack(
              term,
              { subject, courseNumber, complete },
              fetched,
              new Date().toISOString(),
            );
          } catch (e) {
            log.warn("search-classes write-back threw", { err: String(e) });
          }
        }
        // A fetch known to be short is an error, never a list with sections
        // silently missing.
        if (!whole) return unavailable;

        let sections = toEngineSections(fetched);
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

        sections.sort((a, b) => b.seatsAvailable - a.seatsAvailable);
        return okJson(
          withAbsenceNote(
            {
              ...pageOrNarrow(sections, {
                max: numOrUndef(args.max),
                offset: numOrUndef(args.offset),
              }),
              snapshotDate: result.snapshotDate,
              scope: result.scope,
            },
            term,
            args,
            resolved.termName,
          ),
        );
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
      return okJson(withAbsenceNote(engineResult, term, args));
    },
  };
}

export const searchClasses: McpToolDefinition = makeSearchClasses();

// ---------------------------------------------------------------------------
// find-alternatives
// ---------------------------------------------------------------------------

const MAX_VERDICT_COURSES = 20;
const VERDICT_SECTIONS_SHOWN = 10;

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
        replacing_crn: {
          type: "string",
          description:
            "For a swap: the CRN being dropped. Its subject and credit hours " +
            "become the defaults (subject/credits override), and it is never " +
            "returned. Do not also list it in current_crns.",
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
          description:
            "HHMM — exclude sections with any meeting starting earlier.",
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
        courses: {
          type: "array",
          items: { type: "string" },
          description:
            `Up to ${MAX_VERDICT_COURSES} course codes ('GC 3460') to check ` +
            "one by one instead of a subject search: each gets fits " +
            "true/false from all its sections, the fitting sections, or " +
            "the kept CRNs blocking each section. Not with subject.",
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

    // A swap: the dropped section supplies default filters and is excluded.
    let replacing:
      | {
          crn: string;
          subject_course: string;
          applied: { subject?: string; credits?: number };
          note?: string;
        }
      | undefined;
    let subject = strOrUndef(args.subject);
    let credits = typeof args.credits === "number" ? args.credits : undefined;
    let keepers = currentCrns;
    const replacingCrn = strOrUndef(args.replacing_crn)?.trim();
    if (replacingCrn) {
      const db = openScheduleDb(resolved.term);
      if (!db) return err(`No schedule snapshot for term ${resolved.term}.`);
      let dropped;
      try {
        dropped = getSectionsByCrn(db, resolved.term, [replacingCrn])
          .sections[0];
      } finally {
        db.close();
      }
      if (!dropped)
        return err(
          `replacing_crn ${replacingCrn} is not a section in term ${resolved.term}.`,
        );
      subject ??= /^[A-Z]+/.exec(dropped.subject_course)?.[0];
      credits ??= dropped.credit_hours ?? undefined;
      replacing = {
        crn: replacingCrn,
        subject_course: dropped.subject_course,
        applied: {
          ...(subject !== undefined ? { subject } : {}),
          ...(credits !== undefined ? { credits } : {}),
        },
      };
      if (keepers.includes(replacingCrn)) {
        keepers = keepers.filter((c) => c !== replacingCrn);
        replacing.note =
          `${replacingCrn} was removed from current_crns: it is the section ` +
          "being dropped, so its time slot is free.";
        if (keepers.length === 0)
          return err(
            "current_crns has nothing left once replacing_crn is removed — " +
              "pass the CRNs the student is keeping.",
          );
      }
    }

    if (args.courses !== undefined) {
      if (args.subject !== undefined)
        return err(
          "Pass courses or subject, not both: courses already names them.",
        );
      const result = courseVerdicts(resolved.term, args.courses, keepers, {
        // Only an explicit credits filter: a swap's default credit hours
        // would hide listed courses of another size.
        credits: typeof args.credits === "number" ? args.credits : undefined,
        days: strOrUndef(args.days),
        excludeDays: strArrOrUndef(args.exclude_days),
        noMeetingBefore: strOrUndef(args.no_meeting_before),
        noMeetingAfter: strOrUndef(args.no_meeting_after),
        openSeatsOnly: Boolean(args.open_seats_only),
        excludeCrns: replacingCrn ? [replacingCrn] : undefined,
      });
      if ("error" in result) return err(result.error);
      return okJson(
        replacing
          ? { ...result, replacing: { ...replacing, applied: {} } }
          : result,
      );
    }

    const engineResult = querySectionsEngine({
      term: resolved.term,
      subject,
      credits,
      days: strOrUndef(args.days),
      excludeDays: strArrOrUndef(args.exclude_days),
      noMeetingBefore: strOrUndef(args.no_meeting_before),
      noMeetingAfter: strOrUndef(args.no_meeting_after),
      openSeatsOnly: Boolean(args.open_seats_only),
      fitsAroundCrns: keepers,
      excludeCrns: replacingCrn ? [replacingCrn] : undefined,
    });
    if ("error" in engineResult) return err(engineResult.error);
    return okJson(replacing ? { ...engineResult, replacing } : engineResult);
  },
};

type VerdictFilters = Omit<
  Parameters<typeof querySectionsEngine>[0],
  "term" | "subject" | "courseNumber" | "fitsAroundCrns" | "max" | "offset"
>;

/** find-alternatives' `courses` mode: per listed course, every section
 *  checked against the kept CRNs' meetings. The verdict always counts all of
 *  a course's sections; only the listing is capped. */
function courseVerdicts(
  term: string,
  rawCourses: unknown,
  keepers: string[],
  filters: VerdictFilters,
):
  | {
      term: string;
      snapshotDate: string | null;
      current_crns: string[];
      unknown_crns?: string[];
      note?: string;
      courses: Record<string, unknown>[];
      summary: {
        fit: string[];
        do_not_fit: string[];
        not_offered: string[];
        already_kept?: string[];
      };
    }
  | { error: string } {
  if (
    !Array.isArray(rawCourses) ||
    rawCourses.length === 0 ||
    rawCourses.length > MAX_VERDICT_COURSES
  )
    return {
      error: `courses must be a list of 1–${MAX_VERDICT_COURSES} course codes.`,
    };
  const codes: string[] = [];
  for (const raw of rawCourses) {
    const code = typeof raw === "string" ? normalizeCourseCode(raw) : null;
    if (!code)
      return {
        error: `courses: ${JSON.stringify(raw)} is not a course code like 'GC 3460'.`,
      };
    if (!codes.includes(code)) codes.push(code);
  }

  const db = openScheduleDb(term);
  if (!db) return { error: `No schedule snapshot for term ${term}.` };
  let anchors;
  const keptCourse = new Map<string, string[]>();
  const replacedCourse = new Map<string, string>();
  const found = new Set<string>();
  try {
    anchors = getMeetingsForCrns(db, term, keepers);
    for (const k of getSectionsByCrn(db, term, keepers).sections) {
      found.add(k.crn);
      keptCourse.set(k.subject_course, [
        ...(keptCourse.get(k.subject_course) ?? []),
        k.crn,
      ]);
    }
    const dropped = filters.excludeCrns ?? [];
    for (const d of getSectionsByCrn(db, term, dropped).sections)
      replacedCourse.set(d.subject_course, d.crn);
  } finally {
    db.close();
  }

  const courses: Record<string, unknown>[] = [];
  const summary: {
    fit: string[];
    do_not_fit: string[];
    not_offered: string[];
    already_kept?: string[];
  } = { fit: [], do_not_fit: [], not_offered: [] };
  // Her own sections are never candidates: one would only clash with itself.
  const excludeCrns = [...(filters.excludeCrns ?? []), ...keepers];
  let snapshotDate: string | null = null;
  for (const code of codes) {
    const [subject, courseNumber] = code.split(" ");
    const every = { term, subject, courseNumber, offset: 0, max: 500 };
    const all = querySectionsEngine({ ...every, excludeCrns });
    if ("error" in all) return all;
    snapshotDate ??= all.snapshotDate;
    const kept = keptCourse.get(code.replace(" ", ""));
    if (kept) (summary.already_kept ??= []).push(code);
    // The section being dropped still means the course runs this term.
    const replaced = replacedCourse.get(code.replace(" ", ""));
    if (all.totalCount === 0 && !kept && !replaced) {
      summary.not_offered.push(code);
      courses.push({ course: code, offered: false, fits: false });
      continue;
    }
    const matching = querySectionsEngine({ ...every, ...filters, excludeCrns });
    if ("error" in matching) return matching;
    const fitting: EngineSection[] = [];
    const blocked: {
      crn: string;
      meetings: EngineMeeting[];
      blocked_by: string[];
    }[] = [];
    for (const s of matching.sections) {
      const by = new Set<string>();
      for (const m of s.meetings) {
        const start = hhmmMins(m.start);
        const end = hhmmMins(m.end);
        for (const a of anchors)
          if (a.day === m.day && start < a.endMin && a.startMin < end)
            by.add(a.crn);
      }
      if (by.size === 0) fitting.push(s);
      else
        blocked.push({ crn: s.crn, meetings: s.meetings, blocked_by: [...by] });
    }
    const fits = fitting.length > 0;
    if (!kept) (fits ? summary.fit : summary.do_not_fit).push(code);
    const outside = all.totalCount - matching.totalCount;
    courses.push({
      course: code,
      title: all.sections[0]?.title,
      offered: true,
      ...(kept ? { already_kept: kept } : {}),
      ...(replaced ? { replaced_section: replaced } : {}),
      fits,
      fitting_count: fitting.length,
      fitting: fitting.slice(0, VERDICT_SECTIONS_SHOWN),
      ...(fitting.length > VERDICT_SECTIONS_SHOWN
        ? {
            fitting_note: `${VERDICT_SECTIONS_SHOWN} of ${fitting.length} fitting sections shown, most open seats first.`,
          }
        : {}),
      ...(fits ? {} : { blocked: blocked.slice(0, VERDICT_SECTIONS_SHOWN) }),
      ...(outside > 0 ? { outside_filters: outside } : {}),
    });
  }
  // A kept CRN that isn't in the term blocks nothing, so every verdict
  // would look better than it is: name it.
  const unknown = keepers.filter((c) => !found.has(c));
  return {
    term,
    snapshotDate,
    current_crns: keepers,
    ...(unknown.length > 0
      ? {
          unknown_crns: unknown,
          note:
            `${unknown.join(", ")} not found in term ${term}, so not checked ` +
            "against: confirm the CRNs before relying on these verdicts.",
        }
      : {}),
    courses,
    summary,
  };
}

function hhmmMins(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2, 4));
}

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
      const conflictingCrns = new Set(
        baseConflicts.flatMap((c) => [c.crn_a, c.crn_b]),
      );
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
        const allConflicts = findConflicts(
          getMeetingsForCrns(db, term, allCrns),
        );
        result.candidates = candidateCrns.map((crn) => {
          const crnConflicts = allConflicts.filter(
            (c) =>
              (c.crn_a === crn && fixedSet.has(c.crn_b)) ||
              (c.crn_b === crn && fixedSet.has(c.crn_a)),
          );
          return {
            crn,
            conflict_free: crnConflicts.length === 0,
            conflicts: crnConflicts,
          };
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
  getDependents: typeof getGcCourseDependentsLive;
}

export function makeGetCourseDetails(
  deps: Partial<GetCourseDetailsDeps> = {},
): McpToolDefinition {
  const getCourse = deps.getGcCourse ?? getGcCourseLive;
  const getSectionDetails =
    deps.getClemsonSectionDetails ?? getClemsonSectionDetailsLive;
  const findCoreqs = deps.findCoreqs ?? findCoreqsLive;
  const getDependents = deps.getDependents ?? getGcCourseDependentsLive;
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
          include_chain: {
            type: "boolean",
            description:
              "course_code only: in prerequisite_for, also list courses further " +
              "down the chain (each with depth and the course it comes through). " +
              "Default false: only courses that name this one directly.",
          },
          dependents_subject: {
            type: "string",
            description:
              "course_code only: limit prerequisite_for to one subject, e.g. 'GC'.",
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
          // getCourse returns null for a code the catalog does not have.
          // Spreading null yields {}, which arrived as a SUCCESS with an empty
          // body — indistinguishable from "found, but has no fields". A model
          // cannot tell those apart, and the wrong reading ("the course exists,
          // I just know nothing about it") is the dangerous one. Say it plainly.
          // (Adversarial review, 2026-08-27.)
          if (c === null || c === undefined) {
            return err(
              `No course "${courseCode}" in the Clemson catalog. Check the code, ` +
                `or use find-course-in-program to see whether a program requires it.`,
            );
          }
          const coreqs = findCoreqs(courseCode);
          const body: Record<string, unknown> = { ...(c as object) };
          // Same convention as compactSearchResult (clemson-classes.ts):
          // absent means "none" — omit rather than including an empty array.
          if (coreqs.length > 0) body.coreqs = coreqs;
          // A reviewer's correction to the catalog wording travels with it
          // (GC 2070 went 0/4 when only the graph carried it, 2026-10-20).
          Object.assign(body, reviewFieldsFor([courseCode]).get(courseCode));
          // Always present, even when empty: "what needs this course?" with
          // no answer must read as zero, not as a field that was never asked.
          body.prerequisite_for = await getDependents(courseCode, {
            chain: args.include_chain === true,
            subject: strOrUndef(args.dependents_subject),
          });
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
// get-course-facts — the get-course-details catalog fields, batch-shaped.
// Born from a real outage shape (Cob_advisor, 2026-09-06): a graduation-
// planner page build fetched facts for ~150 courses one get-course-details
// call at a time, and its session-per-call client burned ~4 HTTP requests per
// course — one page build spent the consumer's whole 600/min budget in its
// first second. The fix is not a higher ceiling; it is one read per plan.
// ---------------------------------------------------------------------------

const GET_COURSE_FACTS_DESCRIPTION =
  "Catalog facts for MANY courses in one call (up to 200 codes, normalized, " +
  "duplicates collapsed): credits, title, prereq_text (plus review_note / " +
  "reviewed_prereq where a reviewer corrected it — use those), prereq_expr " +
  "(the hand-reviewed rule as a structured expression — & all, | any, ~ same " +
  'term, >=C grade, [cond:value], ?"text" — for every course that has one; ' +
  "absent: read prereq_text), prereq_parsed, " +
  "coreq_parsed, and the structured coreqs pairing — the get-course-details " +
  "catalog fields a degree audit needs, batch-shaped: pass every course of " +
  "a plan at once. Three-state per entry: found true with the facts; found " +
  "false when the published catalog has no such course (a data absence, " +
  "NEVER an outage — an unavailable catalog fails the whole call loudly). " +
  "No sections, seats, or offering history — use search-classes / " +
  "get-course-offerings for those. Each entry in coreqs comes from the " +
  "catalog's structured corequisite field; a course with none listed has no " +
  "coreqs field — do not infer one.";

/** Injectable for tests — defaults to the real catalog lookups. */
export interface GetCourseFactsDeps {
  getGcCourse: typeof getGcCourseLive;
  findCoreqs: typeof findCoreqsLive;
}

export function makeGetCourseFacts(
  deps: Partial<GetCourseFactsDeps> = {},
): McpToolDefinition {
  const getCourse = deps.getGcCourse ?? getGcCourseLive;
  const findCoreqs = deps.findCoreqs ?? findCoreqsLive;
  return {
    operation: "clemson.course_facts",
    category: "core",
    tool: {
      name: "get-course-facts",
      description: GET_COURSE_FACTS_DESCRIPTION,
      inputSchema: {
        type: "object" as const,
        properties: {
          courses: {
            type: "array",
            items: { type: "string" },
            description:
              'Course codes, e.g. ["GC 3400", "pksc2200"] — spacing and ' +
              "case are normalized. Duplicates are collapsed. At most 200.",
          },
        },
        required: ["courses"],
        additionalProperties: false,
      },
    },
    async handler(args) {
      try {
        assertMcpOperation("clemson.course_facts");
      } catch (e) {
        return permissionErr(e);
      }
      const rawList = Array.isArray(args.courses)
        ? (args.courses as unknown[]).filter(
            (x): x is string => typeof x === "string" && x.trim() !== "",
          )
        : [];
      if (rawList.length === 0)
        return err("courses is required and must contain at least one code.");
      if (rawList.length > 200)
        return err("At most 200 courses per call — split larger plans.");
      // Junk fails as junk, not as a miss: a string that is not a course code
      // errors the call, while a WELL-FORMED code the catalog lacks comes back
      // found:false — same absence-vs-garbage split as get-course-offerings.
      const bad: string[] = [];
      const codes: string[] = [];
      const seen = new Set<string>();
      for (const raw of rawList) {
        const norm = normalizeCourseCode(raw);
        if (!norm) {
          bad.push(raw);
          continue;
        }
        if (!seen.has(norm)) {
          seen.add(norm);
          codes.push(norm);
        }
      }
      if (bad.length > 0)
        return err(`Not course codes: ${bad.join(", ")} — e.g. "GC 3400".`);
      try {
        const courses: Record<string, unknown>[] = [];
        const reviews = reviewFieldsFor(codes, { expr: true });
        for (const code of codes) {
          const c = (await getCourse(code)) as Record<string, unknown> | null;
          if (c === null || c === undefined) {
            courses.push({ code, found: false });
            continue;
          }
          const entry: Record<string, unknown> = {
            code,
            found: true,
            title: c.title ?? null,
            credits: c.credits ?? null,
            prereq_text: c.prereq_text ?? null,
            prereq_parsed: c.prereq_parsed ?? null,
            coreq_parsed: c.coreq_parsed ?? null,
            ...reviews.get(code),
          };
          // Same convention as get-course-details: absent means "none listed".
          const coreqs = findCoreqs(code);
          if (coreqs.length > 0) entry.coreqs = coreqs;
          courses.push(entry);
        }
        return okJson({
          courses,
          _note:
            '"found": false means the published catalog has no such course ' +
            "code — a data absence, never an outage; an unavailable catalog " +
            "fails this whole call with an error instead.",
          _source:
            "published Clemson catalog — current course inventory, not " +
            "catalog-year-pinned",
        });
      } catch (e) {
        return err(
          `Catalog lookup failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}

export const getCourseFacts: McpToolDefinition = makeGetCourseFacts();

// ---------------------------------------------------------------------------

registerTools([
  searchClasses,
  findAlternatives,
  checkConflicts,
  getCourseDetails,
  getCourseFacts,
]);
