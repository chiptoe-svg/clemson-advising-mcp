// The departmental layer — decisions RECORDED BY DEPARTMENTS, deliberately
// separate from the published catalog (docs/security.md). The store is the
// files under departments/<id>/: rules.yaml (slot allow/deny decisions) and
// SKILL.md (the department's advising-policy document). Files are the source
// of truth and are read per request with an mtime cache, so an edit serves on
// the next call — no build step, no restart.
//
// Nothing in catalog.db references this layer, and the catalog tools never
// read it: that separation is what keeps the catalog server a faithful mirror
// of the published catalog, and what makes this layer extractable later (to a
// department-run service) by re-pointing consumers rather than rewriting.
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

export interface DepartmentRules {
  id: string;
  department: string | null;
  programs: string[];
  faculty: DepartmentFacultyMember[];
  slots: DepartmentSlot[];
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
  return {
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
    return { id, content: fs.readFileSync(p, "utf-8") };
  } catch (err) {
    throw new Error(
      `department document unreadable for "${id}": ${String(err)}`,
    );
  }
}
