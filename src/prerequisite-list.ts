// src/prerequisite-list.ts
// A subject's prerequisite graph in one read: for each course, the course
// codes its prerequisite names. Written for the admin enrollment forecast,
// which finds feeder courses from history (Cob_advisor, 2026-10-31).
//
// Same precedence as every other prerequisite surface: a hand-reviewed rule
// still valid against its catalog text (reviewedRules) wins over the
// catalog's flat code list. Only a reviewed rule can say "concurrent" or name
// a condition; the flat list says a course is NAMED, not how, so a text-source
// entry carries its wording verbatim and makes no concurrent claim. A course
// whose wording names no course code is listed in `unparsed` — never read as
// having no prerequisite.

import type Database from "better-sqlite3";

import { normalizeCourseCode } from "./catalog-read.js";
import { parsePrereq, type Expr } from "./prereq-expr.js";
import { reviewedRules } from "./reviewed-prereq.js";

export interface PrerequisiteEntry {
  course: string;
  title: string | null;
  /** Codes to have taken before (for "text": every code the wording names). */
  prerequisites: string[];
  /** "expression" only: codes that may also be taken in the same term. */
  concurrent?: string[];
  /** "expression" only: standing / major / consent / test conditions. */
  other?: string[];
  /** "expression" only: the reviewed rule, with its and/or structure. */
  rule?: string;
  review_note?: string;
  /** "text" only: the catalog wording, verbatim. */
  prereq_text?: string;
  source: "expression" | "text" | "none";
}

export interface PrerequisiteList {
  courses: PrerequisiteEntry[];
  /** Courses with prerequisite wording that names no course code. */
  unparsed: string[];
  unknown_courses?: string[];
}

export const PREREQUISITE_BASIS =
  "source 'expression' is a hand-reviewed rule: prerequisites must come " +
  "first, concurrent may be taken the same term, rule keeps the and/or " +
  "structure. source 'text' is the catalog's own list of codes its wording " +
  "names — it may be required, one of several options, or allowed in the " +
  "same term; read prereq_text. unparsed courses have wording that names no " +
  "course (consent, standing, ...): not the same as no prerequisite.";

function split(e: Expr) {
  const before: string[] = [];
  const same: string[] = [];
  const other: string[] = [];
  const walk = (x: Expr) => {
    if (x.t === "course") {
      const into = x.concurrent ? same : before;
      if (!into.includes(x.code)) into.push(x.code);
    } else if (x.t === "and" || x.t === "or") x.of.forEach(walk);
    else if (x.t === "cond")
      other.push(x.value ? `${x.kind}: ${x.value}` : x.kind);
    else other.push(x.text);
  };
  walk(e);
  return { before, same: same.filter((c) => !before.includes(c)), other };
}

export function listPrerequisites(
  db: Database.Database,
  opts: { subject?: string; courses?: string[] },
): PrerequisiteList {
  type Row = {
    code: string;
    title: string | null;
    prereq_text: string | null;
    prereq_parsed: string | null;
  };
  const conds: string[] = [];
  const params: string[] = [];
  if (opts.subject) {
    conds.push("subject = ?");
    params.push(opts.subject.toUpperCase());
  }
  const wanted = (opts.courses ?? []).map(
    (c) => normalizeCourseCode(c) ?? c.trim().toUpperCase(),
  );
  if (wanted.length) {
    conds.push(`code IN (${wanted.map(() => "?").join(",")})`);
    params.push(...wanted);
  }
  const rows = db
    .prepare(
      `SELECT code, title, prereq_text, prereq_parsed FROM course
        ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
        ORDER BY code`,
    )
    .all(...params) as Row[];
  const rules = reviewedRules(db);
  const unparsed: string[] = [];
  const courses = rows.map((r): PrerequisiteEntry => {
    const rule = rules.get(r.code);
    if (rule) {
      const { before, same, other } = split(parsePrereq(rule.expr));
      return {
        course: r.code,
        title: r.title,
        prerequisites: before,
        ...(same.length ? { concurrent: same } : {}),
        ...(other.length ? { other } : {}),
        rule: rule.expr,
        ...(rule.note ? { review_note: rule.note } : {}),
        source: "expression",
      };
    }
    const text = r.prereq_text?.trim();
    if (!text)
      return {
        course: r.code,
        title: r.title,
        prerequisites: [],
        source: "none",
      };
    let codes: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.prereq_parsed ?? "[]");
      if (Array.isArray(parsed))
        codes = parsed.filter((c): c is string => typeof c === "string");
    } catch {
      // unreadable list: treated as naming nothing, so it lands in unparsed
    }
    if (codes.length === 0) unparsed.push(r.code);
    return {
      course: r.code,
      title: r.title,
      prerequisites: codes,
      prereq_text: text,
      source: "text",
    };
  });
  const found = new Set(rows.map((r) => r.code));
  const unknown = wanted.filter((c) => !found.has(c));
  return {
    courses,
    unparsed,
    ...(unknown.length ? { unknown_courses: unknown } : {}),
  };
}
