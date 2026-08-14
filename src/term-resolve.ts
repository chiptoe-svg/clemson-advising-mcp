// src/term-resolve.ts
//
// Shared term resolver for the Clemson MCP tool surface. Every tool that
// takes a `term` should route it through resolveTerm() rather than requiring
// the caller to know Clemson's YYYYMM term-code scheme: it defaults to the
// current registration term by date, accepts natural-language forms
// ("Spring 2027", "fall", "202608"), and — when a term resolves but has no
// snapshot on disk — returns an error naming the available terms instead of
// a bare failure ("errors-as-redirects"). This kills a measured
// tool-selection trap where models guessed at term codes.
import fs from "fs";
import path from "path";

import { STATE_DIR } from "./config.js";

export interface TermResolution {
  term: string;
  termName: string;
}

export interface TermError {
  error: string;
  availableTerms: string[];
}

const SEASON_CODE: Record<string, string> = {
  spring: "01",
  summer: "05",
  fall: "08",
};

const CODE_SEASON: Record<string, string> = {
  "01": "Spring",
  "05": "Summer",
  "08": "Fall",
};

const ACCEPTED_FORMS =
  'Accepted forms: a 6-digit term code (e.g. "202701"), "<season> <year>" ' +
  '(e.g. "Spring 2027"), or a bare season name ("Spring", "Summer", "Fall").';

// ---------------------------------------------------------------------------
// Snapshot availability
// ---------------------------------------------------------------------------

// Same path logic as scheduleDbPath (src/clemson-schedule-db.ts:26-31):
// STATE_DIR is captured at config.ts module-load time, so tests must set
// process.env.STATE_DIR before dynamically importing this module (see
// test/clemson-advising.test.ts for the established pattern).
function snapshotDir(): string {
  return path.join(STATE_DIR, "clemson");
}

export function listSnapshotTerms(): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(snapshotDir());
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^\d{6}\.db$/.test(name))
    .map((name) => name.slice(0, 6))
    .sort();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTermName(code: string): string {
  const year = code.slice(0, 4);
  const season = CODE_SEASON[code.slice(4, 6)];
  return `${season} ${year}`;
}

// ---------------------------------------------------------------------------
// Default (current registration term by date)
// ---------------------------------------------------------------------------

// May 1 - Nov 30 -> Fall of that year (YYYY08).
// Dec 1 - Apr 30 -> Spring of the following calendar year:
//   Dec uses year+1 ((YYYY+1)01); Jan-Apr use the current year (YYYY01).
function defaultTerm(now: Date): string {
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12

  if (month === 12) return `${year + 1}01`;
  if (month >= 1 && month <= 4) return `${year}01`;
  return `${year}08`; // May (5) - Nov (11)
}

// Next occurrence of `season` strictly after `anchorCode` (a YYYYMM term
// code). Term codes sort correctly as numbers within a year because
// Spring(01) < Summer(05) < Fall(08).
function nextOccurrence(season: string, anchorCode: string): string {
  const seasonCode = SEASON_CODE[season];
  const anchorYear = Number(anchorCode.slice(0, 4));
  let candidate = `${anchorYear}${seasonCode}`;
  if (Number(candidate) <= Number(anchorCode)) {
    candidate = `${anchorYear + 1}${seasonCode}`;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function unparseableError(input: string, availableTerms: string[]): TermError {
  return {
    error: `Unrecognized term "${input}". ${ACCEPTED_FORMS}`,
    availableTerms,
  };
}

export function resolveTerm(
  input?: string,
  now: Date = new Date(),
): TermResolution | TermError {
  const availableTerms = listSnapshotTerms();
  const trimmed = input?.trim() ?? "";

  let termCode: string;

  if (trimmed === "") {
    termCode = defaultTerm(now);
  } else if (/^\d{6}$/.test(trimmed)) {
    const mm = trimmed.slice(4, 6);
    if (!(mm in CODE_SEASON)) {
      return unparseableError(trimmed, availableTerms);
    }
    termCode = trimmed;
  } else {
    const seasonYear = /^(spring|summer|fall)\s+(\d{4})$/i.exec(trimmed);
    if (seasonYear) {
      const season = seasonYear[1].toLowerCase();
      const year = seasonYear[2];
      termCode = `${year}${SEASON_CODE[season]}`;
    } else {
      const bareSeason = /^(spring|summer|fall)$/i.exec(trimmed);
      if (bareSeason) {
        const season = bareSeason[1].toLowerCase();
        termCode = nextOccurrence(season, defaultTerm(now));
      } else {
        return unparseableError(trimmed, availableTerms);
      }
    }
  }

  const termName = formatTermName(termCode);

  if (!availableTerms.includes(termCode)) {
    return {
      error:
        `No snapshot available for ${termName} (${termCode}). ` +
        `Available terms: ${availableTerms.join(", ")}.`,
      availableTerms,
    };
  }

  return { term: termCode, termName };
}
