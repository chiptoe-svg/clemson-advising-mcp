// Public GC curriculum tools — in-process reads over the built catalog
// database (see src/gc-curriculum.ts, src/catalog-read.ts). Read-only, public
// catalog data, no credentials.
import Database from "better-sqlite3";

import {
  getGcProgramPlan,
  listGcCatalogYears,
  getGcRequirementRules,
  getGcGenEd,
} from "../gc-curriculum.js";
import { CATALOG_DB } from "../config-mcp.js";
import {
  getCourseEntry,
  listProgramOptions,
  normalizeCourseCode,
} from "../catalog-read.js";
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
    name: "list-catalog-years",
    description:
      "Do NOT call this if a catalog year, term, or the student's plan is " +
      "already given; call the operation directly. Only for discovering a " +
      "valid catalog year when none is known. Read-only, no login.",
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
    name: "get-program-plan",
    description:
      "Get the full semester-by-semester degree plan for a Clemson program " +
      "in a given catalog year: required courses, choice sets (one-of), " +
      "requirement slots, per-term and total credits, and footnotes. " +
      "This is the bulk of the degree, but NOT all of it — the named " +
      "requirement slots (lab science, specialty area, technical, REACH) " +
      "carry their own rules in get-requirement-rules. To check whether " +
      "one specific course or subject is required, prefer " +
      "find-course-in-program, which searches both. " +
      "Read-only, no login. Takes program + catalog_year; get a valid year " +
      "from list-catalog-years. There is no default program.",
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
    if (!year) return err("catalog_year is required (see list-catalog-years)");
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
    name: "get-requirement-rules",
    description:
      "Get the NAMED requirement slots for a degree program in a given " +
      "catalog year: lab science, specialty area (minor or 15-credit course " +
      "set), technical requirement, REACH — with explicit course codes, " +
      "total credits, and raw footnote text. Read-only, no login. " +
      "IMPORTANT — this is only PART of a program's obligations: most " +
      "required courses live in the semester-by-semester plan " +
      "(get-program-plan), not here. A course absent from this response " +
      "is NOT absent from the degree; to answer whether a program requires " +
      "a given course or subject, use find-course-in-program, which searches " +
      "both stores. Does not include General Education (use get-gen-ed). " +
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
    if (!year) return err("catalog_year is required (see list-catalog-years)");
    try {
      const rules = await getGcRequirementRules(year, program);
      // `rules` is an ARRAY. Spreading it produced index-keyed properties —
      // {"0":{…},"1":{…},"program":…} — which was merely ugly while results
      // were text-only, but became actively harmful when okJson started
      // promoting the payload to typed `structuredContent` (2026-08-27): a
      // model is now handed that shape as structure. okJson's own contract says
      // list-shaped results belong under `items`. Found by adversarial review.
      return okJson({
        items: rules as unknown[],
        program,
        catalog_year: year,
        _source: `Clemson University Online Catalog, ${year} edition (gc_advisor)`,
      });
    } catch (e) {
      return err(
        `GC requirement rules lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

export const genEd: McpToolDefinition = {
  operation: "clemson.gc_gen_ed",
  category: "curriculum-extras",
  tool: {
    name: "get-gen-ed",
    description:
      "Get Clemson's General Education requirements for a given catalog year: " +
      "6 categories (Communication, Mathematics, Natural Sciences with Lab, " +
      "Arts and Humanities, Social Sciences, Global Challenges) with minimum " +
      "credits, allowed course lists, constraint rules, and student learning outcomes. " +
      "Read-only, no login. For major-specific requirements (lab science, " +
      "specialty area, technical) use get-requirement-rules instead. " +
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
    if (!year) return err("catalog_year is required (see list-catalog-years)");
    try {
      const cats = await getGcGenEd(year);
      // Same array-spread bug as get-requirement-rules; see the note there.
      return okJson({
        items: cats as unknown[],
        program: resolveProgramArg(args),
        catalog_year: year,
        _source: `Clemson University Online Catalog, ${year} edition (gc_advisor)`,
      });
    } catch (e) {
      return err(
        `GC gen-ed lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

/**
 * WHY THIS TOOL EXISTS (2026-08-27): a live advisor asked "what is the PCID
 * requirement for GC students" and the advisor answered that no such
 * requirement exists. It was wrong. The catalog splits a program's obligations
 * across TWO stores — `requirement_rule` (the named narrative slots, served by
 * get-requirement-rules) and `plan_item` (the semester-by-semester plan,
 * served by get-program-plan) — and PCID lives only in the second, as a
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
      'subject prefix (e.g. "what is the PCID requirement", "do GC ' +
      'students take STAT 3090"): it is the only tool that covers both ' +
      "stores, so a not-found here is meaningful, whereas a not-found in " +
      "get-requirement-rules or get-program-plan alone is NOT — each " +
      'sees only half the program. Accepts a full code ("PCID 3040") or a ' +
      'bare subject ("PCID", which matches every course with that prefix). ' +
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
        catalog_year: {
          type: "string",
          description: CATALOG_YEAR_ARG_DESCRIPTION,
        },
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
        query: {
          type: "string",
          description:
            "The normalised course code or subject prefix that was searched.",
        },
        matched_as: {
          type: "string",
          enum: ["course_code", "subject_prefix"],
          description:
            "Whether the query resolved to one course or a whole subject prefix.",
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
              where: {
                type: "string",
                description: "The plan group, e.g. 'Junior/Second Semester'.",
              },
              kind: {
                type: "string",
                description: "'fixed_course' or 'choice'.",
              },
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
          description:
            "Named requirement slots whose rule text mentions the query.",
          items: {
            type: "object",
            properties: {
              slot_type: { type: "string" },
              rule: { type: "string" },
            },
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

    const raw =
      typeof (args as { course?: unknown }).course === "string"
        ? (args as { course: string }).course
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
      db = new Database(CATALOG_DB, { readonly: true });
    } catch {
      return err(
        "Could not open the Clemson catalog database (catalog.db). It may not be loaded yet.",
      );
    }
    try {
      // Resolve the year here rather than requiring it: the caller may not know
      // which years this program has, and the failure mode this tool exists to
      // fix is "gave up too early".
      const explicitYear = resolveCatalogYearArg(args);
      const year =
        explicitYear ??
        (
          db
            .prepare(
              `SELECT cy.label AS label FROM program p
               JOIN catalog_year cy ON cy.id = p.catalog_year_id
              WHERE p.name = ? ORDER BY cy.label DESC LIMIT 1`,
            )
            .get(program) as { label?: string } | undefined
        )?.label;
      if (!year)
        return err(
          `No catalog years found for "${program}" (see list-catalog-years).`,
        );

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
        group_label: string;
        kind: string;
        course_code: string | null;
        one_of: string | null;
        slot_type: string | null;
        credits: number | null;
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
        .all(program, year, `%${withSpace}%`) as Array<{
        slot_type: string;
        rule: string;
      }>;

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
      return err(
        `Course lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
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

/**
 * The program + catalog-year list, as a tool.
 *
 * WHY IT EXISTS (2026-08-28): the advisor's own Program and Catalog-year
 * selectors were reading this straight off catalog.db with better-sqlite3,
 * which is fine while the servers and the advisor share a filesystem and is
 * exactly what stops being true when these servers move to their own box. This
 * is the MCP replacement for advisor-catalog.ts's listPrograms().
 *
 * It is also genuinely useful to a model: "which programs can you advise on"
 * previously had no answer except an error message from another tool, which
 * listed known programs only once you had already guessed wrong.
 */
export const listPrograms: McpToolDefinition = {
  operation: "clemson.gc_list_programs",
  category: "curriculum-extras",
  tool: {
    name: "list-programs",
    description:
      "List every program this catalog can advise on, with the catalog years " +
      "each one exists in. Use it to discover valid values for the `program` " +
      'argument other tools take, or to answer "which programs do you ' +
      'cover". Majors with a semester-by-semester plan, plus Pre-Business; ' +
      "minors and certificates are NOT here — look those up by name with " +
      "get-program-requirements. Read-only, no login.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        catalog_years: {
          type: "array",
          items: { type: "string" },
          description: "Every catalog year in the database, newest first.",
        },
        programs: {
          type: "array",
          description: "Programs a conversation can be about, by name.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  'Exact registrar name, e.g. "Accounting, BS". Every name contains a comma.',
              },
              years: {
                type: "array",
                items: { type: "string" },
                description:
                  "Catalog years this program exists in, newest first.",
              },
            },
            required: ["name", "years"],
          },
        },
      },
      required: ["catalog_years", "programs"],
    },
  },
  async handler() {
    try {
      assertMcpOperation("clemson.gc_list_programs");
    } catch (e) {
      return permissionErr(e);
    }
    let db: InstanceType<typeof Database>;
    try {
      db = new Database(CATALOG_DB, { readonly: true });
    } catch {
      // NOT an empty list. "I could not open the catalog" and "this catalog has
      // no programs" are different facts, and the caller — a model, or the
      // advisor's selector — cannot tell them apart from an empty array.
      return err(
        "Could not open the Clemson catalog database (catalog.db). It may not be loaded yet. This is NOT the same as there being no programs.",
      );
    }
    try {
      const { catalogYears, programs } = listProgramOptions(db);
      return okJson({
        catalog_years: catalogYears,
        programs,
        _source: "Clemson University Online Catalog (gc_advisor)",
      });
    } catch (e) {
      return err(
        `GC program list unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      db.close();
    }
  },
};

/**
 * One course's catalog entry by exact code.
 *
 * Distinct from find-course-in-program, which searches WITHIN one program, and
 * from the schedule server's get-course-details, which returns Banner section
 * data (times, seats, instructor) rather than the catalog entry.
 *
 * `found: false` means this catalog has no such course. A database that cannot
 * be opened is an ERROR, never `found: false` — the advisor's hover card
 * previously collapsed both into "no catalog entry", so a catalog that had not
 * finished loading rendered as every course simultaneously ceasing to exist.
 */
export const getCourse: McpToolDefinition = {
  operation: "clemson.gc_get_course",
  category: "curriculum-extras",
  tool: {
    name: "get-course",
    description:
      "Look up ONE course's catalog entry — title, credits, and catalog " +
      'description — by its exact code ("GC 4061", case- and ' +
      "spacing-insensitive). This is the CATALOG entry, not a class section: " +
      "for meeting times, seats, or instructor use the schedule server's " +
      "get-course-details. To find where a course appears in a program's " +
      "requirements, use find-course-in-program. Read-only, no login.",
    inputSchema: {
      type: "object" as const,
      properties: {
        course: {
          type: "string",
          description: 'A course code, e.g. "GC 4061" or "gc4061".',
        },
      },
      required: ["course"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        code: {
          type: "string",
          description: "The normalised code that was looked up.",
        },
        found: {
          type: "boolean",
          description:
            "True if this catalog has an entry for the course. FALSE IS AUTHORITATIVE — " +
            "the catalog was read and has no such course. A catalog that could not be " +
            "read returns an ERROR instead, never false.",
        },
        title: { type: ["string", "null"] },
        credits: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
      },
      required: ["code", "found"],
    },
  },
  async handler(args: Record<string, unknown>) {
    try {
      assertMcpOperation("clemson.gc_get_course");
    } catch (e) {
      return permissionErr(e);
    }
    const raw = typeof args.course === "string" ? args.course : "";
    const code = normalizeCourseCode(raw);
    if (!code) {
      return err(
        `"${raw}" is not a course code. Expected a form like "GC 4061".`,
      );
    }
    let db: InstanceType<typeof Database>;
    try {
      db = new Database(CATALOG_DB, { readonly: true });
    } catch {
      return err(
        "Could not open the Clemson catalog database (catalog.db). It may not be loaded yet. This is NOT the same as the course not existing.",
      );
    }
    try {
      const row = getCourseEntry(db, code);
      return okJson(
        row
          ? {
              code,
              found: true,
              title: row.title,
              credits: row.credits,
              description: row.description,
              _source: "Clemson University Online Catalog (gc_advisor)",
            }
          : {
              code,
              found: false,
              title: null,
              credits: null,
              description: null,
              _source: "Clemson University Online Catalog (gc_advisor)",
            },
      );
    } catch (e) {
      return err(
        `GC course lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      db.close();
    }
  },
};

registerTools([
  catalogYears,
  programPlan,
  requirementRules,
  genEd,
  findCourseInProgram,
  listPrograms,
  getCourse,
]);
