// src/mcp-tools/section-query.ts
//
// Shared section-query engine over the per-term Banner schedule snapshot DB.
// Every new front-door tool in this redesign (search-classes, find-eligible-
// sections, show-schedule-options, ...) calls THIS instead of hand-rolling
// its own SQL — one filter pipeline, one needs_narrowing envelope, one set
// of building/day/fit semantics. Term resolution happens upstream (Task 1's
// resolveTerm); this engine takes a resolved term code only. No live Banner
// calls here — snapshot only; refresh overlay stays in search-classes.
import {
  openScheduleDb,
  getScheduleDbMeta,
  getMeetingsForCrns,
  minsToHHMM,
} from "../clemson-schedule-db.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SectionFilters {
  term: string; // already resolved (Task 1) — engine takes codes only
  subject?: string;
  courseNumber?: string;
  instructor?: string; // substring, case-insensitive, instructors table
  buildingRoom?: string; // substring match on meetings building+room
  days?: string; // e.g. "TR" — every meeting day ∈ set
  excludeDays?: string[];
  noMeetingBefore?: string; // "HHMM"
  noMeetingAfter?: string; // "HHMM"
  openSeatsOnly?: boolean;
  credits?: number; // within 0.01
  fitsAroundCrns?: string[]; // exclude any section whose meetings overlap these CRNs' meetings
  max?: number;
  offset?: number;
}

export interface EngineMeeting {
  day: string;
  start: string; // "HHMM"
  end: string; // "HHMM"
  building: string | null;
  room: string | null;
}

export interface EngineSection {
  crn: string;
  subjectCourse: string;
  title: string;
  creditHours: number | null;
  seatsAvailable: number;
  instructors: string[];
  meetings: EngineMeeting[];
}

export interface EngineResult {
  totalCount: number;
  sections: EngineSection[];
  needsNarrowing?: { total: number; bySubject: Record<string, number> };
  snapshotDate: string;
}

// Same threshold + by-subject breakdown behavior as find-sections-by-schedule
// (src/mcp-tools/clemson-advising.ts) — too many matches to list usefully in
// chat, so return a subject breakdown instead of a page of sections.
const NARROW_THRESHOLD = 15;

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface SectionRow {
  crn: string;
  subject_course: string;
  title: string;
  credit_hours: number | null;
  seats_available: number;
}

interface MeetingRow {
  crn: string;
  day: string;
  start_min: number;
  end_min: number;
  building: string | null;
  room: string | null;
}

function hhmmToMins(t: string): number | null {
  if (!/^\d{4}$/.test(t)) return null;
  const h = parseInt(t.slice(0, 2), 10);
  const m = parseInt(t.slice(2), 10);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function querySectionsEngine(
  filters: SectionFilters,
): EngineResult | { error: string } {
  const term = filters.term;
  const db = openScheduleDb(term);
  if (!db) {
    return {
      error: `No Banner snapshot available for term ${term}. Try again after the daily refresh.`,
    };
  }

  try {
    const meta = getScheduleDbMeta(db);

    // -------------------------------------------------------------------
    // SQL bounding filters — narrow the candidate section rows first.
    // subject/courseNumber reuse queryScheduleDb's spaceless subject_course
    // GLOB discipline verbatim (src/clemson-schedule-db.ts:390-431): subject
    // is anchored to the alpha→digit boundary so "AS" doesn't also match
    // "ASTR…".
    // -------------------------------------------------------------------
    const conditions: string[] = ["term = ?"];
    const bindings: unknown[] = [term];

    const subject = filters.subject?.toUpperCase();
    if (subject && filters.courseNumber) {
      conditions.push("subject_course = ?");
      bindings.push(`${subject}${filters.courseNumber}`);
    } else if (subject) {
      conditions.push("subject_course GLOB ?");
      bindings.push(`${subject}[0-9]*`);
    } else if (filters.courseNumber) {
      conditions.push("subject_course LIKE ?");
      bindings.push(`%${filters.courseNumber}`);
    }

    if (filters.credits !== undefined) {
      conditions.push("ABS(credit_hours - ?) < 0.01");
      bindings.push(filters.credits);
    }

    if (filters.openSeatsOnly) {
      conditions.push("seats_available > 0");
    }

    if (filters.instructor) {
      conditions.push(
        "EXISTS (SELECT 1 FROM instructors i WHERE i.crn = sections.crn " +
          "AND i.term = sections.term AND LOWER(i.name) LIKE ?)",
      );
      bindings.push(`%${filters.instructor.toLowerCase()}%`);
    }

    if (filters.buildingRoom) {
      conditions.push(
        "EXISTS (SELECT 1 FROM meetings m WHERE m.crn = sections.crn " +
          "AND m.term = sections.term AND " +
          "LOWER(COALESCE(m.building,'') || ' ' || COALESCE(m.room,'')) LIKE ?)",
      );
      bindings.push(`%${filters.buildingRoom.toLowerCase()}%`);
    }

    const where = conditions.join(" AND ");
    const rows = db
      .prepare(
        `SELECT crn, subject_course, title, credit_hours, seats_available
         FROM sections WHERE ${where} ORDER BY subject_course, section`,
      )
      .all(...bindings) as SectionRow[];

    if (rows.length === 0) {
      return { totalCount: 0, sections: [], snapshotDate: meta.fetchedAt };
    }

    const crns = rows.map((r) => r.crn);
    const crnPhs = crns.map(() => "?").join(",");

    const meetingRows = db
      .prepare(
        `SELECT crn, day, start_min, end_min, building, room
         FROM meetings WHERE term = ? AND crn IN (${crnPhs})
           AND start_min IS NOT NULL AND end_min IS NOT NULL`,
      )
      .all(term, ...crns) as MeetingRow[];
    const meetingsByCrn = new Map<string, MeetingRow[]>();
    for (const m of meetingRows) {
      if (!meetingsByCrn.has(m.crn)) meetingsByCrn.set(m.crn, []);
      meetingsByCrn.get(m.crn)!.push(m);
    }

    const instructorRows = db
      .prepare(
        `SELECT crn, name FROM instructors WHERE term = ? AND crn IN (${crnPhs})`,
      )
      .all(term, ...crns) as Array<{ crn: string; name: string }>;
    const instructorsByCrn = new Map<string, string[]>();
    for (const i of instructorRows) {
      if (!instructorsByCrn.has(i.crn)) instructorsByCrn.set(i.crn, []);
      instructorsByCrn.get(i.crn)!.push(i.name);
    }

    // fitsAroundCrns: exclude any section whose meetings overlap the anchor
    // CRNs' meetings — getMeetingsForCrns + the same overlap test as
    // fittingSet (scripts/schedule-options-benchmark/chain-scenarios.ts:41-66).
    // Untimed/online sections (no meetings) never conflict.
    const fitsAroundCrns =
      filters.fitsAroundCrns && filters.fitsAroundCrns.length > 0
        ? filters.fitsAroundCrns
        : null;
    const anchorMeetings = fitsAroundCrns
      ? getMeetingsForCrns(db, term, fitsAroundCrns)
      : [];

    // -------------------------------------------------------------------
    // Row-level filters — day/time window + fit, adapted from
    // find-sections-by-schedule's handler (src/mcp-tools/clemson-advising.ts,
    // tool at ~line 713). days: a section qualifies only if EVERY meeting
    // day is in the given set (a MW course fits "MWF"; a MWF course does
    // NOT fit "MW").
    // -------------------------------------------------------------------
    const daysWithin = filters.days?.toUpperCase();
    const excludeDaySet =
      filters.excludeDays && filters.excludeDays.length > 0
        ? new Set(filters.excludeDays.map((d) => d.toUpperCase()))
        : null;
    const noMeetingBeforeMins =
      filters.noMeetingBefore !== undefined
        ? hhmmToMins(filters.noMeetingBefore)
        : null;
    const noMeetingAfterMins =
      filters.noMeetingAfter !== undefined
        ? hhmmToMins(filters.noMeetingAfter)
        : null;

    const timeDayConstraintGiven =
      daysWithin !== undefined ||
      excludeDaySet !== null ||
      noMeetingBeforeMins !== null ||
      noMeetingAfterMins !== null;

    const matched: EngineSection[] = [];

    for (const row of rows) {
      const mgs = meetingsByCrn.get(row.crn) ?? [];
      const hasMeetings = mgs.length > 0;

      // Async/online sections (no meeting rows) can't satisfy a time/day
      // rule at all — exclude them from a time/day search rather than
      // silently keeping them.
      if (timeDayConstraintGiven && !hasMeetings) continue;

      if (timeDayConstraintGiven && hasMeetings) {
        let violates = false;
        if (daysWithin !== undefined && mgs.some((m) => !daysWithin.includes(m.day)))
          violates = true;
        if (!violates && excludeDaySet && mgs.some((m) => excludeDaySet.has(m.day)))
          violates = true;
        if (
          !violates &&
          noMeetingBeforeMins !== null &&
          mgs.some((m) => m.start_min < noMeetingBeforeMins!)
        )
          violates = true;
        if (
          !violates &&
          noMeetingAfterMins !== null &&
          mgs.some((m) => m.end_min > noMeetingAfterMins!)
        )
          violates = true;
        if (violates) continue;
      }

      if (fitsAroundCrns) {
        if (fitsAroundCrns.includes(row.crn)) continue; // anchors themselves aren't candidates
        const conflict = mgs.some((cm) =>
          anchorMeetings.some(
            (am) =>
              cm.day === am.day &&
              cm.start_min < am.endMin &&
              am.startMin < cm.end_min,
          ),
        );
        if (conflict) continue;
      }

      matched.push({
        crn: row.crn,
        subjectCourse: row.subject_course,
        title: row.title,
        creditHours: row.credit_hours,
        seatsAvailable: row.seats_available,
        instructors: instructorsByCrn.get(row.crn) ?? [],
        meetings: mgs.map((m) => ({
          day: m.day,
          start: minsToHHMM(m.start_min),
          end: minsToHHMM(m.end_min),
          building: m.building,
          room: m.room,
        })),
      });
    }

    // Most-open sections first — matches find-sections-by-schedule.
    matched.sort((a, b) => b.seatsAvailable - a.seatsAvailable);

    const totalCount = matched.length;

    if (totalCount > NARROW_THRESHOLD) {
      const bySubject = new Map<string, number>();
      for (const m of matched) {
        const subj = m.subjectCourse.match(/^[A-Za-z]+/)?.[0] ?? "?";
        bySubject.set(subj, (bySubject.get(subj) ?? 0) + 1);
      }
      return {
        totalCount,
        sections: [],
        needsNarrowing: {
          total: totalCount,
          bySubject: Object.fromEntries(bySubject),
        },
        snapshotDate: meta.fetchedAt,
      };
    }

    const offset = filters.offset ?? 0;
    const max = Math.min(Math.max(filters.max ?? 50, 1), 500);
    const page = matched.slice(offset, offset + max);

    return { totalCount, sections: page, snapshotDate: meta.fetchedAt };
  } finally {
    db.close();
  }
}
