// MCP operation allow-list for the public/catalog registry.
//
// This is the operation registry for the two public-data servers this repo
// serves: cuassistant-public (8766, Clemson class-schedule) and
// cuassistant-catalog (8767, GC catalog). The credentialed registry (mail,
// calendar, tasks, Sheets/Docs) moved to the mailcal repo with the 8765
// server; it is not present here.
//
// Tools in src/mcp-tools/ assert against this list before any backend call.
// An operation that has no entry here cannot be invoked. Adding a tool that
// reaches an external backend or any other side-effect surface requires both:
//   1. an entry in MCP_ALLOWED_OPERATIONS for the right backend tier, and
//   2. a policyActionId mapped to policy/action-policy.yaml with
//      approval=none, and
//   3. the corresponding tool file in src/mcp-tools/ that calls
//      assertMcpOperation(...) before the backend call.

import { getPolicyAction } from "../policy.js";
import type { PolicyAction } from "../policy.js";

export interface McpOperationSpec {
  /**
   * The backend that fulfills this operation. "external-http" = a public,
   * no-auth third-party HTTP API (e.g. Clemson's Banner Browse Classes).
   * "host-state" = local skill-doc reads, no external call.
   */
  backend: "host-state" | "external-http";
  /** The policy/action-policy.yaml action that gates this operation. */
  policyActionId: string;
}

export const MCP_ALLOWED_OPERATIONS: Record<string, McpOperationSpec> = {
  // --- Host orchestration (CUassistant-only skill docs, no external call) ---
  "host.list_skills": {
    backend: "host-state",
    policyActionId: "host.list_skills",
  },
  "host.get_skill_docs": {
    backend: "host-state",
    policyActionId: "host.get_skill_docs",
  },

  // --- Clemson public class schedule (Banner Browse Classes — no auth) ---
  "clemson.list_terms": {
    backend: "external-http",
    policyActionId: "clemson.list_terms",
  },
  "clemson.search_classes": {
    backend: "external-http",
    policyActionId: "clemson.search_classes",
  },
  "clemson.find_alternatives": {
    backend: "external-http",
    policyActionId: "clemson.find_alternatives",
  },
  "clemson.check_conflicts": {
    backend: "external-http",
    policyActionId: "clemson.check_conflicts",
  },
  "clemson.course_details": {
    backend: "external-http",
    policyActionId: "clemson.course_details",
  },
  // Authoritative section rows by CRN from the term snapshot. Added
  // 2026-08-28 so the advisor's host-side check that a model-proposed CRN is
  // real can run over MCP instead of opening state/clemson/<term>.db directly.
  // CRNs from course+section, for schedule data that carries no CRN (a Clemson
  // Navigator export). Companion to sections_by_crn; same snapshot, different key.
  "clemson.resolve_crns": {
    backend: "external-http",
    policyActionId: "clemson.resolve_crns",
  },
  "clemson.sections_by_crn": {
    backend: "external-http",
    policyActionId: "clemson.sections_by_crn",
  },
  "clemson.find_conflict_free_schedule": {
    backend: "external-http",
    policyActionId: "clemson.find_conflict_free_schedule",
  },
  "clemson.find_requirement_sections": {
    backend: "external-http",
    policyActionId: "clemson.find_requirement_sections",
  },
  "clemson.gc_program_requirements": {
    backend: "external-http",
    policyActionId: "clemson.gc_program_requirements",
  },
  "clemson.schedule_freshness": {
    backend: "external-http",
    policyActionId: "clemson.schedule_freshness",
  },
  "clemson.gc_catalog_years": {
    backend: "external-http",
    policyActionId: "clemson.gc_catalog_years",
  },
  "clemson.gc_program_plan": {
    backend: "external-http",
    policyActionId: "clemson.gc_program_plan",
  },
  "clemson.gc_requirement_rules": {
    backend: "external-http",
    policyActionId: "clemson.gc_requirement_rules",
  },
  "clemson.gc_find_course_in_program": {
    backend: "external-http",
    policyActionId: "clemson.gc_find_course_in_program",
  },
  // The program list and one course's catalog entry. Added 2026-08-28 so the
  // advisor's Program selector and course hover card read them over MCP rather
  // than opening gc_advisor.db across a shared filesystem.
  "clemson.gc_list_programs": {
    backend: "external-http",
    policyActionId: "clemson.gc_list_programs",
  },
  "clemson.gc_get_course": {
    backend: "external-http",
    policyActionId: "clemson.gc_get_course",
  },
  "clemson.gc_gen_ed": {
    backend: "external-http",
    policyActionId: "clemson.gc_gen_ed",
  },
};

export class McpPermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpPermissionDeniedError";
  }
}

export interface McpOperationContext {
  input?: Record<string, unknown>;
}

/**
 * Only two constraints are declared in the pruned policy.yaml:
 * "public_data_only" (Clemson external reads) and "local_state_only" (host
 * skill-doc reads). Both are unconditional passes — there is no per-request
 * input to check for a read-only, no-auth public data surface. The
 * mail/calendar/task/Sheets/Docs constraint validators (destination
 * allow-lists, owned-file checks, shared-calendar rejection, etc.) moved to
 * mailcal with the operations they gated.
 */
function validateConstraint(
  constraint: string,
  _input: Record<string, unknown>,
): string | null {
  switch (constraint) {
    case "public_data_only":
    case "local_state_only":
      return null;
    default:
      return `no validator for policy constraint "${constraint}"`;
  }
}

function assertPolicyConstraints(
  operation: string,
  action: PolicyAction,
  context: McpOperationContext,
): void {
  const input = context.input ?? {};
  for (const constraint of action.constraints ?? []) {
    const failure = validateConstraint(constraint, input);
    if (failure) {
      throw new McpPermissionDeniedError(
        `MCP operation "${operation}" violates policy constraint ` +
          `"${constraint}": ${failure}.`,
      );
    }
  }
}

/**
 * Assert that an MCP operation is in the allow-list and its policy action is
 * exposed (approval: none). Throws McpPermissionDeniedError otherwise.
 *
 * Every tool calls this before any backend exec/fetch.
 */
export function assertMcpOperation(
  operation: string,
  context: McpOperationContext = {},
): McpOperationSpec {
  const spec = MCP_ALLOWED_OPERATIONS[operation];
  if (!spec) {
    throw new McpPermissionDeniedError(
      `MCP operation "${operation}" is not in the allow-list. ` +
        `Edit src/mcp-tools/permissions.ts to add it.`,
    );
  }
  const policyAction = getPolicyAction(spec.policyActionId);
  if (!policyAction) {
    throw new McpPermissionDeniedError(
      `MCP operation "${operation}" maps to missing policy action ` +
        `"${spec.policyActionId}". Add it to policy/action-policy.yaml.`,
    );
  }
  if (policyAction.approval !== "none") {
    throw new McpPermissionDeniedError(
      `MCP operation "${operation}" is blocked by policy action ` +
        `"${spec.policyActionId}" (approval=${policyAction.approval}).`,
    );
  }
  assertPolicyConstraints(operation, policyAction, context);
  return spec;
}

export function isMcpOperationExposed(operation: string): boolean {
  const spec = MCP_ALLOWED_OPERATIONS[operation];
  if (!spec) return false;
  const policyAction = getPolicyAction(spec.policyActionId);
  return policyAction?.approval === "none";
}

/**
 * Capability scope vocabulary. Each token maps to the MCP_ALLOWED_OPERATIONS
 * keys it grants. Only EXPOSED operations are reachable; this map never
 * widens beyond the exposed set (enforced by expandScopes). `clemson` and
 * `host` are the only scopes this repo declares — the mail/calendar/tasks/
 * sheets/docs scopes moved to mailcal with the operations they gated. `host`
 * stayed behind because the skill-doc tools (list-skills/get-skill-docs,
 * host.list_skills/host.get_skill_docs) are still registered here, on both
 * the public and catalog barrels — see test/mcp-registry-consistency.test.ts,
 * which fails if this map ever again omits an operation that
 * MCP_ALLOWED_OPERATIONS declares.
 */
// SCOPE VOCABULARY.
//
// `clemson` grants everything and is kept for compatibility with any token
// already carrying it. The two narrower tokens below exist because scoping was
// all-or-nothing until 2026-08-28: an agent that only needed class times had to
// be granted the degree catalog as well. They map to the
// two servers, which is the boundary consumers actually reason about — a
// schedule-only agent takes `clemson.schedule` and is structurally unable to
// call a catalog tool, on either server.
//
// Adding an operation to a tool WITHOUT adding it to one of these lists makes
// it reachable only by an unscoped (full-access) token;
// test/mcp-registry-consistency.test.ts fails on any operation missing from the
// union, so the omission is loud rather than silent.
const CLEMSON_SCHEDULE_OPS = [
  "clemson.list_terms",
  "clemson.search_classes",
  "clemson.find_alternatives",
  "clemson.check_conflicts",
  "clemson.course_details",
  "clemson.find_conflict_free_schedule",
  "clemson.sections_by_crn",
  "clemson.resolve_crns",
  "clemson.schedule_freshness",
];

const CLEMSON_CATALOG_OPS = [
  "clemson.gc_catalog_years",
  "clemson.gc_program_plan",
  "clemson.gc_requirement_rules",
  "clemson.gc_find_course_in_program",
  "clemson.gc_list_programs",
  "clemson.gc_get_course",
  "clemson.gc_gen_ed",
  "clemson.find_requirement_sections",
  "clemson.gc_program_requirements",
];

export const SCOPE_OPERATIONS: Record<string, string[]> = {
  host: ["host.list_skills", "host.get_skill_docs"],
  "clemson.schedule": CLEMSON_SCHEDULE_OPS,
  "clemson.catalog": CLEMSON_CATALOG_OPS,
  clemson: [
    "clemson.list_terms",
    "clemson.search_classes",
    "clemson.find_alternatives",
    "clemson.check_conflicts",
    "clemson.course_details",
    "clemson.find_conflict_free_schedule",
    "clemson.sections_by_crn",
    "clemson.resolve_crns",
    "clemson.gc_catalog_years",
    "clemson.gc_program_plan",
    "clemson.gc_requirement_rules",
    "clemson.gc_find_course_in_program",
    "clemson.gc_list_programs",
    "clemson.gc_get_course",
    "clemson.gc_gen_ed",
    "clemson.find_requirement_sections",
    "clemson.gc_program_requirements",
    "clemson.schedule_freshness",
  ],
};

/** Whether `token` is a recognized scope token. */
export function isValidScopeToken(token: string): boolean {
  return Object.prototype.hasOwnProperty.call(SCOPE_OPERATIONS, token);
}

/** The set of all currently-exposed operation keys (the implicit full scope). */
export function allExposedOperations(): Set<string> {
  return new Set(
    Object.keys(MCP_ALLOWED_OPERATIONS).filter(isMcpOperationExposed),
  );
}

/**
 * Expand scope tokens to the operation keys they grant, intersected with the
 * exposed set. Undefined/empty tokens => full exposed set (default-allow).
 * Unknown tokens contribute nothing (the CLI rejects them at pair time).
 */
export function expandScopes(tokens: string[] | undefined): Set<string> {
  if (!tokens || tokens.length === 0) return allExposedOperations();
  const exposed = allExposedOperations();
  const out = new Set<string>();
  for (const token of tokens) {
    for (const op of SCOPE_OPERATIONS[token] ?? []) {
      if (exposed.has(op)) out.add(op);
    }
  }
  return out;
}
