// The departmental layer's tools — gated by the clemson.department scope, so a
// consumer that should see only the official published catalog (a
// student-facing agent, say) never learns these exist: scope filtering hides
// them from tools/list and refuses tools/call. An unscoped consumer (the
// advisor) gets them with everything else.
//
// Provenance is the point: everything here is a decision RECORDED BY A
// DEPARTMENT — faculty votes, standard lists, policy prose — not the published
// catalog. Every response says so in _source.
import {
  getDepartmentDoc,
  getDepartmentRules,
  listDepartments,
} from "../departments.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const SOURCE =
  "departmental decision — recorded by the department, not published catalog data";

const departmentRules: McpToolDefinition = {
  operation: "clemson.department_rules",
  category: "curriculum-extras",
  tool: {
    name: "get-department-rules",
    description:
      "A department's RECORDED DECISIONS about requirement slots: " +
      "faculty-approved course additions (and denials) for slots like the " +
      "Specialty Area — provenance is the department, NOT the published " +
      "catalog, which is why this is a separate tool from " +
      "get-gc-requirement-rules. A known department with nothing recorded " +
      "says so explicitly. Feed the returned codes to " +
      "find-requirement-sections via extra_courses to include them in a " +
      "section search. Omit `department` to list the known departments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        department: {
          type: "string",
          description:
            'Department id, e.g. "gc". Omit to get the list of known ids.',
        },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.department_rules");
    } catch (e) {
      return permissionErr(e);
    }
    const id =
      typeof args.department === "string" ? args.department.trim() : "";
    if (!id) {
      return okJson({ departments: listDepartments(), _source: SOURCE });
    }
    let rules;
    try {
      rules = getDepartmentRules(id);
    } catch (e) {
      // Unreadable is an ERROR, never "no rules recorded".
      return err(e instanceof Error ? e.message : String(e));
    }
    if (!rules) {
      return err(
        `Unknown department "${id}". Known departments: ${listDepartments().join(", ")}.`,
      );
    }
    return okJson({
      department: rules.id,
      department_name: rules.department,
      programs: rules.programs,
      slots: rules.slots,
      ...(rules.slots.length === 0
        ? {
            note:
              "This department has recorded no slot decisions yet. That is a " +
              "statement about the record, not proof no departmental rules " +
              "exist — direct unanswered policy questions to the department.",
          }
        : {}),
      _source: SOURCE,
    });
  },
};

const departmentDocs: McpToolDefinition = {
  operation: "clemson.department_docs",
  category: "curriculum-extras",
  tool: {
    name: "get-department-doc",
    description:
      "A department's advising-policy DOCUMENT (internships, approval " +
      "workflows, scheduling lore) — departmental provenance, separate from " +
      "the served catalog-usage and advising-method skills. Thin documents " +
      "say so explicitly. Omit `department` to list the known departments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        department: {
          type: "string",
          description: 'Department id, e.g. "gc". Omit for the list.',
        },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.department_docs");
    } catch (e) {
      return permissionErr(e);
    }
    const id =
      typeof args.department === "string" ? args.department.trim() : "";
    if (!id) {
      return okJson({ departments: listDepartments(), _source: SOURCE });
    }
    let doc;
    try {
      doc = getDepartmentDoc(id);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
    if (!doc) {
      return err(
        `Unknown department "${id}". Known departments: ${listDepartments().join(", ")}.`,
      );
    }
    return okJson({
      department: doc.id,
      content: doc.content,
      _source: SOURCE,
    });
  },
};

/** Test-only handles, so tests drive handlers without a server. */
export const __deptTools = { departmentRules, departmentDocs };

registerTools([departmentRules, departmentDocs]);
