import assert from "node:assert/strict";
import test from "node:test";

import { hashToken, type Consumer } from "../src/mcp-tools/consumers.ts";
import { authContext, resolveCredentialedAuth } from "../src/mcp-tools/server.ts";

const TOKEN = "cma_principal-test";
const loadWith = (c: Partial<Consumer>) => (): Consumer[] => [
  { id: "a", token_hash: hashToken(TOKEN), created_at: "t", ...c },
];

test("Principal returned for a scoped consumer carries only its scope", async () => {
  const auth = resolveCredentialedAuth({ load: loadWith({ scopes: ["clemson"] }) });
  const p = await auth(authContext(`Bearer ${TOKEN}`));
  assert.equal(p?.id, "a");
  assert.equal(p?.scopes.has("clemson.list_terms"), true);
  assert.equal(p?.scopes.has("host.list_skills"), false);
});

test("an unscoped consumer gets the full exposed scope", async () => {
  const auth = resolveCredentialedAuth({ load: loadWith({}) });
  const p = await auth(authContext(`Bearer ${TOKEN}`));
  assert.equal(p?.scopes.has("clemson.list_terms"), true);
  assert.equal(p?.scopes.has("host.list_skills"), true);
});

test("a registry entry carrying legacy extra fields still authenticates", async () => {
  // Registries written before 2026-08-28 carry a `provider` key. The parser
  // keeps unknown fields and the authenticator ignores them, so an existing
  // consumer keeps working across the upgrade without re-pairing.
  const legacy = { provider: "clemson_hosted" } as unknown as Partial<Consumer>;
  const auth = resolveCredentialedAuth({ load: loadWith(legacy) });
  assert.equal((await auth(authContext(`Bearer ${TOKEN}`)))?.id, "a");
});

test("wrong token is rejected", async () => {
  const auth = resolveCredentialedAuth({ load: loadWith({}) });
  assert.equal(await auth(authContext("Bearer nope")), null);
});

test("the env token authenticates as the env-token consumer", async () => {
  const auth = resolveCredentialedAuth({ load: (): Consumer[] => [], envToken: "cma_env" });
  assert.equal((await auth(authContext(`Bearer cma_env`)))?.id, "env-token");
  assert.equal(await auth(authContext(`Bearer cma_other`)), null);
});
