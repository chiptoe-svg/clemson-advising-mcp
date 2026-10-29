// src/instructor-preferences.ts
// Instructor preferences (Chip, 2026-10-29: kept in a saved file, not typed
// per check). A hand-edited file, like state/course-groups.yaml, never
// written by a tool; check-schedule-draft reports a draft that breaks one:
//
//   # state/instructor-preferences.yaml
//   instructors:
//     "Jane Doe":            # name or email, matched like the checker's
//       avoid_days: "F"      # MTWRFSU letters
//       not_before: "0900"   # HHMM: no meeting starts earlier
//       not_after: "1700"    # HHMM: no meeting ends later
//       max_sections: 4      # sections in the draft
//
// An ABSENT file means no preferences; an UNREADABLE or malformed one is an
// error, never silently ignored. Read on every call, so an edit lands at once.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { STATE_DIR } from "./config-mcp.js";

export interface InstructorPreference {
  avoidDays?: string;
  notBefore?: string; // HHMM
  notAfter?: string; // HHMM
  maxSections?: number;
}

const PREFS_PATH = () =>
  process.env.INSTRUCTOR_PREFERENCES ||
  path.join(STATE_DIR, "instructor-preferences.yaml");

const FIELDS = new Set([
  "avoid_days",
  "not_before",
  "not_after",
  "max_sections",
]);
const HHMM = (t: unknown) =>
  typeof t === "string" &&
  /^\d{4}$/.test(t) &&
  Number(t.slice(0, 2)) < 24 &&
  Number(t.slice(2)) < 60;

/** Preferences keyed by the name or email exactly as the file writes it. */
export function loadInstructorPreferences(): Map<string, InstructorPreference> {
  const p = PREFS_PATH();
  if (!fs.existsSync(p)) return new Map();
  const bad = (why: string) =>
    new Error(`instructor preferences unreadable (${p}): ${why}`);
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    throw bad(String(err));
  }
  const raw = (parsed as { instructors?: unknown } | null)?.instructors;
  if (raw === undefined || raw === null) return new Map();
  if (typeof raw !== "object" || Array.isArray(raw))
    throw bad("'instructors' must be a map of name or email: preferences");
  const out = new Map<string, InstructorPreference>();
  for (const [who, v] of Object.entries(raw as Record<string, unknown>)) {
    const x = (v ?? {}) as Record<string, unknown>;
    if (typeof x !== "object" || Array.isArray(x))
      throw bad(`"${who}" must be a map of preferences`);
    for (const k of Object.keys(x))
      if (!FIELDS.has(k))
        throw bad(
          `"${who}" has unknown field ${k} (known: ${[...FIELDS].join(", ")})`,
        );
    const pref: InstructorPreference = {};
    if (x.avoid_days !== undefined) {
      const days = String(x.avoid_days).toUpperCase();
      if (!/^[MTWRFSU]+$/.test(days))
        throw bad(
          `"${who}" avoid_days must use the letters MTWRFSU (R = Thursday)`,
        );
      pref.avoidDays = days;
    }
    if (x.not_before !== undefined) {
      if (!HHMM(x.not_before))
        throw bad(
          `"${who}" not_before must be 24-hour HHMM in quotes, e.g. "0900"`,
        );
      pref.notBefore = x.not_before as string;
    }
    if (x.not_after !== undefined) {
      if (!HHMM(x.not_after))
        throw bad(
          `"${who}" not_after must be 24-hour HHMM in quotes, e.g. "1700"`,
        );
      pref.notAfter = x.not_after as string;
    }
    if (x.max_sections !== undefined) {
      if (!Number.isInteger(x.max_sections) || (x.max_sections as number) < 1)
        throw bad(`"${who}" max_sections must be a whole number of at least 1`);
      pref.maxSections = x.max_sections as number;
    }
    out.set(who, pref);
  }
  return out;
}
