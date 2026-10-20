// src/course-dependents.ts
// "What needs this course?" — the downward walk over prerequisite edges.
//
// Prerequisites and dependents are the same edges read in two directions. The
// edges here are the catalog's flat code lists (course.prereq_parsed): they
// record that a course's prerequisite NAMES another course, not how — it may
// be required, one of several options, or allowed in the same term (GC 4060:
// "Preq or concurrent enrollment: GC 3460"). So every dependent carries its
// own prerequisite wording verbatim and nothing is labelled.
//
// Where a hand-reviewed rule exists (prereq_expression, still valid against
// its catalog text), its course codes REPLACE the flat list for that course:
// a review can add a prerequisite the wording omits (GC 2070 also needs GC
// 1050) or remove one it lists (GC 3020 does not need COOP 1010). Such a
// dependent carries review_note, because its wording alone would not show
// why it is listed (2026-10-20). Shared by get-course-details (schedule server) and get-course
// (catalog server) so the two can never give different answers.

import type Database from "better-sqlite3";

import { normalizeCourseCode } from "./catalog-read.js";
import { reviewedRules } from "./reviewed-prereq.js";

export interface Dependent {
  code: string;
  title: string | null;
  /** The dependent's own prerequisite wording, verbatim. */
  prereq_text: string | null;
  /** 1 = names the course directly; 2+ = further down the chain. */
  depth: number;
  /** For depth >= 2: the course one level up that this one names. */
  via?: string;
  /** A reviewer's correction or judgment call on this dependent's rule. */
  review_note?: string;
}

export interface DependentsResult {
  course: string;
  dependents: Dependent[];
  /** All matches before the cap. */
  total: number;
  truncated: boolean;
  basis: string;
}

export const DEPENDENTS_BASIS =
  "Courses whose published prerequisite names this course — or whose " +
  "reviewed rule does, where a reviewer corrected the wording (review_note " +
  "says so). Read each prereq_text: the course may be required, one of " +
  "several options, or allowed in the same term — this list does not say " +
  "which.";

const DEFAULT_LIMIT = 25;

export function prerequisiteFor(
  db: Database.Database,
  rawCode: string,
  opts: { chain?: boolean; subject?: string; limit?: number } = {},
): DependentsResult {
  const course = normalizeCourseCode(rawCode) ?? rawCode.trim().toUpperCase();
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const direct = db.prepare(
    `SELECT c.code, c.title, c.prereq_text
       FROM course c, json_each(c.prereq_parsed) j
      WHERE j.value = ? AND c.code <> ?
      ORDER BY c.code`,
  );

  const one = db.prepare(
    "SELECT code, title, prereq_text FROM course WHERE code = ?",
  );
  const rules = reviewedRules(db);
  type Row = { code: string; title: string | null; prereq_text: string | null };
  /** Direct dependents: the flat list, overridden by reviewed rules. */
  const directOf = (parent: string): Row[] => {
    const rows = (direct.all(parent, parent) as Row[]).filter(
      (r) => !rules.has(r.code) || rules.get(r.code)!.names.has(parent),
    );
    const have = new Set(rows.map((r) => r.code));
    for (const rule of rules.values())
      if (
        rule.code !== parent &&
        rule.names.has(parent) &&
        !have.has(rule.code)
      ) {
        const r = one.get(rule.code) as Row | undefined;
        if (r) rows.push(r);
      }
    return rows.sort((a, b) => a.code.localeCompare(b.code));
  };

  const found = new Map<string, Dependent>();
  const seen = new Set<string>([course]);
  let frontier = [course];
  for (let depth = 1; frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const parent of frontier) {
      const rows = directOf(parent);
      for (const r of rows) {
        if (seen.has(r.code)) continue;
        seen.add(r.code);
        found.set(r.code, {
          code: r.code,
          title: r.title,
          prereq_text: r.prereq_text,
          depth,
          ...(depth > 1 ? { via: parent } : {}),
          ...(rules.get(r.code)?.note
            ? { review_note: rules.get(r.code)!.note }
            : {}),
        });
        next.push(r.code);
      }
    }
    if (!opts.chain) break;
    frontier = next;
  }

  const subject = opts.subject?.trim().toUpperCase();
  const all = [...found.values()]
    .filter((d) => !subject || d.code.split(" ")[0] === subject)
    .sort((a, b) => a.depth - b.depth || a.code.localeCompare(b.code));
  return {
    course,
    dependents: all.slice(0, limit),
    total: all.length,
    truncated: all.length > limit,
    basis: DEPENDENTS_BASIS,
  };
}
