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
  offered: number;
  observed: number;
  last_offered: string | null;
}

/**
 * Historical frequency per season — the evidence a caller turns into a
 * likelihood ("offered in 8 of 9 observed falls"). Derived arithmetic over
 * observed terms only; deliberately NOT a probability field, and never a
 * statement of the registrar's intent.
 */
export function seasonRollup(
  observed: readonly ObservedTerm[],
  offerings: readonly { term: string; section_count: number }[],
): Record<string, SeasonRollup> {
  const out: Record<string, SeasonRollup> = {};
  for (const t of observed) {
    const season = SEASON_OF[t.term.slice(4)];
    if (!season) continue;
    out[season] ??= { offered: 0, observed: 0, last_offered: null };
    out[season].observed += 1;
  }
  for (const o of offerings) {
    const season = SEASON_OF[o.term.slice(4)];
    if (!season) continue;
    out[season] ??= { offered: 0, observed: 0, last_offered: null };
    out[season].offered += 1;
    if (!out[season].last_offered || o.term > out[season].last_offered!)
      out[season].last_offered = o.term;
  }
  return out;
}
