// Consolidated course-offering history — Chip's design point (2026-09-06):
// every term behind the current registration terms is FROZEN, so deriving a
// table from the snapshots cannot drift for those rows, and walking 30+ term
// files per request stops making sense once a decade is held.
//
// The table is a CACHE with a fingerprint, not a second source of truth: on
// every open it compares the stored fingerprint against the snapshot files on
// disk (term set + mtime + size) and rebuilds itself when they differ. The
// daily refresh therefore keeps it current by doing nothing at all, a
// hand-backfilled term is absorbed on the next read, and the table can never
// disagree with the snapshots for longer than one open. Deleting the file is
// always safe.
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { STATE_DIR } from "./config-mcp.js";
import {
  openScheduleDb,
  getScheduleDbMeta,
  scheduleDbPath,
} from "./clemson-schedule-db.js";
import { listSnapshotTerms } from "./term-resolve.js";
import { log } from "./log.js";

const OFFERINGS_DB = () => path.join(STATE_DIR, "clemson", "offerings.db");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS terms (
    term          TEXT PRIMARY KEY,
    data_as_of    TEXT,
    section_total INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS offerings (
    course_code   TEXT NOT NULL,
    term          TEXT NOT NULL,
    section_count INTEGER NOT NULL,
    PRIMARY KEY (course_code, term)
  );
  CREATE INDEX IF NOT EXISTS idx_offerings_code ON offerings(course_code);
`;

/** Fingerprint of the snapshot set: term + mtime + size, sorted. */
function snapshotFingerprint(): string {
  return listSnapshotTerms()
    .map((term) => {
      try {
        const st = fs.statSync(scheduleDbPath(term)!);
        return `${term}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${term}:gone`;
      }
    })
    .join("|");
}

function rebuild(db: Database.Database, fingerprint: string): void {
  const started = Date.now();
  db.exec("DELETE FROM terms; DELETE FROM offerings;");
  const insTerm = db.prepare("INSERT INTO terms VALUES (?,?,?)");
  const insOff = db.prepare("INSERT INTO offerings VALUES (?,?,?)");
  for (const term of listSnapshotTerms()) {
    const snap = openScheduleDb(term);
    if (!snap) continue;
    try {
      let fetchedAt: string | null = null;
      try {
        fetchedAt = getScheduleDbMeta(snap).fetchedAt;
      } catch {
        fetchedAt = null;
      }
      const rows = snap
        .prepare(
          "SELECT subject_course, COUNT(*) AS n FROM sections GROUP BY subject_course",
        )
        .all() as { subject_course: string; n: number }[];
      insTerm.run(
        term,
        fetchedAt,
        rows.reduce((a, r) => a + r.n, 0),
      );
      for (const r of rows) insOff.run(r.subject_course, term, r.n);
    } finally {
      snap.close();
    }
  }
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('fingerprint', ?)").run(
    fingerprint,
  );
  log.info("offerings cache rebuilt", {
    ms: Date.now() - started,
    terms: listSnapshotTerms().length,
  });
}

/**
 * Open the offerings cache, rebuilding it first if the snapshot set changed.
 * Callers own the handle and must close it.
 */
export function openOfferingsDb(): Database.Database {
  const db = new Database(OFFERINGS_DB());
  db.exec(SCHEMA);
  const fingerprint = snapshotFingerprint();
  const stored = db
    .prepare("SELECT value FROM meta WHERE key='fingerprint'")
    .get() as { value: string } | undefined;
  if (stored?.value !== fingerprint) {
    const tx = db.transaction(() => rebuild(db, fingerprint));
    tx();
  }
  return db;
}

export interface ObservedTerm {
  term: string;
  data_as_of: string | null;
}

export function observedTerms(db: Database.Database): ObservedTerm[] {
  return db
    .prepare("SELECT term, data_as_of FROM terms ORDER BY term")
    .all() as ObservedTerm[];
}

export function offeringsFor(
  db: Database.Database,
  codes: readonly string[],
): Map<string, { term: string; section_count: number }[]> {
  const phs = codes.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT course_code, term, section_count FROM offerings
        WHERE course_code IN (${phs}) ORDER BY term`,
    )
    .all(...codes) as {
    course_code: string;
    term: string;
    section_count: number;
  }[];
  const out = new Map<string, { term: string; section_count: number }[]>();
  for (const r of rows) {
    const list = out.get(r.course_code) ?? [];
    list.push({ term: r.term, section_count: r.section_count });
    out.set(r.course_code, list);
  }
  return out;
}

const SEASON_OF: Record<string, "spring" | "summer" | "fall"> = {
  "01": "spring",
  "05": "summer",
  "08": "fall",
};

export interface SeasonRollup {
  /** Whole observed history — the base fact. */
  offered: number;
  observed: number;
  /** Denominator starts at the course's first-ever appearance, so a young
   *  course is not judged by falls that predate its existence. */
  since_first_offered: { offered: number; observed: number } | null;
  /** The last 3 observed terms of this season — the is-it-still-alive signal. */
  recent: { offered: number; observed: number };
  last_offered: string | null;
  /** Most-recent observed season-terms in a row with no offering (0 = ran
   *  in the latest observed one) — the retirement signal. */
  consecutive_missed: number;
  /** Estimated probability the course runs in the NEXT term of this season:
   *  exponentially weighted history since first appearance (half-life = 2
   *  observed season-terms), clamped to [0.05, 0.97]. An estimate from
   *  observation, never a scheduling commitment; null when the course has
   *  never been observed anywhere. */
  estimated_probability: number | null;
  /** The probability as a student-communicable phrase. */
  label:
    | "very likely"
    | "likely"
    | "uncertain"
    | "unlikely"
    | "very unlikely"
    | "no basis"
    // Overrides applied by the tool layer when a RECORDED DECISION exists
    // (offering-decisions.ts) — the decision, not the estimate, is then the
    // student-facing answer:
    | "ruled out"
    | "confirmed";
}

const HALF_LIFE = 2; // observed season-terms

function labelFor(p: number | null): SeasonRollup["label"] {
  if (p === null) return "no basis";
  if (p >= 0.9) return "very likely";
  if (p >= 0.7) return "likely";
  if (p >= 0.4) return "uncertain";
  if (p >= 0.15) return "unlikely";
  return "very unlikely";
}

/**
 * Per-season offering evidence PLUS a probability estimate (Chip's call,
 * 2026-09-06: advisors need a number they can communicate to a student).
 * The estimate is deliberately reproducible arithmetic — an exponentially
 * weighted frequency over the course's own era, newest season-term weighted
 * 1, the one before 0.5^(1/HALF_LIFE)... — shipped WITH the evidence it came
 * from (recent, since_first_offered, consecutive_missed) and clamped away
 * from 0 and 1 so it can never read as a guarantee. A flat lifetime ratio
 * was rejected for mixing eras: it made new courses look unreliable and
 * retired ones look alive.
 */
export function seasonRollup(
  observed: readonly ObservedTerm[],
  offerings: readonly { term: string; section_count: number }[],
): Record<string, SeasonRollup> {
  const offeredSet = new Set(offerings.map((o) => o.term));
  const firstOffered =
    offerings.length > 0
      ? offerings.reduce((m, o) => (o.term < m ? o.term : m), offerings[0].term)
      : null;

  const bySeason = new Map<string, string[]>(); // season -> observed terms asc
  for (const t of observed) {
    const season = SEASON_OF[t.term.slice(4)];
    if (!season) continue;
    const list = bySeason.get(season) ?? [];
    list.push(t.term);
    bySeason.set(season, list);
  }

  const out: Record<string, SeasonRollup> = {};
  for (const [season, terms] of bySeason) {
    terms.sort();
    const ran = terms.map((t) => offeredSet.has(t));
    const offeredCount = ran.filter(Boolean).length;
    const lastOffered =
      [...terms].reverse().find((t) => offeredSet.has(t)) ?? null;
    let missed = 0;
    for (let i = terms.length - 1; i >= 0 && !ran[i]; i--) missed++;
    const recentTerms = terms.slice(-3);
    const recent = {
      offered: recentTerms.filter((t) => offeredSet.has(t)).length,
      observed: recentTerms.length,
    };

    // Era-aware series: observed season-terms since the course first ran
    // ANYWHERE. Null when the course was never observed at all.
    let sinceFirst: { offered: number; observed: number } | null = null;
    let probability: number | null = null;
    if (firstOffered !== null) {
      const era = terms.filter((t) => t >= firstOffered);
      sinceFirst = {
        offered: era.filter((t) => offeredSet.has(t)).length,
        observed: era.length,
      };
      if (era.length > 0) {
        let num = 0;
        let den = 0;
        // newest gets weight 1; each step back halves per HALF_LIFE terms
        for (let i = 0; i < era.length; i++) {
          const back = era.length - 1 - i;
          const w = Math.pow(0.5, back / HALF_LIFE);
          den += w;
          if (offeredSet.has(era[i])) num += w;
        }
        probability = Math.min(0.97, Math.max(0.05, num / den));
        probability = Math.round(probability * 100) / 100;
      }
    }

    out[season] = {
      offered: offeredCount,
      observed: terms.length,
      since_first_offered: sinceFirst,
      recent,
      last_offered: lastOffered,
      consecutive_missed: missed,
      estimated_probability: probability,
      label: labelFor(probability),
    };
  }
  return out;
}
