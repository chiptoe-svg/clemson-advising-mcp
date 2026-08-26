// Public GC curriculum tools — backed by the gc_advisor project's query.py CLI
// (see src/gc-curriculum.ts). Read-only, public catalog data, no credentials.
import Database from "better-sqlite3";

import { getGcProgramPlan, listGcCatalogYears, getGcRequirementRules, getGcGenEd, auditGcProgress } from "../gc-curriculum.js";
import { GC_ADVISOR_DB } from "../config.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";
import {
  CATALOG_YEAR_ARG_DESCRIPTION,
  NAME_ALIAS_DESCRIPTION,
  PROGRAM_ARG_DESCRIPTION,
  YEAR_ALIAS_DESCRIPTION,
  missingProgramMessage,
  resolveCatalogYearArg,
  resolveProgramArg,
} from "./program-args.js";

export { findCoreqs, type CoreqCourse } from "./gc-coreqs.js";

export const catalogYears: McpToolDefinition = {
  operation: "clemson.gc_catalog_years",
  category: "curriculum-extras",
  tool: {
    name: "list-gc-catalog-years",
    description:
      "Do NOT call this if a catalog year, term, or the student's plan is " +
      "already given; call the operation directly. Only for discovering a " +
      "valid GC catalog year when none is known. Read-only, no login.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  async handler() {
    try {
      assertMcpOperation("clemson.gc_catalog_years");
    } catch (e) {
      return permissionErr(e);
    }
    try {
      const years = await listGcCatalogYears();
      return okJson({
        years,
        _source: "Clemson University Online Catalog (gc_advisor)",
      });
    } catch (e) {
      return err(
        `GC catalog years unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

export const programPlan: McpToolDefinition = {
  operation: "clemson.gc_program_plan",
  category: "curriculum-extras",
  tool: {
    name: "get-gc-program-plan",
    description:
      "Get the full semester-by-semester degree plan for a Clemson program " +
      "in a given catalog year: required courses, choice sets (one-of), " +
      "requirement slots, per-term and total credits, and footnotes. " +
      "Read-only, no login. Takes program + catalog_year; get a valid year " +
      "from list-gc-catalog-years. There is no default program.",
    inputSchema: {
      type: "object" as const,
      properties: {
        program: { type: "string", description: PROGRAM_ARG_DESCRIPTION },
        catalog_year: {
          type: "string",
          description: CATALOG_YEAR_ARG_DESCRIPTION,
        },
        name: { type: "string", description: NAME_ALIAS_DESCRIPTION },
        year: { type: "string", description: YEAR_ALIAS_DESCRIPTION },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_program_plan");
    } catch (e) {
      return permissionErr(e);
    }
    const program = resolveProgramArg(args);
    if (!program) return err(missingProgramMessage());
    const year = resolveCatalogYearArg(args);
    if (!year) return err("catalog_year is required (see list-gc-catalog-years)");
    try {
      const plan = await getGcProgramPlan(year, program);
      return okJson({
        ...(plan as object),
        program,
        catalog_year: year,
        _source: `Clemson University Online Catalog, ${year} edition (gc_advisor)`,
      });
    } catch (e) {
      return err(
        `GC program plan lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

export const requirementRules: McpToolDefinition = {
  operation: "clemson.gc_requirement_rules",
  category: "curriculum-extras",
  tool: {
    name: "get-gc-requirement-rules",
    description:
      "Get the requirement rules for a degree program in a given catalog " +
      "year: lab science, specialty area (minor or 15-credit course set), " +
      "and technical requirement — with explicit course codes, total " +
      "credits, and raw footnote text. Read-only, no login. Does not " +
      "include General Education requirements (use get-gc-gen-ed) or the " +
      "full semester-by-semester course plan (use get-gc-program-plan). " +
      "Takes program + catalog_year; there is no default program.",
    inputSchema: {
      type: "object" as const,
      properties: {
        program: { type: "string", description: PROGRAM_ARG_DESCRIPTION },
        catalog_year: {
          type: "string",
          description: CATALOG_YEAR_ARG_DESCRIPTION,
        },
        year: { type: "string", description: YEAR_ALIAS_DESCRIPTION },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_requirement_rules");
    } catch (e) {
      return permissionErr(e);
    }
    const program = resolveProgramArg(args);
    if (!program) return err(missingProgramMessage());
    const year = resolveCatalogYearArg(args);
    if (!year) return err("catalog_year is required (see list-gc-catalog-years)");
    try {
      const rules = await getGcRequirementRules(year, program);
      return okJson({
        ...(rules as object),
        program,
        catalog_year: year,
        _source: `Clemson University Online Catalog, ${year} edition (gc_advisor)`,
      });
    } catch (e) {
      return err(`GC requirement rules lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const genEd: McpToolDefinition = {
  operation: "clemson.gc_gen_ed",
  category: "curriculum-extras",
  tool: {
    name: "get-gc-gen-ed",
    description:
      "Get Clemson's General Education requirements for a given catalog year: " +
      "6 categories (Communication, Mathematics, Natural Sciences with Lab, " +
      "Arts and Humanities, Social Sciences, Global Challenges) with minimum " +
      "credits, allowed course lists, constraint rules, and student learning outcomes. " +
      "Read-only, no login. For major-specific requirements (lab science, " +
      "specialty area, technical) use get-gc-requirement-rules instead. " +
      "General Education is university-wide: `program` is accepted and echoed " +
      "back, but the answer does not vary by program.",
    inputSchema: {
      type: "object" as const,
      properties: {
        catalog_year: {
          type: "string",
          description: CATALOG_YEAR_ARG_DESCRIPTION,
        },
        program: {
          type: "string",
          description:
            "Accepted and echoed for consistency with the other catalog " +
            "tools. General Education does not vary by program, so this does " +
            "not change the result.",
        },
        year: { type: "string", description: YEAR_ALIAS_DESCRIPTION },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_gen_ed");
    } catch (e) {
      return permissionErr(e);
    }
    const year = resolveCatalogYearArg(args);
    if (!year) return err("catalog_year is required (see list-gc-catalog-years)");
    try {
      const cats = await getGcGenEd(year);
      return okJson({
        ...(cats as object),
        program: resolveProgramArg(args),
        catalog_year: year,
        _source: `Clemson University Online Catalog, ${year} edition (gc_advisor)`,
      });
    } catch (e) {
      return err(`GC gen-ed lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const auditProgress: McpToolDefinition = {
  operation: "clemson.gc_audit_progress",
  category: "curriculum-extras",
  tool: {
    name: "audit-gc-progress",
    description:
      "Run a deterministic degree audit (any College of Business program; " +
      "pass `program` and `catalog_year`, either inside the record or as " +
      "top-level arguments) on a sanitized gc-progress-v1 record " +
      "(passed course codes + terms + credits, in-progress, declared minor — " +
      "NO grades or identity; produced by the GC Advisor clean flow). Returns " +
      "requirements met/remaining, gen-ed progress, credits left, and " +
      "prereq-eligible next courses. Use the results to advise; never compute " +
      "the audit yourself. ADVISORY ONLY for programs other than Graphic " +
      "Communications, BS (known allocation defects as of 2026-08-26): present " +
      "those verdicts as tentative and tell the advisor to confirm with " +
      "DegreeWorks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        progress: {
          type: "object",
          description:
            "gc-progress-v1 JSON object (from the GC Advisor page's cleaned " +
            "output). Its `program` / `catalog_year` fields identify the " +
            "degree being audited; the top-level program / catalog_year " +
            "arguments below fill them when the record omits them.",
        },
        program: { type: "string", description: PROGRAM_ARG_DESCRIPTION },
        catalog_year: {
          type: "string",
          description: CATALOG_YEAR_ARG_DESCRIPTION,
        },
      },
      required: ["progress"],
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_audit_progress");
    } catch (e) {
      return permissionErr(e);
    }
    if (!args.progress || typeof args.progress !== "object" || Array.isArray(args.progress))
      return err("progress (gc-progress-v1 object) is required");
    // The record's own program/catalog_year win; the top-level args only fill
    // them in. Read by exact key — a gc-progress-v1 record must never be
    // scanned for `name`, which in a student record means something else.
    const record = args.progress as Record<string, unknown>;
    const fromRecord = (key: string): string | null =>
      typeof record[key] === "string" && (record[key] as string).trim() !== ""
        ? (record[key] as string).trim()
        : null;
    const program = fromRecord("program") ?? resolveProgramArg(args);
    if (!program) return err(missingProgramMessage());
    const catalogYear = fromRecord("catalog_year") ?? resolveCatalogYearArg(args);
    try {
      const audited = await auditGcProgress({
        ...record,
        program,
        ...(catalogYear ? { catalog_year: catalogYear } : {}),
      });
      return okJson({
        ...(audited as object),
        program,
        catalog_year: catalogYear,
      });
    } catch (e) {
      return err(`GC audit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

registerTools([catalogYears, programPlan, requirementRules, genEd, auditProgress]);
