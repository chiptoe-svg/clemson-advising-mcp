// The departmental layer — decisions RECORDED BY DEPARTMENTS, deliberately
// separate from the published catalog (docs/security.md). The store is the
// files under departments/<id>/: rules.yaml (slot allow/deny decisions,
// the faculty roster, planning rules) and SKILL.md (the department's
// advising-policy document). Files are the source
// of truth and are read per request with an mtime cache, so an edit serves on
// the next call — no build step, no restart.
//
// Nothing in catalog.db references this layer, and the catalog tools serve
// none of its data: that separation is what keeps the catalog server a
// faithful mirror of the published catalog, and what makes this layer
// extractable later (to a department-run service) by re-pointing consumers
// rather than rewriting. ONE deliberate exception (Chip, 2026-11-11): the
// planning rules shape what-if-plan and get-program-graph answers for every
// caller, so a plan the department would reject is never offered as fine.
// Those answers quote a rule's sentence; the rules list itself is served
// only here.
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { DEPARTMENTS_DIR } from "./config-mcp.js";
import { log } from "./log.js";

export interface DepartmentRuleCourse {
  code: string;
  note?: string;
}

/**
 * A roster member as the department records them. `banner_name` is the exact
 * instructor string Banner publishes on sections — the join key for the
 * schedule server's instructor tools — recorded whenever it differs from (or
 * simply pins) the roster spelling.
 */
export interface DepartmentFacultyMember {
  name: string;
  banner_name?: string;
  note?: string;
}

export interface DepartmentSlot {
  slot_type: string;
  allow: DepartmentRuleCourse[];
  deny: DepartmentRuleCourse[];
}

/**
 * When and with what a course may be taken — the department's sequencing
 * and load decisions, which neither the catalog plan nor Degree Works
 * encodes. Each rule carries its sentence (`text`) and its ruling (`source`)
 * so any reader can quote it.
 */
export type PlanningRule = { text: string; source: string } &
  /** A warning, never a constraint: the combination is discouraged. */
  (
    | { kind: "avoid_same_term"; courses: string[] }
    /** Registered together: always placed in one term, like a lab. */
    | { kind: "same_term"; courses: string[] }
    | {
        kind: "at_most_in_season";
        season: "summer";
        n: number;
        /** Each group is one requirement; its codes are alternatives. */
        groups: string[][];
      }
    | { kind: "before"; first: string[]; then: string[] }
    | {
        kind: "term_load";
        when_any: string[];
        not_counted: string[];
        max_other_credits: number;
        preferred_other_credits: number;
      }
    | { kind: "term_excludes"; when_any: string[]; courses: string[] }
  );

export interface DepartmentRules {
  id: string;
  department: string | null;
  programs: string[];
  faculty: DepartmentFacultyMember[];
  slots: DepartmentSlot[];
  planning: PlanningRule[];
}

function dirFor(id: string): string | null {
  // The id is a path component; same guard shape as scheduleDbPath.
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return null;
  const dir = path.join(DEPARTMENTS_DIR, id);
  return fs.existsSync(dir) ? dir : null;
}

/** Department ids = the directories that exist. Sorted, stable. */
export function listDepartments(): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(DEPARTMENTS_DIR, { withFileTypes: true });
  } catch (err) {
    log.warn("departments dir unreadable", { err: String(err) });
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^[a-z][a-z0-9-]*$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

function coerceCourses(raw: unknown): DepartmentRuleCourse[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c): c is Record<string, unknown> =>
        !!c &&
        typeof c === "object" &&
        typeof (c as { code?: unknown }).code === "string",
    )
    .map((c) => ({
      code: String(c.code),
      ...(typeof c.note === "string" ? { note: c.note } : {}),
    }));
}

function coerceFaculty(raw: unknown): DepartmentFacultyMember[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (f): f is Record<string, unknown> =>
        !!f &&
        typeof f === "object" &&
        typeof (f as { name?: unknown }).name === "string",
    )
    .map((f) => ({
      name: String(f.name),
      ...(typeof f.banner_name === "string"
        ? { banner_name: f.banner_name }
        : {}),
      ...(typeof f.note === "string" ? { note: f.note } : {}),
    }));
}

const CODE = /^[A-Z]{2,5} \d{4}$/;

/**
 * The `planning:` list of a rules file, validated strictly: an unknown kind
 * or a malformed field throws. A rule that fails to parse must never be
 * dropped, because a dropped rule reads as "no such rule" and the plans it
 * forbids would be offered as fine.
 */
// The fields each kind may carry; any other key is an error, so a
// misspelt or invented condition is never silently dropped.
const RULE_FIELDS: Record<string, readonly string[]> = {
  avoid_same_term: ["courses"],
  same_term: ["courses"],
  at_most_in_season: ["season", "n", "groups"],
  before: ["first", "then"],
  term_load: [
    "when_any",
    "not_counted",
    "max_other_credits",
    "preferred_other_credits",
  ],
  term_excludes: ["when_any", "courses"],
};

export function parsePlanningRules(raw: unknown): PlanningRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("planning must be a list");
  const rules = raw.map((r, i): PlanningRule => {
    const at = `planning rule ${i + 1}`;
    if (!r || typeof r !== "object") throw new Error(`${at}: not a mapping`);
    const o = r as Record<string, unknown>;
    const allowed = RULE_FIELDS[String(o.kind)];
    if (allowed)
      for (const k of Object.keys(o))
        if (!["kind", "text", "source", ...allowed].includes(k))
          throw new Error(`${at}: unknown field ${JSON.stringify(k)}`);
    const str = (k: string): string => {
      if (typeof o[k] !== "string" || !(o[k] as string).trim())
        throw new Error(`${at}: ${k} must be a non-empty string`);
      return o[k] as string;
    };
    const codes = (k: string, min = 1): string[] => {
      const v = o[k];
      if (
        !Array.isArray(v) ||
        v.length < min ||
        !v.every((c) => typeof c === "string" && CODE.test(c))
      )
        throw new Error(
          `${at}: ${k} must be a list of ${min === 0 ? "" : `at least ${min === 2 ? "two " : "one "}`}course codes like "GC 3500"`,
        );
      const dup = v.find((c, j) => v.indexOf(c) !== j);
      if (dup) throw new Error(`${at}: ${k} lists ${dup} twice`);
      return v as string[];
    };
    const int = (k: string): number => {
      if (!Number.isInteger(o[k]) || (o[k] as number) < 0)
        throw new Error(`${at}: ${k} must be a whole number`);
      return o[k] as number;
    };
    const text = str("text");
    const source = str("source");
    switch (o.kind) {
      case "avoid_same_term":
      case "same_term":
        return { kind: o.kind, text, source, courses: codes("courses", 2) };
      case "at_most_in_season": {
        if (o.season !== "summer")
          throw new Error(`${at}: season must be "summer"`);
        const g = o.groups;
        if (!Array.isArray(g) || g.length < 2)
          throw new Error(`${at}: groups must list at least two groups`);
        const groups = g.map((x, j) => {
          if (
            !Array.isArray(x) ||
            x.length === 0 ||
            !x.every((c) => typeof c === "string" && CODE.test(c))
          )
            throw new Error(
              `${at}: groups[${j}] must be a list of course codes`,
            );
          return x as string[];
        });
        const n = int("n");
        if (n < 1 || n >= groups.length)
          throw new Error(
            `${at}: n must be at least 1 and fewer than the ${groups.length} groups`,
          );
        return { kind: o.kind, text, source, season: "summer", n, groups };
      }
      case "before": {
        const first = codes("first");
        const then = codes("then");
        const both = first.find((c) => then.includes(c));
        if (both) throw new Error(`${at}: ${both} is in both first and then`);
        return { kind: o.kind, text, source, first, then };
      }
      case "term_load": {
        const max = int("max_other_credits");
        const preferred = int("preferred_other_credits");
        if (preferred > max)
          throw new Error(
            `${at}: preferred_other_credits cannot exceed max_other_credits`,
          );
        return {
          kind: o.kind,
          text,
          source,
          when_any: codes("when_any"),
          not_counted:
            o.not_counted === undefined ? [] : codes("not_counted", 0),
          max_other_credits: max,
          preferred_other_credits: preferred,
        };
      }
      case "term_excludes":
        return {
          kind: o.kind,
          text,
          source,
          when_any: codes("when_any"),
          courses: codes("courses"),
        };
      default:
        throw new Error(`${at}: unknown kind ${JSON.stringify(o.kind)}`);
    }
  });
  // `before` rules that order a course after itself can never be met: the
  // engine would fail with a misleading placement error, so refuse here.
  const after = new Map<string, string[]>();
  for (const r of rules)
    if (r.kind === "before")
      for (const f of r.first)
        after.set(f, [...(after.get(f) ?? []), ...r.then]);
  const walk = (c: string, path: string[]): void => {
    if (path.includes(c))
      throw new Error(
        `before rules form a cycle: ${[...path.slice(path.indexOf(c)), c].join(" -> ")}`,
      );
    for (const n of after.get(c) ?? []) walk(n, [...path, c]);
  };
  for (const c of after.keys()) walk(c, []);
  return rules;
}

/**
 * The planning rules of the department that lists `program` among its
 * programs; [] when none does or it records none. An unreadable rules file
 * throws, as everywhere in this layer.
 */
export function planningRulesForProgram(program: string): PlanningRule[] {
  // Not listDepartments(), which logs and returns [] for an unreadable
  // store: here that would drop every rule in silence.
  try {
    fs.readdirSync(DEPARTMENTS_DIR);
  } catch (err) {
    throw new Error(`department rules unreadable: ${String(err)}`);
  }
  for (const id of listDepartments()) {
    const rules = getDepartmentRules(id);
    if (rules?.programs.includes(program)) return rules.planning;
  }
  return [];
}

/**
 * A department's recorded decisions, or null when the department id itself is
 * unknown. A KNOWN department with nothing recorded returns empty slots — and
 * the tool layer states that plainly, because "no decisions recorded" is an
 * answer, never an absence.
 */
export function getDepartmentRules(id: string): DepartmentRules | null {
  const dir = dirFor(id);
  if (!dir) return null;
  const p = path.join(dir, "rules.yaml");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (YAML.parse(fs.readFileSync(p, "utf-8")) ?? {}) as Record<
      string,
      unknown
    >;
  } catch (err) {
    // An unreadable rules file must not be served as "no rules recorded" —
    // that is this project's recurring defect. Throw; the tool reports an error.
    throw new Error(`department rules unreadable for "${id}": ${String(err)}`);
  }
  const slotsRaw = Array.isArray(parsed.slots) ? parsed.slots : [];
  let planning: PlanningRule[];
  try {
    planning = parsePlanningRules(parsed.planning);
  } catch (err) {
    throw new Error(
      `department rules unreadable for "${id}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    planning,
    id,
    department:
      typeof parsed.department === "string" ? parsed.department : null,
    programs: Array.isArray(parsed.programs) ? parsed.programs.map(String) : [],
    faculty: coerceFaculty(parsed.faculty),
    slots: slotsRaw
      .filter(
        (s): s is Record<string, unknown> =>
          !!s &&
          typeof s === "object" &&
          typeof (s as { slot_type?: unknown }).slot_type === "string",
      )
      .map((s) => ({
        slot_type: String(s.slot_type),
        allow: coerceCourses(s.allow),
        deny: coerceCourses(s.deny),
      })),
  };
}

/** The department's policy document, or null when the id is unknown. */
export function getDepartmentDoc(
  id: string,
): { id: string; content: string } | null {
  const dir = dirFor(id);
  if (!dir) return null;
  const p = path.join(dir, "SKILL.md");
  try {
    // HTML comments are maintainer notes (review stamps, provenance) and are
    // stripped before serving: they are addressed to whoever edits the file,
    // not to the model, and one of them quotes a retracted rule verbatim.
    // test/department-doc-freshness.test.ts reads the FILE, so the stamp it
    // checks is unaffected.
    const raw = fs.readFileSync(p, "utf-8");
    const content = raw
      .replace(/<!--[\s\S]*?-->\n?/g, "")
      .replace(/\n{3,}/g, "\n\n");
    return { id, content };
  } catch (err) {
    throw new Error(
      `department document unreadable for "${id}": ${String(err)}`,
    );
  }
}
