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

export type McpOperationStatus = "active" | "stub-pending-approval";

export interface McpOperationSpec {
  /**
   * The backend that fulfills this operation. "external-http" = a public,
   * no-auth third-party HTTP API (e.g. Clemson's Banner Browse Classes).
   * "host-state" = local skill-doc reads, no external call.
   */
  backend: "host-state" | "external-http";
  /** The policy/action-policy.yaml action that gates this operation. */
  policyActionId: string;
  /**
   * "active" = wired to a real backend (exposure still depends on the mapped
   *   policy action being approval=none).
   * "stub-pending-approval" = guarded; throws McpStubPendingError. No
   *   operation is a stub today, but the status is retained for future work
   *   that lands a tool ahead of its consent.
   */
  status: McpOperationStatus;
  /** The Graph permission scope that gates activation, when applicable. */
  pendingScope?: string;
}

export const MCP_ALLOWED_OPERATIONS: Record<string, McpOperationSpec> = {
  // --- Host orchestration (CUassistant-only skill docs, no external call) ---
  "host.list_skills": {
    backend: "host-state",
    status: "active",
    policyActionId: "host.list_skills",
  },
  "host.get_skill_docs": {
    backend: "host-state",
    status: "active",
    policyActionId: "host.get_skill_docs",
  },

  // --- Clemson public class schedule (Banner Browse Classes — no auth) ---
  "clemson.list_terms": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.list_terms",
  },
  "clemson.search_classes": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.search_classes",
  },
  "clemson.find_alternatives": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.find_alternatives",
  },
  "clemson.check_conflicts": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.check_conflicts",
  },
  "clemson.course_details": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.course_details",
  },
  "clemson.find_conflict_free_schedule": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.find_conflict_free_schedule",
  },
  "clemson.find_requirement_sections": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.find_requirement_sections",
  },
  "clemson.gc_program_requirements": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.gc_program_requirements",
  },
  "clemson.schedule_freshness": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.schedule_freshness",
  },
  "clemson.gc_catalog_years": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.gc_catalog_years",
  },
  "clemson.gc_program_plan": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.gc_program_plan",
  },
  "clemson.gc_requirement_rules": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.gc_requirement_rules",
  },
  "clemson.gc_gen_ed": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.gc_gen_ed",
  },
  "clemson.gc_audit_progress": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.gc_audit_progress",
  },
};

export class McpPermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpPermissionDeniedError";
  }
}

export class McpStubPendingError extends Error {
  readonly operation: string;
  readonly pendingScope: string;
  constructor(operation: string, pendingScope: string) {
    super(
      `Operation "${operation}" is a stub pending IT approval of ` +
        `Graph permission "${pendingScope}". The operation is wired but the ` +
        `consent has not been granted; the call is refused at the policy ` +
        `boundary. To activate, grant the permission to the Graph CLI ` +
        `client and remove the stub guard in the corresponding tool file.`,
    );
    this.name = "McpStubPendingError";
    this.operation = operation;
    this.pendingScope = pendingScope;
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
 * Assert that an MCP operation is in the allow-list. Stubs throw a structured
 * error identifying the missing permission.
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
  if (spec.status === "stub-pending-approval") {
    throw new McpStubPendingError(operation, spec.pendingScope ?? "(unknown)");
  }
  return spec;
}

export function isMcpOperationExposed(operation: string): boolean {
  const spec = MCP_ALLOWED_OPERATIONS[operation];
  if (!spec || spec.status !== "active") return false;
  const policyAction = getPolicyAction(spec.policyActionId);
  return policyAction?.approval === "none";
}

/** Enumerate the allow-list for the IT-reviewable manifest. */
export function describeMcpOperations(): Array<{
  operation: string;
  backend: McpOperationSpec["backend"];
  status: McpOperationStatus;
  policyActionId: string;
  exposed: boolean;
  pendingScope: string | null;
}> {
  return Object.entries(MCP_ALLOWED_OPERATIONS).map(([operation, spec]) => ({
    operation,
    backend: spec.backend,
    status: spec.status,
    policyActionId: spec.policyActionId,
    exposed: isMcpOperationExposed(operation),
    pendingScope: spec.pendingScope ?? null,
  }));
}

/**
 * Capability scope vocabulary. Each token maps to the MCP_ALLOWED_OPERATIONS
 * keys it grants. Only EXPOSED operations are reachable; this map never
 * widens beyond the exposed set (enforced by expandScopes). `clemson` is the
 * only scope this repo declares — the mail/calendar/tasks/sheets/docs/host
 * scopes moved to mailcal with the operations they gated.
 */
export const SCOPE_OPERATIONS: Record<string, string[]> = {
  clemson: [
    "clemson.list_terms",
    "clemson.search_classes",
    "clemson.find_alternatives",
    "clemson.check_conflicts",
    "clemson.course_details",
    "clemson.find_conflict_free_schedule",
    "clemson.gc_catalog_years",
    "clemson.gc_program_plan",
    "clemson.gc_requirement_rules",
    "clemson.gc_gen_ed",
    "clemson.gc_audit_progress",
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
