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
      "This is the bulk of the degree, but NOT all of it — the named " +
      "requirement slots (lab science, specialty area, technical, REACH) " +
      "carry their own rules in get-gc-requirement-rules. To check whether " +
      "one specific course or subject is required, prefer " +
      "find-course-in-program, which searches both. " +
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
      "Get the NAMED requirement slots for a degree program in a given " +
      "catalog year: lab science, specialty area (minor or 15-credit course " +
      "set), technical requirement, REACH — with explicit course codes, " +
      "total credits, and raw footnote text. Read-only, no login. " +
      "IMPORTANT — this is only PART of a program's obligations: most " +
      "required courses live in the semester-by-semester plan " +
      "(get-gc-program-plan), not here. A course absent from this response " +
      "is NOT absent from the degree; to answer whether a program requires " +
      "a given course or subject, use find-course-in-program, which searches " +
      "both stores. Does not include General Education (use get-gc-gen-ed). " +
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


/**
 * WHY THIS TOOL EXISTS (2026-08-27): a live advisor asked "what is the PCID
 * requirement for GC students" and the advisor answered that no such
 * requirement exists. It was wrong. The catalog splits a program's obligations
 * across TWO stores — `requirement_rule` (the named narrative slots, served by
 * get-gc-requirement-rules) and `plan_item` (the semester-by-semester plan,
 * served by get-gc-program-plan) — and PCID lives only in the second, as a
 * one-of choice. The model called the rules tool, got a successful response
 * that simply did not contain PCID, and inferred absence from one partial
 * source. Nothing signalled the miss, and the turn recorded outcome=complete.
 *
 * The general defect: nothing on the surface could answer "where does this
 * course appear in this program?" without knowing in advance which store holds
 * it. This tool searches BOTH and reports every hit, so a course question is
 * answerable directly instead of inferable.
 */
export const findCourseInProgram: McpToolDefinition = {
  operation: "clemson.gc_find_course_in_program",
  category: "curriculum-extras",
  tool: {
    name: "find-course-in-program",
    description:
      "Find every place a course or subject code appears in one program's " +
      "catalog year — searching BOTH the semester-by-semester plan " +
      "(fixed courses and one-of choice slots) AND the named requirement " +
      "rules. Use this whenever a question names a specific course or " +
      "subject prefix (e.g. \"what is the PCID requirement\", \"do GC " +
      "students take STAT 3090\"): it is the only tool that covers both " +
      "stores, so a not-found here is meaningful, whereas a not-found in " +
      "get-gc-requirement-rules or get-gc-program-plan alone is NOT — each " +
      "sees only half the program. Accepts a full code (\"PCID 3040\") or a " +
      "bare subject (\"PCID\", which matches every course with that prefix). " +
      "Read-only, no login. Takes program + optional catalog_year (defaults " +
      "to the program's newest).",
    inputSchema: {
      type: "object" as const,
      properties: {
        course: {
          type: "string",
          description:
            'A course code ("PCID 3040") or a bare subject prefix ("PCID"). ' +
            "Case- and spacing-insensitive.",
        },
        program: { type: "string", description: PROGRAM_ARG_DESCRIPTION },
        catalog_year: { type: "string", description: CATALOG_YEAR_ARG_DESCRIPTION },
        year: { type: "string", description: YEAR_ALIAS_DESCRIPTION },
      },
      required: ["course"],
      additionalProperties: false,
    },
    // Declaring outputSchema tells the model what it will get BEFORE it calls —
    // which is tool-SELECTION information, and mis-selection is what produced
    // the PCID wrong answer. `found` as a typed boolean is also far harder to
    // misread than the same fact inside a JSON string.
    //
    // An outputSchema is a PROMISE: a response that does not conform is a
    // protocol violation, not merely surprising. test/mcp-output-schema.test.ts
    // holds this handler to it against the live catalog DB.
    outputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The normalised course code or subject prefix that was searched." },
        matched_as: {
          type: "string",
          enum: ["course_code", "subject_prefix"],
          description: "Whether the query resolved to one course or a whole subject prefix.",
        },
        program: { type: "string" },
        catalog_year: { type: "string" },
        found: {
          type: "boolean",
          description:
            "True if the course/subject appears anywhere in this program-year. " +
            "FALSE IS AUTHORITATIVE: both the semester plan and the requirement " +
            "rules were searched, so false means the program does not require it.",
        },
        plan_appearances: {
          type: "array",
          description: "Every appearance in the semester-by-semester plan.",
          items: {
            type: "object",
            properties: {
              where: { type: "string", description: "The plan group, e.g. 'Junior/Second Semester'." },
              kind: { type: "string", description: "'fixed_course' or 'choice'." },
              course: { type: "string" },
              choose_one_of: { type: "array", items: { type: "string" } },
              slot_type: { type: "string" },
              credits: { type: ["number", "null"] },
            },
            required: ["where", "kind"],
          },
        },
        requirement_rule_mentions: {
          type: "array",
          description: "Named requirement slots whose rule text mentions the query.",
          items: {
            type: "object",
            properties: { slot_type: { type: "string" }, rule: { type: "string" } },
            required: ["slot_type", "rule"],
          },
        },
        _source: { type: "string" },
      },
      required: [
        "query",
        "matched_as",
        "program",
        "catalog_year",
        "found",
        "plan_appearances",
        "requirement_rule_mentions",
        "_source",
      ],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_find_course_in_program");
    } catch (e) {
      return permissionErr(e);
    }
    const program = resolveProgramArg(args);
    if (!program) return err(missingProgramMessage());

    const raw = typeof (args as { course?: unknown }).course === "string"
      ? ((args as { course: string }).course)
      : "";
    // Normalise "pcid3040" / "PCID  3040" / " pcid 3040 " to "PCID 3040".
    const cleaned = raw.trim().toUpperCase().replace(/\s+/g, " ");
    const withSpace = cleaned.replace(/^([A-Z]+)\s*(\d.*)$/, "$1 $2");
    if (!/^[A-Z]{2,8}( \d[\w-]*)?$/.test(withSpace)) {
      return err(
        `"${raw}" is not a course code or subject prefix. Expected forms: "PCID 3040" or "PCID".`,
      );
    }
    const subjectOnly = !/\d/.test(withSpace);

    let db: InstanceType<typeof Database>;
    try {
      db = new Database(GC_ADVISOR_DB, { readonly: true });
    } catch {
      return err("Could not open the Clemson catalog database (gc_advisor.db). It may not be loaded yet.");
    }
    try {
      // Resolve the year here rather than requiring it: the caller may not know
      // which years this program has, and the failure mode this tool exists to
      // fix is "gave up too early".
      const explicitYear = resolveCatalogYearArg(args);
      const year =
        explicitYear ??
        (db
          .prepare(
            `SELECT cy.label AS label FROM program p
               JOIN catalog_year cy ON cy.id = p.catalog_year_id
              WHERE p.name = ? ORDER BY cy.label DESC LIMIT 1`,
          )
          .get(program) as { label?: string } | undefined)?.label;
      if (!year) return err(`No catalog years found for "${program}" (see list-gc-catalog-years).`);

      // Match a full code exactly, or any course under a bare subject prefix.
      const exact = subjectOnly ? null : withSpace;
      const likeCode = subjectOnly ? `${withSpace} %` : withSpace;
      // one_of is a JSON array of code strings; substring match is sufficient
      // and avoids depending on the SQLite JSON extension being present.
      const likeOneOf = subjectOnly ? `%"${withSpace} %` : `%"${withSpace}"%`;

      const planRows = db
        .prepare(
          `SELECT rg.label AS group_label, pi.kind, pi.course_code, pi.one_of,
                  pi.slot_type, pi.credits
             FROM plan_item pi
             JOIN requirement_group rg ON rg.id = pi.group_id
             JOIN program p  ON p.id  = rg.program_id
             JOIN catalog_year cy ON cy.id = p.catalog_year_id
            WHERE p.name = ? AND cy.label = ?
              AND ( (? IS NOT NULL AND pi.course_code = ?)
                 OR pi.course_code LIKE ?
                 OR pi.one_of LIKE ? )
            ORDER BY rg.ordering, pi.ordering`,
        )
        .all(program, year, exact, exact, likeCode, likeOneOf) as Array<{
          group_label: string; kind: string; course_code: string | null;
          one_of: string | null; slot_type: string | null; credits: number | null;
        }>;

      // requirement_rule_effective, NEVER the raw table: the view drops rules
      // flagged bogus, which the advisor must not quote as fact.
      const ruleRows = db
        .prepare(
          `SELECT rr.slot_type, rr.rule
             FROM requirement_rule_effective rr
             JOIN program p ON p.id = rr.program_id
             JOIN catalog_year cy ON cy.id = p.catalog_year_id
            WHERE p.name = ? AND cy.label = ? AND rr.rule LIKE ?`,
        )
        .all(program, year, `%${withSpace}%`) as Array<{ slot_type: string; rule: string }>;

      const plan_appearances = planRows.map((r) => ({
        where: r.group_label,
        kind: r.kind,
        ...(r.course_code ? { course: r.course_code } : {}),
        ...(r.one_of ? { choose_one_of: safeJsonArray(r.one_of) } : {}),
        ...(r.slot_type ? { slot_type: r.slot_type } : {}),
        credits: r.credits,
      }));

      return okJson({
        query: withSpace,
        matched_as: subjectOnly ? "subject_prefix" : "course_code",
        program,
        catalog_year: year,
        found: plan_appearances.length > 0 || ruleRows.length > 0,
        plan_appearances,
        requirement_rule_mentions: ruleRows.map((r) => ({
          slot_type: r.slot_type,
          rule: r.rule,
        })),
        _note:
          plan_appearances.length === 0 && ruleRows.length === 0
            ? `"${withSpace}" does not appear in ${program} for ${year}. This search covered BOTH the semester plan and the requirement rules, so this absence is authoritative for this program/year.`
            : undefined,
        _source: `Clemson University Online Catalog, ${year} edition (gc_advisor)`,
      });
    } catch (e) {
      return err(`Course lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      db.close();
    }
  },
};

/** one_of is stored as a JSON array; fall back to the raw string if it ever is not. */
function safeJsonArray(raw: string): string[] | string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : raw;
  } catch {
    return raw;
  }
}

registerTools([catalogYears, programPlan, requirementRules, genEd, auditProgress, findCourseInProgram]);
