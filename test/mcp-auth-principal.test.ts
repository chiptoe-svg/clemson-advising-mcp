import assert from "node:assert/strict";
import test from "node:test";

import { hashToken, type Consumer } from "../src/mcp-tools/consumers.ts";
import { authContext, resolveCredentialedAuth } from "../src/mcp-tools/server.ts";

const TOKEN = "cma_principal-test";
const loadWith = (c: Partial<Consumer>) => (): Consumer[] => [
  { id: "a", token_hash: hashToken(TOKEN), created_at: "t", ...c },
];

test("Principal returned for an attested, authorized, scoped consumer", async () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "chatgpt_edu", scopes: ["clemson"] }),
  });
  const p = await auth(authContext(`Bearer ${TOKEN}`));
  assert.equal(p?.id, "a");
  assert.equal(p?.provider, "chatgpt_edu");
  assert.equal(p?.scopes.has("clemson.list_terms"), true);
  assert.equal(p?.scopes.has("host.list_skills"), false);
});

test("unscoped attested consumer gets the full exposed scope", async () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "openai_api" }),
  });
  const p = await auth(authContext(`Bearer ${TOKEN}`));
  assert.equal(p?.scopes.has("clemson.list_terms"), true);
  assert.equal(p?.scopes.has("host.list_skills"), true);
});

test("unattested consumer (no provider) is rejected", async () => {
  const auth = resolveCredentialedAuth({ load: loadWith({}) });
  assert.equal(await auth(authContext(`Bearer ${TOKEN}`)), null);
});

test("consumer with an unauthorized provider is rejected", async () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "anthropic" }),
  });
  assert.equal(await auth(authContext(`Bearer ${TOKEN}`)), null);
});

test("wrong token is rejected", async () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "chatgpt_edu" }),
  });
  assert.equal(await auth(authContext("Bearer nope")), null);
});

test("env-token uses its configured provider", async () => {
  const auth = resolveCredentialedAuth({
    load: (): Consumer[] => [],
    envToken: "cma_env",
    envTokenProvider: "chatgpt_edu",
  });
  assert.equal((await auth(authContext(`Bearer cma_env`)))?.id, "env-token");
  const authBad = resolveCredentialedAuth({
    load: (): Consumer[] => [],
    envToken: "cma_env2",
    envTokenProvider: "anthropic",
  });
  assert.equal(await authBad(authContext(`Bearer cma_env2`)), null);
  // env-token with no provider configured is rejected (silent-misconfig guard).
  const authNoProvider = resolveCredentialedAuth({
    load: (): Consumer[] => [],
    envToken: "cma_env3",
  });
  assert.equal(await authNoProvider(authContext(`Bearer cma_env3`)), null);
});
