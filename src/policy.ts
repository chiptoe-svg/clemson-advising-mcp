import fs from "fs";
import path from "path";

import YAML from "yaml";

export type PolicyApproval = "none" | "human_required";

export interface PolicyAction {
  id: string;
  surface: string;
  risk: string;
  reversibility: string;
  approval: PolicyApproval;
  constraints?: string[];
}

/**
 * A model-backend provider that a consuming agent may attest to. `authorized`
 * is the operator's attestation (recorded, not proven) that Clemson's agreement
 * covers it.
 */
/** Data sensitivity classes a backend may be authorized for. */
export type DataClass = "public" | "student";

export interface AgentBackend {
  provider: string;
  scope: "external" | "local";
  basis: string;
  authorized: boolean;
  /**
   * Restricts this backend to specific data classes. ABSENT = unrestricted
   * (authorized wherever `authorized` is true) — that is the shape every
   * pre-2026-08-26 entry has, so omitting it preserves existing behaviour.
   *
   * When PRESENT, a caller that does not declare its own data class is
   * REJECTED: an undeclared surface cannot be shown to be one of the classes
   * this entry allows, and a restricted backend must fail closed rather than
   * inherit unrestricted access from a caller that forgot to say what it
   * serves.
   */
  data_classes?: DataClass[];
}

export interface DataEgress {
  agent_backends: AgentBackend[];
}

export interface ActionPolicy {
  policy_version: number;
  policy_name: string;
  actions: PolicyAction[];
  data_egress?: DataEgress;
}

const DEFAULT_POLICY: ActionPolicy = {
  policy_version: 0,
  policy_name: "missing_policy",
  actions: [],
};

/**
 * Whether `provider` is an authorized agent backend in the given list.
 * FAIL CLOSED: an unknown or unset provider is not authorized.
 */
export function agentBackendAuthorizedIn(
  backends: AgentBackend[],
  provider: string,
  dataClass?: DataClass,
): boolean {
  const entry = backends.find((b) => b.provider === provider);
  if (entry?.authorized !== true) return false;
  // ONLY an absent data_classes field means unrestricted. An EMPTY array does
  // not — it is what a malformed entry degrades to, and treating it as
  // unrestricted turned a one-character typo ("Public", "publik", or the YAML
  // scalar form) into a silent grant of student-data access to a backend scoped
  // to public. Found by adversarial review 2026-08-27; the comment here
  // previously claimed the opposite of what the code did.
  if (entry.data_classes === undefined) return true;
  if (entry.data_classes.length === 0) return false;
  // Restricted entry: the caller must declare a class, and it must be listed.
  if (!dataClass) return false;
  return entry.data_classes.includes(dataClass);
}

function loadPolicyFile(): ActionPolicy {
  const policyDir = path.resolve(
    process.env.POLICY_DIR || path.join(process.cwd(), "policy"),
  );
  const p = path.join(policyDir, "action-policy.yaml");
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = YAML.parse(raw) as Partial<ActionPolicy> | null;
    return {
      policy_version: Number(parsed?.policy_version || 0),
      policy_name: String(parsed?.policy_name || "unnamed_policy"),
      actions: Array.isArray(parsed?.actions)
        ? parsed.actions.filter((action): action is PolicyAction =>
            Boolean(action && typeof action.id === "string"),
          )
        : [],
      data_egress: parseDataEgress(parsed?.data_egress),
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

function parseDataEgress(raw: unknown): DataEgress | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const backendsRaw = (raw as { agent_backends?: unknown[] }).agent_backends;
  const agent_backends = Array.isArray(backendsRaw)
    ? backendsRaw
        .filter(
          (b): b is Partial<AgentBackend> =>
            Boolean(b) && typeof (b as AgentBackend).provider === "string",
        )
        .map((b) => ({
          provider: String(b.provider),
          scope:
            b.scope === "local" ? ("local" as const) : ("external" as const),
          basis: typeof b.basis === "string" ? b.basis : "",
          authorized: b.authorized === true,
          // An unrecognised class is REFUSED, not dropped. Dropping it left an
          // empty array, which the checker read as unrestricted — so a typo
          // widened access instead of narrowing it. Now a malformed entry
          // becomes an empty array that DENIES (see agentBackendAuthorizedIn),
          // and a non-array value is likewise treated as a restriction that
          // matches nothing rather than as an absent field.
          ...(b.data_classes !== undefined
            ? {
                data_classes: Array.isArray(b.data_classes)
                  ? b.data_classes.every(
                      (c) => c === "public" || c === "student",
                    )
                    ? (b.data_classes as DataClass[])
                    : [] // any unrecognised member poisons the whole list -> deny
                  : [], // a scalar or object where an array belongs -> deny
              }
            : {}),
        }))
    : [];
  if (agent_backends.length === 0) return undefined;
  return { agent_backends };
}

const ACTION_POLICY = loadPolicyFile();
const ACTION_INDEX = new Map(
  ACTION_POLICY.actions.map((action) => [action.id, action] as const),
);

export function getActionPolicy(): ActionPolicy {
  return ACTION_POLICY;
}

export function getPolicyAction(actionId: string): PolicyAction | undefined {
  return ACTION_INDEX.get(actionId);
}

/** Whether `provider` is an authorized agent backend per policy. Fail closed. */
export function isAgentBackendAuthorized(
  provider: string,
  dataClass?: DataClass,
): boolean {
  return agentBackendAuthorizedIn(
    ACTION_POLICY.data_egress?.agent_backends ?? [],
    provider,
    dataClass,
  );
}

/** The full declared agent-backend list (for tooling/inspection). */
export function getAgentBackends(): AgentBackend[] {
  return ACTION_POLICY.data_egress?.agent_backends ?? [];
}
