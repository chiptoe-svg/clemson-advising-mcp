// Recorded offering decisions — the THIRD provenance in this system, beside
// Banner observation (snapshots) and the published catalog. "PKSC 2200 will
// no longer run in falls" is something a person with departmental knowledge
// RECORDS; it is not observable and must never be smuggled into the evidence
// store (offerings.db is rebuilt from snapshots and would silently drop it).
//
// The store is a YAML file the operator edits by hand, read per request —
// deliberately in state/ rather than the public repository, because a
// department's scheduling intention can be known here before it is public.
// An ABSENT file means "nothing recorded" (a true absence); an UNREADABLE
// file is an ERROR — the recurring-defect rule, same as departments.ts.
//
//   # state/offering-decisions.yaml
//   decisions:
//     - course: "PKSC 2200"
//       expect: not_offered        # or: offered
//       seasons: [fall]            # and/or terms: ["202708"]
//       note: "Department discontinued fall sections"
//       source: "PKSC department chair, via C. Tonkin"
//       recorded: 2026-09-06
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { STATE_DIR } from "./config-mcp.js";

export interface OfferingDecision {
  course: string; // normalized spaceless-uppercase, e.g. "PKSC2200"
  expect: "offered" | "not_offered";
  seasons: string[]; // "fall" | "spring" | "summer"
  terms: string[]; // explicit term codes, mapped onto their season
  note?: string;
  source?: string;
  recorded?: string;
}

const DECISIONS_PATH = () =>
  process.env.OFFERING_DECISIONS ||
  path.join(STATE_DIR, "offering-decisions.yaml");

const SEASON_OF_CODE: Record<string, string> = {
  "01": "spring",
  "05": "summer",
  "08": "fall",
};

/**
 * Load every recorded decision, keyed by normalized course code. Absent file
 * = empty map (nothing recorded). Unreadable or malformed = throw; the tool
 * reports an error rather than serving estimates that silently ignore a
 * decision someone recorded.
 */
export function loadOfferingDecisions(): Map<string, OfferingDecision[]> {
  const p = DECISIONS_PATH();
  if (!fs.existsSync(p)) return new Map();
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    throw new Error(`offering decisions unreadable (${p}): ${String(err)}`);
  }
  const raw = (parsed as { decisions?: unknown })?.decisions;
  if (raw === undefined || raw === null) return new Map();
  if (!Array.isArray(raw))
    throw new Error(
      `offering decisions malformed (${p}): 'decisions' must be a list`,
    );
  const out = new Map<string, OfferingDecision[]>();
  raw.forEach((d, i) => {
    const rec = d as Record<string, unknown>;
    const courseRaw = typeof rec.course === "string" ? rec.course : "";
    const course = courseRaw.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z]{1,6}\d{3,4}$/.test(course))
      throw new Error(
        `offering decisions entry ${i + 1}: 'course' must be a course code, got ${JSON.stringify(courseRaw)}`,
      );
    const expect = rec.expect;
    if (expect !== "offered" && expect !== "not_offered")
      throw new Error(
        `offering decisions entry ${i + 1} (${course}): 'expect' must be "offered" or "not_offered"`,
      );
    const seasons = Array.isArray(rec.seasons)
      ? rec.seasons.map((s) => String(s).toLowerCase())
      : [];
    for (const s of seasons)
      if (!["fall", "spring", "summer"].includes(s))
        throw new Error(
          `offering decisions entry ${i + 1} (${course}): unknown season ${JSON.stringify(s)}`,
        );
    const terms = Array.isArray(rec.terms) ? rec.terms.map(String) : [];
    for (const t of terms)
      if (!/^\d{6}$/.test(t) || !SEASON_OF_CODE[t.slice(4)])
        throw new Error(
          `offering decisions entry ${i + 1} (${course}): 'terms' entries must be term codes like "202708", got ${JSON.stringify(t)}`,
        );
    if (seasons.length === 0 && terms.length === 0)
      throw new Error(
        `offering decisions entry ${i + 1} (${course}): give 'seasons' and/or 'terms'`,
      );
    const entry: OfferingDecision = {
      course,
      expect,
      seasons,
      terms,
      ...(typeof rec.note === "string" ? { note: rec.note } : {}),
      ...(typeof rec.source === "string" ? { source: rec.source } : {}),
      ...(rec.recorded !== undefined ? { recorded: String(rec.recorded) } : {}),
    };
    const list = out.get(course) ?? [];
    list.push(entry);
    out.set(course, list);
  });
  return out;
}

export interface KnownDecision {
  expect: "offered" | "not_offered";
  terms?: string[];
  note?: string;
  source?: string;
  recorded?: string;
}

/**
 * The decision applying to one course + season, or null. A season-wide
 * decision wins outright; term-scoped decisions attach with their terms
 * listed so a caller can see the decision is narrower than the season.
 */
export function decisionFor(
  decisions: readonly OfferingDecision[] | undefined,
  season: string,
): KnownDecision | null {
  if (!decisions) return null;
  for (const d of decisions) {
    if (d.seasons.includes(season)) {
      const { expect, note, source, recorded } = d;
      return {
        expect,
        ...(note ? { note } : {}),
        ...(source ? { source } : {}),
        ...(recorded ? { recorded } : {}),
      };
    }
  }
  const termHits: { d: OfferingDecision; terms: string[] }[] = [];
  for (const d of decisions) {
    const terms = d.terms.filter((t) => SEASON_OF_CODE[t.slice(4)] === season);
    if (terms.length > 0) termHits.push({ d, terms });
  }
  if (termHits.length === 0) return null;
  const { d, terms } = termHits[0];
  return {
    expect: d.expect,
    terms,
    ...(d.note ? { note: d.note } : {}),
    ...(d.source ? { source: d.source } : {}),
    ...(d.recorded ? { recorded: d.recorded } : {}),
  };
}
