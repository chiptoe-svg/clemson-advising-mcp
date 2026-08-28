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
