// src/course-groups.ts
// Course groups (2026-10-28): the courses students take in the same
// semester, which a schedule must keep compatible. Generated from the
// catalog's semester-by-semester plan, so they exist for every program and
// follow catalog changes; a corequisite lab joins its course's group.
//
// Saved groups override generated ones by name, and add department-known
// sets the plan doesn't name. They are a hand-edited file, like
// state/offering-decisions.yaml, never written by a tool:
//
//   # state/course-groups.yaml
//   groups:
//     - name: "GC lab block"
//       courses: ["GC 4061", "GC 4401"]
//     - name: "Graphic Communications, BS — Junior/First Semester"
//       courses: ["GC 3400", "GC 4060", ["PSYC 2010", "SOC 2010"]]
//
// A list inside `courses` is one need any of its courses satisfies. An
// ABSENT file means nothing saved; an UNREADABLE one is an error, never
// silently ignored.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { displayCourse, type CourseGroup } from "./admin-schedule.js";
import type { ProgramPlan } from "./catalog-read.js";
import { STATE_DIR } from "./config-mcp.js";
import { getGcProgramPlan, listGcCatalogYears } from "./gc-curriculum.js";
import { findCoreqs } from "./mcp-tools/gc-coreqs.js";

const SAVED_PATH = () =>
  process.env.COURSE_GROUPS || path.join(STATE_DIR, "course-groups.yaml");

export function groupsFromPlan(
  plan: ProgramPlan,
  coreqs: (code: string) => string[],
): CourseGroup[] {
  return plan.groups
    .filter((g) => g.kind === "term")
    .map((g) => {
      const needs: string[][] = [];
      const unresolved: string[] = [];
      for (const it of g.items) {
        if (it.course_code) needs.push([displayCourse(it.course_code)]);
        else if (it.one_of.length > 0) needs.push(it.one_of.map(displayCourse));
        else if (it.slot_type) unresolved.push(it.slot_type);
      }
      const have = new Set(needs.flat());
      for (const need of [...needs])
        if (need.length === 1)
          for (const lab of coreqs(need[0]!).map(displayCourse))
            if (!have.has(lab)) {
              needs.push([lab]);
              have.add(lab);
            }
      return {
        name: `${plan.name} — ${g.label}`,
        needs,
        unresolved,
        source: "generated" as const,
      };
    });
}

export function loadSavedGroups(): CourseGroup[] {
  const p = SAVED_PATH();
  if (!fs.existsSync(p)) return [];
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    throw new Error(`course groups unreadable (${p}): ${String(err)}`);
  }
  const raw = (parsed as { groups?: unknown })?.groups;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new Error(`course groups malformed (${p}): 'groups' must be a list`);
  return raw.map((g, i) => {
    const rec = (g ?? {}) as Record<string, unknown>;
    if (typeof rec.name !== "string" || !Array.isArray(rec.courses))
      throw new Error(
        `course groups malformed (${p}): entry ${i + 1} needs a name and a courses list`,
      );
    return {
      name: rec.name,
      needs: rec.courses.map((c) =>
        (Array.isArray(c) ? c : [c]).map((x) => displayCourse(String(x))),
      ),
      unresolved: [],
      source: "saved" as const,
    };
  });
}

/** Saved groups replace generated ones of the same name, and add the rest. */
export function mergeGroups(
  generated: readonly CourseGroup[],
  saved: readonly CourseGroup[],
): CourseGroup[] {
  const byName = new Map(saved.map((g) => [g.name, g]));
  const out = generated.map((g) => byName.get(g.name) ?? g);
  const used = new Set(out.map((g) => g.name));
  return [...out, ...saved.filter((g) => !used.has(g.name))];
}

/** Every group for a program and catalog year (newest year when omitted). */
export async function listCourseGroups(
  program: string,
  year?: string,
): Promise<{ catalogYear: string; groups: CourseGroup[] }> {
  const catalogYear = year ?? (await listGcCatalogYears())[0];
  if (!catalogYear) throw new Error("the catalog lists no catalog years");
  const plan = (await getGcProgramPlan(catalogYear, program)) as ProgramPlan;
  const generated = groupsFromPlan(plan, (code) =>
    findCoreqs(code).map((c) => c.code),
  );
  return { catalogYear, groups: mergeGroups(generated, loadSavedGroups()) };
}
