// src/mcp-tools/gc-coreqs.ts
//
// GC lecture/lab corequisite pairing — SIDE-EFFECT-FREE helper module.
// Lives apart from catalog.ts deliberately: catalog.ts calls registerTools()
// at module load, so importing it for this helper registered every catalog
// tool onto whichever server imported it (2026-08-14: get-course-details on
// the PUBLIC barrel pulled all 8767 catalog tools onto 8766, tripping the
// advisor bridge's name-collision guard). Same defect class as the
// presentedCrnsFromHolder/run.ts entrypoint incident: never import a
// registration/entrypoint module for a helper.
import Database from "better-sqlite3";

import { GC_ADVISOR_DB } from "../config.js";

// GC core courses come in lecture/lab pairs: a graded lecture (e.g. GC 4060)
// and a non-credit lab COREQ (GC 4061) taken together — advisors say "4060"
// meaning "4060/4061". gc_advisor now carries this structurally in
// course.coreq_parsed (a JSON array of codes, both directions), so we read that
// and just enrich each code with its title/credits (which the column lacks).
// The description-parse remains only as a transitional fallback for a catalog
// snapshot old enough to predate the coreq backfill.

export interface CoreqCourse {
  code: string;
  title: string | null;
  credits: string | null;
  relationship: string;
}

interface CourseRow {
  code: string;
  title: string | null;
  credits: string | null;
}

/** Normalize "gc4060"/"GC 4060" -> "GC 4060" (uppercase subject + space + number). */
function normCourseCode(raw: string): string | null {
  const m = /^\s*([A-Za-z]{2,4})\s*(\d{3,4}[A-Za-z]?)\s*$/.exec(raw);
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : null;
}

function isLabLike(title: string | null, credits: string | null): boolean {
  return credits === "0" || (title ?? "").toLowerCase().includes("laborator");
}

/** Describe the pair direction from which side is the non-credit lab. */
function relationshipFor(queried: CourseRow, paired: CourseRow): string {
  if (isLabLike(paired.title, paired.credits)) return "required non-credit lab (coreq)";
  if (isLabLike(queried.title, queried.credits)) return "lecture this lab accompanies";
  return "corequisite";
}

/**
 * Return the corequisite course(s) paired with `code`, enriched with title and
 * credits. Reads the structured coreq_parsed column (authoritative, both
 * directions); falls back to parsing the lab-description prose only when that
 * column is empty. Empty array when there is no coreq or the DB is unavailable.
 */
export function findCoreqs(rawCode: string): CoreqCourse[] {
  const code = normCourseCode(rawCode);
  if (!code) return [];

  let db: Database.Database;
  try {
    db = new Database(GC_ADVISOR_DB, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    const queried = db
      .prepare("SELECT code, title, credits, coreq_parsed, description FROM course WHERE code = ? LIMIT 1")
      .get(code) as
      | (CourseRow & { coreq_parsed: string | null; description: string | null })
      | undefined;
    if (!queried) return [];

    // Preferred path: the structured coreq_parsed JSON array.
    let codes: string[] = [];
    if (queried.coreq_parsed) {
      try {
        const arr = JSON.parse(queried.coreq_parsed);
        if (Array.isArray(arr)) codes = arr.filter((x): x is string => typeof x === "string");
      } catch {
        /* malformed — fall through to the prose fallback */
      }
    }

    if (codes.length === 0) {
      const fb = deriveCoreqFromDescription(db, code, queried.description);
      return fb ? [{ ...fb, relationship: relationshipFor(queried, fb) }] : [];
    }

    const out: CoreqCourse[] = [];
    for (const raw of codes) {
      const norm = normCourseCode(raw);
      if (!norm) continue;
      const row = db
        .prepare("SELECT code, title, credits FROM course WHERE code = ? LIMIT 1")
        .get(norm) as CourseRow | undefined;
      const paired: CourseRow = row ?? { code: norm, title: null, credits: null };
      out.push({ ...paired, relationship: relationshipFor(queried, paired) });
    }
    return out;
  } finally {
    db.close();
  }
}

/** Transitional fallback: derive the pair from the lab-description prose the way
 *  we did before gc_advisor populated coreq_parsed. Single result or null. */
function deriveCoreqFromDescription(
  db: Database.Database,
  code: string,
  description: string | null,
): CourseRow | null {
  // Is the queried course itself a lab that names its lecture?
  const m = description ? /accompany\s+(GC\s*\d{3,4})/i.exec(description) : null;
  if (m) {
    const lectureCode = normCourseCode(m[1]);
    const lec = lectureCode
      ? (db.prepare("SELECT code, title, credits FROM course WHERE code = ? LIMIT 1").get(lectureCode) as CourseRow | undefined)
      : undefined;
    if (lec) return lec;
  }
  // Otherwise, is there a non-credit lab that accompanies THIS course?
  const lab = db
    .prepare(
      `SELECT code, title, credits FROM course
       WHERE description LIKE '%accompany%' AND description LIKE ?
         AND (credits = '0' OR title LIKE '%Laboratory%')
       LIMIT 1`,
    )
    .get(`%${code}%`) as CourseRow | undefined;
  return lab ?? null;
}

