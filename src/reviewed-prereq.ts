// src/reviewed-prereq.ts
// The hand-reviewed prerequisite rules (prereq_expression) for every tool that
// answers a prerequisite question — not only get-program-graph.
//
// Why (Cob_advisor, 2026-10-20): "finished GC 1010, 1020, 1040 — can she take
// GC 2070?" went 0/4. Every trial called get-course-details, read the catalog
// wording, and said yes; the reviewed correction (GC 1050 also required) was
// served only by the graph. A rule is used only while the catalog text it was
// reviewed against is unchanged (same hash as the graph's staleness check);
// a stale review falls back to the catalog wording, as before.

import crypto from "node:crypto";

import Database from "better-sqlite3";

import { CATALOG_DB } from "./config-mcp.js";
import { courseCodes, parsePrereq } from "./prereq-expr.js";

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** Notes worth showing a reader: corrections and "confirm" judgment calls —
 *  the same filter get-program-graph applies to review_note. */
const SHOWN_NOTE = /correction|confirm/i;

export interface ReviewedRule {
  code: string;
  expr: string;
  /** Course codes the reviewed rule names. */
  names: Set<string>;
  /** Present only for corrections and judgment calls a reader must see. */
  note?: string;
}

/** Every reviewed rule still valid against its catalog text, by course code. */
export function reviewedRules(
  db: Database.Database,
): Map<string, ReviewedRule> {
  const out = new Map<string, ReviewedRule>();
  let rows: {
    code: string;
    expr: string;
    source_text_hash: string;
    note: string | null;
    prereq_text: string | null;
  }[];
  try {
    rows = db
      .prepare(
        `SELECT p.code, p.expr, p.source_text_hash, p.note, c.prereq_text
           FROM prereq_expression p JOIN course c ON c.code = p.code`,
      )
      .all() as typeof rows;
  } catch {
    return out; // a catalog without the table: catalog wording only
  }
  for (const r of rows) {
    if (!r.prereq_text?.trim() || sha256(r.prereq_text) !== r.source_text_hash)
      continue;
    let names: Set<string>;
    try {
      names = new Set(courseCodes(parsePrereq(r.expr)));
    } catch {
      continue;
    }
    out.set(r.code, {
      code: r.code,
      expr: r.expr,
      names,
      ...(r.note && SHOWN_NOTE.test(r.note) ? { note: r.note } : {}),
    });
  }
  return out;
}

/** Fields to add beside prereq_text: present only when a reviewer's
 *  correction or judgment call applies to this course. */
export function reviewFields(
  rules: Map<string, ReviewedRule>,
  code: string,
): { review_note?: string; reviewed_prereq?: string } {
  const r = rules.get(code);
  return r?.note ? { review_note: r.note, reviewed_prereq: r.expr } : {};
}

/** reviewFields for callers without a catalog handle (the schedule server's
 *  course tools). An unreadable catalog adds nothing — never an error. */
export function reviewFieldsFor(
  codes: string[],
): Map<string, { review_note?: string; reviewed_prereq?: string }> {
  const out = new Map<
    string,
    { review_note?: string; reviewed_prereq?: string }
  >();
  let db: Database.Database;
  try {
    db = new Database(CATALOG_DB, { readonly: true, fileMustExist: true });
  } catch {
    return out;
  }
  try {
    const rules = reviewedRules(db);
    for (const c of codes) out.set(c, reviewFields(rules, c));
  } finally {
    db.close();
  }
  return out;
}

/** The meaning of the two fields, for tool descriptions. */
export const REVIEW_FIELDS_NOTE =
  "review_note / reviewed_prereq, when present, are a reviewer's correction " +
  "or judgment call on the catalog wording — the reviewed rule is the one to " +
  "use; say the note to the student.";
