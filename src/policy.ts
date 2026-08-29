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

export interface ActionPolicy {
  policy_version: number;
  policy_name: string;
  actions: PolicyAction[];
}

function loadPolicyFile(): ActionPolicy {
  const policyDir = path.resolve(
    process.env.POLICY_DIR || path.join(process.cwd(), "policy"),
  );
  const p = path.join(policyDir, "action-policy.yaml");
  // Fail LOUD. A missing or unparseable policy used to degrade to an empty
  // action list, which is fail-closed — every tool refused — but invisible: the
  // server started, logged an empty tool list, and answered 401 to valid
  // tokens, which the install verifier reads as healthy. An operator who
  // pointed POLICY_DIR at the wrong place got a silent outage. Refusing to
  // start is the same security posture with a message attached.
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (e) {
    throw new Error(
      `cannot read the action policy at ${p}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const parsed = YAML.parse(raw) as Partial<ActionPolicy> | null;
  const actions = Array.isArray(parsed?.actions)
    ? parsed.actions.filter((action): action is PolicyAction =>
        Boolean(action && typeof action.id === "string"),
      )
    : [];
  if (actions.length === 0) {
    throw new Error(
      `the action policy at ${p} declares no actions — every tool would be refused`,
    );
  }
  return {
    policy_version: Number(parsed?.policy_version || 0),
    policy_name: String(parsed?.policy_name || "unnamed_policy"),
    actions,
  };
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
