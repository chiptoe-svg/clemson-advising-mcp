import assert from "node:assert/strict";
import test from "node:test";

import {
  agentBackendAuthorizedIn,
  getAgentBackends,
  isAgentBackendAuthorized,
  type AgentBackend,
} from "../src/policy.ts";

const backends: AgentBackend[] = [
  { provider: "chatgpt_edu", scope: "external", basis: "x", authorized: true },
  { provider: "openai_api", scope: "external", basis: "x", authorized: true },
  { provider: "anthropic", scope: "external", basis: "x", authorized: false },
];

test("agentBackendAuthorizedIn: authorized providers are true", () => {
  assert.equal(agentBackendAuthorizedIn(backends, "chatgpt_edu"), true);
  assert.equal(agentBackendAuthorizedIn(backends, "openai_api"), true);
});

test("agentBackendAuthorizedIn: unauthorized provider is false", () => {
  assert.equal(agentBackendAuthorizedIn(backends, "anthropic"), false);
});

test("agentBackendAuthorizedIn: fail closed on unknown/empty provider", () => {
  assert.equal(agentBackendAuthorizedIn(backends, "mistral"), false);
  assert.equal(agentBackendAuthorizedIn(backends, ""), false);
});

test("real policy authorizes chatgpt_edu + openai_api unrestricted", () => {
  assert.equal(isAgentBackendAuthorized("chatgpt_edu"), true);
  assert.equal(isAgentBackendAuthorized("openai_api"), true);
});

// Owner decision 2026-08-26: anthropic is authorized for PUBLIC data surfaces
// only (8766/8767). These four assertions are the whole boundary — if any of
// them inverts, an Anthropic-backed agent has either lost its public access or
// gained access to a student-data surface.
test("real policy scopes anthropic to the public data class", () => {
  assert.equal(isAgentBackendAuthorized("anthropic", "public"), true);
  assert.equal(isAgentBackendAuthorized("anthropic", "student"), false);
});

test("real policy refuses a data-class-restricted backend when the caller declares nothing", () => {
  // Fail closed: an undeclared surface cannot be shown to be public, so a
  // restricted backend must not inherit access from the omission.
  assert.equal(isAgentBackendAuthorized("anthropic"), false);
});

test("real policy leaves unrestricted backends unaffected by a data class", () => {
  assert.equal(isAgentBackendAuthorized("openai_api", "public"), true);
  assert.equal(isAgentBackendAuthorized("openai_api", "student"), true);
});

const scoped: AgentBackend[] = [
  {
    provider: "restricted",
    scope: "external",
    basis: "x",
    authorized: true,
    data_classes: ["public"],
  },
  {
    provider: "unrestricted",
    scope: "external",
    basis: "x",
    authorized: true,
  },
  {
    provider: "denied",
    scope: "external",
    basis: "x",
    authorized: false,
    data_classes: ["public"],
  },
];

test("agentBackendAuthorizedIn: data_classes gates a restricted backend", () => {
  assert.equal(agentBackendAuthorizedIn(scoped, "restricted", "public"), true);
  assert.equal(agentBackendAuthorizedIn(scoped, "restricted", "student"), false);
  assert.equal(agentBackendAuthorizedIn(scoped, "restricted"), false);
});

test("agentBackendAuthorizedIn: absent data_classes means every class", () => {
  assert.equal(agentBackendAuthorizedIn(scoped, "unrestricted"), true);
  assert.equal(agentBackendAuthorizedIn(scoped, "unrestricted", "public"), true);
  assert.equal(agentBackendAuthorizedIn(scoped, "unrestricted", "student"), true);
});

test("agentBackendAuthorizedIn: authorized:false beats a matching data class", () => {
  assert.equal(agentBackendAuthorizedIn(scoped, "denied", "public"), false);
});

test("getAgentBackends exposes the declared backend list including local", () => {
  const providers = getAgentBackends().map((b) => b.provider);
  assert.ok(providers.includes("local"), "expected a local backend");
  assert.equal(
    getAgentBackends().find((b) => b.provider === "local")?.authorized,
    true,
  );
});

// --- fail-CLOSED on malformed data_classes (adversarial review, 2026-08-27) ---
//
// The original implementation dropped unrecognised class strings during parsing
// and then treated an empty array as UNRESTRICTED. A one-character edit —
// "Public", "publik", or the YAML scalar `data_classes: public` — therefore
// converted the scoped anthropic entry into a fully unrestricted one, INCLUDING
// student. The comment above the parser claimed the opposite of what it did, and
// no test caught it because every test used the well-formed value.
//
// These pin the corrected rule: ABSENT means unrestricted; EMPTY means deny.

const malformed: AgentBackend[] = [
  // What a typo/case-error/scalar now parses to.
  { provider: "typo", scope: "external", basis: "x", authorized: true, data_classes: [] },
  // The well-formed control.
  { provider: "good", scope: "external", basis: "x", authorized: true, data_classes: ["public"] },
  // No field at all — the only unrestricted form.
  { provider: "unrestricted", scope: "external", basis: "x", authorized: true },
];

test("an EMPTY data_classes denies everything (it is what a malformed entry becomes)", () => {
  assert.equal(agentBackendAuthorizedIn(malformed, "typo", "public"), false);
  assert.equal(agentBackendAuthorizedIn(malformed, "typo", "student"), false);
  assert.equal(agentBackendAuthorizedIn(malformed, "typo"), false);
});

test("an ABSENT data_classes is the only unrestricted form", () => {
  assert.equal(agentBackendAuthorizedIn(malformed, "unrestricted", "public"), true);
  assert.equal(agentBackendAuthorizedIn(malformed, "unrestricted", "student"), true);
});

test("the well-formed scoped entry is unaffected", () => {
  assert.equal(agentBackendAuthorizedIn(malformed, "good", "public"), true);
  assert.equal(agentBackendAuthorizedIn(malformed, "good", "student"), false);
});

test("the PARSER refuses an unrecognised class instead of dropping it", async () => {
  // Reproduces the original attack end-to-end through the REAL YAML loader.
  //
  // This runs in a CHILD PROCESS with POLICY_DIR set, because src/policy.ts
  // loads and freezes its policy at module-evaluation time — an in-process
  // import cannot see a different file, and a first attempt at this test
  // silently asserted against the real (well-formed) policy and passed no
  // matter what the parser did. Red-proofed: reverting the parser fix fails it.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");

  const real = fs.readFileSync("policy/action-policy.yaml", "utf-8");
  assert.ok(real.includes("data_classes: [public]"), "fixture anchor must exist");

  for (const bad of ["[Public]", "[publik]", "public", "[public, nonsense]"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-malformed-"));
    fs.writeFileSync(
      path.join(dir, "action-policy.yaml"),
      real.replace("data_classes: [public]", `data_classes: ${bad}`),
    );
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        'const m = await import("./src/policy.ts");' +
          'process.stdout.write(JSON.stringify({' +
          '  student: m.isAgentBackendAuthorized("anthropic", "student"),' +
          '  pub: m.isAgentBackendAuthorized("anthropic", "public"),' +
          '  none: m.isAgentBackendAuthorized("anthropic"),' +
          '}));',
      ],
      { env: { ...process.env, POLICY_DIR: dir }, encoding: "utf-8" },
    );
    const got = JSON.parse(out) as { student: boolean; pub: boolean; none: boolean };
    assert.equal(got.student, false, `data_classes: ${bad} must NOT grant student access`);
    assert.equal(got.pub, false, `data_classes: ${bad} is malformed and must grant nothing`);
    assert.equal(got.none, false, `data_classes: ${bad} must not pass an undeclared caller`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a well-formed policy in a child process still grants public (control)", async () => {
  // Without this control the test above could pass because the child failed to
  // load ANY policy — every provider would then be false for the wrong reason.
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      'const m = await import("./src/policy.ts");' +
        'process.stdout.write(JSON.stringify({' +
        '  pub: m.isAgentBackendAuthorized("anthropic", "public"),' +
        '  student: m.isAgentBackendAuthorized("anthropic", "student"),' +
        '}));',
    ],
    { env: { ...process.env, POLICY_DIR: "policy" }, encoding: "utf-8" },
  );
  const got = JSON.parse(out) as { pub: boolean; student: boolean };
  assert.equal(got.pub, true, "the real policy must still grant public");
  assert.equal(got.student, false, "and must still refuse student");
});
