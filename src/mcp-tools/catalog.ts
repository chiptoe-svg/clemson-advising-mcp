// Public GC curriculum tools — backed by the gc_advisor project's query.py CLI
// (see src/gc-curriculum.ts). Read-only, public catalog data, no credentials.
import Database from "better-sqlite3";

import { getGcProgramPlan, listGcCatalogYears, getGcRequirementRules, getGcGenEd, auditGcProgress } from "../gc-curriculum.js";
import { GC_ADVISOR_DB } from "../config.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

export { findCoreqs, type CoreqCourse } from "./gc-coreqs.js";

export const catalogYears: McpToolDefinition = {
  operation: "clemson.gc_catalog_years",
  tool: {
    name: "list-gc-catalog-years",
    description:
      "Do NOT call this if a catalog year, term, or the student's plan is " +
      "already given; call the operation directly. Only for discovering a " +
      "valid GC catalog year when none is known. Read-only, no login.",
    inputSchema: { type: "object" as const, properties: {} },
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
  tool: {
    name: "get-gc-program-plan",
    description:
      "Get the full semester-by-semester degree plan for a Clemson program " +
      "in a given catalog year: required courses, choice sets (one-of), " +
      "requirement slots, per-term and total credits, and footnotes. " +
      "Read-only, no login. Defaults to the Graphic Communications, BS. " +
      "Get a valid year from list-gc-catalog-years.",
    inputSchema: {
      type: "object" as const,
      properties: {
        year: {
          type: "string",
          description:
            "Catalog year, e.g. 2026-2027 (from list-gc-catalog-years).",
        },
        name: {
          type: "string",
          description: 'Program name (default "Graphic Communications, BS").',
        },
      },
      required: ["year"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_program_plan");
    } catch (e) {
      return permissionErr(e);
    }
    const year = args.year as string | undefined;
    if (!year) return err("year is required (see list-gc-catalog-years)");
    const name =
      typeof args.name === "string" && args.name
        ? args.name
        : "Graphic Communications, BS";
    try {
      const plan = await getGcProgramPlan(year, name);
      return okJson({
        ...(plan as object),
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
  tool: {
    name: "get-gc-requirement-rules",
    description:
      "Get the requirement rules for the GC Graphic Communications BS degree " +
      "in a given catalog year: lab science, specialty area (minor or 15-credit " +
      "course set), and technical requirement — with explicit course codes, " +
      "total credits, and raw footnote text. Read-only, no login. Does not " +
      "include General Education requirements (use get-gc-gen-ed) or the " +
      "full semester-by-semester course plan (use get-gc-program-plan).",
    inputSchema: {
      type: "object" as const,
      properties: {
        year: {
          type: "string",
          description: "Catalog year, e.g. 2026-2027 (from list-gc-catalog-years).",
        },
      },
      required: ["year"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_requirement_rules");
    } catch (e) {
      return permissionErr(e);
    }
    const year = args.year as string | undefined;
    if (!year) return err("year is required");
    try {
      const rules = await getGcRequirementRules(year, "Graphic Communications, BS");
      return okJson({
        ...(rules as object),
        _source: `Clemson University Online Catalog, ${year} edition (gc_advisor)`,
      });
    } catch (e) {
      return err(`GC requirement rules lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const genEd: McpToolDefinition = {
  operation: "clemson.gc_gen_ed",
  tool: {
    name: "get-gc-gen-ed",
    description:
      "Get Clemson's General Education requirements for a given catalog year: " +
      "6 categories (Communication, Mathematics, Natural Sciences with Lab, " +
      "Arts and Humanities, Social Sciences, Global Challenges) with minimum " +
      "credits, allowed course lists, constraint rules, and student learning outcomes. " +
      "Read-only, no login. For major-specific requirements (lab science, " +
      "specialty area, technical) use get-gc-requirement-rules instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        year: {
          type: "string",
          description: "Catalog year, e.g. 2026-2027 (from list-gc-catalog-years).",
        },
      },
      required: ["year"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_gen_ed");
    } catch (e) {
      return permissionErr(e);
    }
    const year = args.year as string | undefined;
    if (!year) return err("year is required");
    try {
      const cats = await getGcGenEd(year);
      return okJson({
        ...(cats as object),
        _source: `Clemson University Online Catalog, ${year} edition (gc_advisor)`,
      });
    } catch (e) {
      return err(`GC gen-ed lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const auditProgress: McpToolDefinition = {
  operation: "clemson.gc_audit_progress",
  tool: {
    name: "audit-gc-progress",
    description:
      "Run a deterministic GC BS degree audit on a sanitized gc-progress-v1 " +
      "record (passed course codes + terms + credits, in-progress, declared " +
      "minor — NO grades or identity; produced by the GC Advisor clean flow). " +
      "Returns requirements met/remaining, gen-ed progress, credits left, and " +
      "prereq-eligible next courses. Use the results to advise; never compute " +
      "the audit yourself.",
    inputSchema: {
      type: "object" as const,
      properties: {
        progress: {
          type: "object",
          description: "gc-progress-v1 JSON object (from the GC Advisor page's cleaned output).",
        },
      },
      required: ["progress"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_audit_progress");
    } catch (e) {
      return permissionErr(e);
    }
    if (!args.progress || typeof args.progress !== "object")
      return err("progress (gc-progress-v1 object) is required");
    try {
      return okJson(await auditGcProgress(args.progress));
    } catch (e) {
      return err(`GC audit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

registerTools([catalogYears, programPlan, requirementRules, genEd, auditProgress]);
