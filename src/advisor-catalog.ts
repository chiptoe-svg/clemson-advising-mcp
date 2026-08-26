// Read-only catalog lookup for the advisor's course hover cards. Opens
// gc_advisor.db per call (like the get-program-requirements tool) so it always
// reflects the latest nightly rebuild. Course title/credits/description are
// public catalog data — not student PII — so this needs no consent gate.

import Database from "better-sqlite3";

import { GC_ADVISOR_DB } from "./config.js";

export interface CatalogCourse {
  code: string;
  title: string | null;
  credits: string | null;
  description: string | null;
}

interface CourseRow {
  code: string;
  title: string | null;
  credits: string | null;
  description: string | null;
}

// Normalize "gc4061", "GC 4061", "GC  4061" -> "GC 4061" (uppercase subject +
// single space + number), matching how course.code is stored. Returns null for
// anything that is not a plausible course code so a junk path 404s cleanly.
export function normalizeCourseCode(raw: string): string | null {
  const m = /^\s*([A-Za-z]{2,4})\s*(\d{3,4}[A-Za-z]?)\s*$/.exec(raw);
  if (!m) return null;
  return `${m[1].toUpperCase()} ${m[2].toUpperCase()}`;
}

export function lookupCourse(rawCode: string): CatalogCourse | null {
  const code = normalizeCourseCode(rawCode);
  if (!code) return null;

  let db: Database.Database;
  try {
    db = new Database(GC_ADVISOR_DB, { readonly: true, fileMustExist: true });
  } catch {
    return null; // catalog DB not loaded yet — treat as "no entry"
  }

  try {
    const row = db
      .prepare(
        "SELECT code, title, credits, description FROM course WHERE code = ? LIMIT 1",
      )
      .get(code) as CourseRow | undefined;
    if (!row) return null;
    return {
      code: row.code,
      title: row.title,
      credits: row.credits,
      description: row.description,
    };
  } finally {
    db.close();
  }
}

/**
 * The programs the advisor is allowed to be pointed at, with the catalog years
 * on offer. Backs GET /programs (the chat page's Program + Catalog year
 * selectors) and validates POST /program.
 *
 * "Program" here means a College of Business MAJOR the catalog carries a
 * semester-by-semester plan for (a `program` row of kind 'major' with at least
 * one plan_item, joined through requirement_group), plus Pre-Business, which
 * is stored under its own kind and has no plan of its own. Minors and
 * certificates are deliberately excluded: they are looked up by name through
 * get-program-requirements, they are not what a conversation is "about".
 *
 * Read-only, opened per call like lookupCourse so it follows the nightly
 * rebuild. A missing/unreadable DB yields empty lists rather than throwing —
 * the caller renders "no programs available" instead of 500ing the page.
 */
export interface ProgramOption {
  name: string;
  /** Catalog years this program exists in, newest first. */
  years: string[];
}

export interface ProgramCatalog {
  /** Every catalog year in the DB, newest first. */
  catalogYears: string[];
  programs: ProgramOption[];
}

export function listPrograms(): ProgramCatalog {
  let db: Database.Database;
  try {
    db = new Database(GC_ADVISOR_DB, { readonly: true, fileMustExist: true });
  } catch {
    return { catalogYears: [], programs: [] };
  }

  try {
    const years = (
      db
        .prepare("SELECT label FROM catalog_year ORDER BY label DESC")
        .all() as { label: string }[]
    ).map((r) => r.label);

    const rows = db
      .prepare(
        `SELECT p.name AS name, cy.label AS year
           FROM program p
           JOIN catalog_year cy ON cy.id = p.catalog_year_id
          WHERE p.kind = 'pre_business'
             OR (p.kind = 'major'
                 AND EXISTS (SELECT 1
                               FROM requirement_group rg
                               JOIN plan_item pi ON pi.group_id = rg.id
                              WHERE rg.program_id = p.id))
          ORDER BY p.name ASC, cy.label DESC`,
      )
      .all() as { name: string; year: string }[];

    const byName = new Map<string, string[]>();
    for (const row of rows) {
      const list = byName.get(row.name) ?? [];
      if (!list.includes(row.year)) list.push(row.year);
      byName.set(row.name, list);
    }
    return {
      catalogYears: years,
      programs: [...byName.entries()].map(([name, ys]) => ({ name, years: ys })),
    };
  } catch {
    return { catalogYears: [], programs: [] };
  } finally {
    db.close();
  }
}
