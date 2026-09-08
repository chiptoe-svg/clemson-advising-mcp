// Section-level enrollment and capacity history across terms — the demand /
// capacity-planning read.
//
// WHY BATCHED (2026-09-08). A demand analysis for 14 courses across 14 terms
// was being served as 196 separate search-classes calls and took ~30 minutes.
// Measured from the usage ledger, the server was 0.6% of that: 35 ms per round
// trip, of which the snapshot query is 3 ms. The other 99.4% was the CALLING
// AGENT's think-time — a median 5.3 s between consecutive calls, none
// overlapping, i.e. one model generation per call. So the win here is not I/O:
// collapsing 196 calls into 1 removes 195 inference round trips.
//
// The one structural rule that matters: open each term snapshot ONCE and query
// every requested course against it. Opening per (course, term) is what makes
// this O(N*T) instead of O(T).
import type Database from "better-sqlite3";

import { openScheduleDb, getScheduleDbMeta } from "./clemson-schedule-db.js";
import { listSnapshotTerms } from "./term-resolve.js";

export interface SectionRow {
  crn: string;
  enrollment: number | null;
  max_enrollment: number | null;
  seats_available: number | null;
}

export interface CourseTerm {
  term: string;
  section_count: number;
  total_enrollment: number | null;
  total_capacity: number | null;
  seats_available: number | null;
  /** total_enrollment / total_capacity, or null when capacity is unknown or
   *  zero. CAN EXCEED 1.0 — Clemson over-enrolls labs above their listed cap
   *  (GC 2071 ran 50 in 48 seats in Fall 2025), and clamping would hide the
   *  very over-subscription a capacity analysis is looking for. */
  fill_rate: number | null;
  full_sections: number;
  /** Sections at or above `section_size_threshold`, when the caller set one. */
  sections_at_threshold?: number;
  max_section_enrollment: number | null;
  sections?: SectionRow[];
}

/**
 * How the snapshot's capture time relates to the term's own lifecycle — the
 * field that decides whether two terms can be compared at all.
 *
 * Enrollment is a reading taken at a moment, not a property of a term. Past
 * terms here were swept long after they ended, so their numbers are settled;
 * the CURRENT term is mid-flight; a FUTURE term was swept before registration
 * had run and its counts are near-meaningless as demand. Plotting all three on
 * one axis produces a cliff that is an artifact of when we looked. Banner's own
 * "(View Only)" marker cannot carry this: it is set on Spring 2027 (not yet
 * open) exactly as on Fall 2025 (long finished).
 *
 * Derived from the snapshot date against the term's academic span, which is all
 * this deployment can actually know. Clemson's add/drop calendar is NOT
 * derivable here, so a term still inside its own dates reads `in_term` even
 * when its census is in practice locked — `data_as_of` is there to judge that.
 */
export type TermStatus = "final" | "in_term" | "pre_term";

/** Approximate academic span of a term code, [start, end) in UTC. */
function termSpan(term: string): { start: Date; end: Date } | null {
  const year = Number(term.slice(0, 4));
  const part = term.slice(4);
  if (!Number.isFinite(year)) return null;
  // Spring runs Jan–mid-May, summer mid-May–mid-Aug, fall mid-Aug–late Dec.
  if (part === "01")
    return {
      start: new Date(Date.UTC(year, 0, 5)),
      end: new Date(Date.UTC(year, 4, 15)),
    };
  if (part === "05")
    return {
      start: new Date(Date.UTC(year, 4, 15)),
      end: new Date(Date.UTC(year, 7, 15)),
    };
  if (part === "08")
    return {
      start: new Date(Date.UTC(year, 7, 15)),
      end: new Date(Date.UTC(year, 11, 23)),
    };
  return null;
}

export function termStatus(
  term: string,
  dataAsOf: string | null,
): TermStatus | null {
  const span = termSpan(term);
  if (!span || !dataAsOf) return null;
  const t = new Date(dataAsOf);
  if (Number.isNaN(t.getTime())) return null;
  if (t >= span.end) return "final";
  if (t >= span.start) return "in_term";
  return "pre_term";
}

export interface ObservedTermInfo {
  term: string;
  data_as_of: string | null;
  status: TermStatus | null;
}

// ZERO IS REAL DATA HERE, and cannot mean "unknown".
//
// The snapshot schema declares `enrollment INTEGER NOT NULL DEFAULT 0`, so a
// missing value is coerced to 0 when the term is written, before this module
// ever sees it. Fall 2025 holds 2,223 sections with 0 enrolled against a
// positive capacity — genuinely empty sections, not gaps. So a caller asking
// that missing values not be summed as zero gets that guarantee at the
// AGGREGATE layer (a sum over nothing stays null, never 0), but a per-section
// 0 means zero students. Distinguishing "no one enrolled" from "Banner did not
// say" would have to happen in the refresh pipeline, not here.
//
// The null-handling below is therefore defensive rather than currently
// reachable through the snapshot path: it is what keeps the aggregates honest
// if that column ever becomes nullable.
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Sum that stays null when NOTHING was known, rather than reporting 0. */
function sumOrNull(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

/**
 * Enrollment history for the given courses across the given terms.
 *
 * `codes` are normalized spaceless-uppercase ("GC3401"), matching how the
 * snapshots store subject_course. Terms not held as snapshots are simply not
 * returned — the caller reports them as UNOBSERVED, which is not the same as a
 * term where the course did not run.
 */
export function enrollmentHistory(
  codes: readonly string[],
  terms: readonly string[],
  opts: { includeSections: boolean; sizeThreshold: number | null },
): { observed: ObservedTermInfo[]; byCourse: Map<string, CourseTerm[]> } {
  const held = new Set(listSnapshotTerms());
  const wanted = terms.filter((t) => held.has(t)).sort();
  const observed: ObservedTermInfo[] = [];
  const byCourse = new Map<string, CourseTerm[]>();
  for (const code of codes) byCourse.set(code, []);

  const placeholders = codes.map(() => "?").join(",");
  for (const term of wanted) {
    // ONE open per term; every course is answered from this handle.
    const db: Database.Database | null = openScheduleDb(term);
    if (!db) continue;
    try {
      let asOf: string | null = null;
      try {
        asOf = getScheduleDbMeta(db).fetchedAt;
      } catch {
        asOf = null;
      }
      observed.push({ term, data_as_of: asOf, status: termStatus(term, asOf) });

      const rows = db
        .prepare(
          `SELECT subject_course, crn, enrollment, max_enrollment, seats_available
             FROM sections WHERE subject_course IN (${placeholders})
            ORDER BY subject_course, crn`,
        )
        .all(...codes) as Array<{
        subject_course: string;
        crn: string;
        enrollment: unknown;
        max_enrollment: unknown;
        seats_available: unknown;
      }>;

      const grouped = new Map<string, SectionRow[]>();
      for (const r of rows) {
        const list = grouped.get(r.subject_course) ?? [];
        list.push({
          crn: String(r.crn),
          enrollment: num(r.enrollment),
          max_enrollment: num(r.max_enrollment),
          seats_available: num(r.seats_available),
        });
        grouped.set(r.subject_course, list);
      }

      for (const [code, sections] of grouped) {
        const enr = sections.map((s) => s.enrollment);
        const cap = sections.map((s) => s.max_enrollment);
        const totalEnrollment = sumOrNull(enr);
        const totalCapacity = sumOrNull(cap);
        const known = enr.filter((v): v is number => v !== null);
        const entry: CourseTerm = {
          term,
          section_count: sections.length,
          total_enrollment: totalEnrollment,
          total_capacity: totalCapacity,
          seats_available: sumOrNull(sections.map((s) => s.seats_available)),
          fill_rate:
            totalEnrollment !== null &&
            totalCapacity !== null &&
            totalCapacity > 0
              ? Math.round((totalEnrollment / totalCapacity) * 10000) / 10000
              : null,
          full_sections: sections.filter(
            (s) =>
              s.max_enrollment !== null &&
              s.enrollment !== null &&
              s.enrollment >= s.max_enrollment,
          ).length,
          max_section_enrollment: known.length > 0 ? Math.max(...known) : null,
          ...(opts.sizeThreshold !== null
            ? {
                sections_at_threshold: sections.filter(
                  (s) =>
                    s.enrollment !== null &&
                    s.enrollment >= opts.sizeThreshold!,
                ).length,
              }
            : {}),
          ...(opts.includeSections ? { sections } : {}),
        };
        byCourse.get(code)!.push(entry);
      }
    } finally {
      db.close();
    }
  }
  return { observed, byCourse };
}
