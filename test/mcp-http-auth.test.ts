import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  assertHttpAuthConfig,
  createHttpHandler,
  isLoopbackHost,
  openAuthenticator,
  resolveCredentialedAuth,
  authContext,
} from "../src/mcp-tools/server.ts";
import { hashToken, type Consumer } from "../src/mcp-tools/consumers.ts";

/** Auth is async, so 401/413 land a microtask after the handler call. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("assertHttpAuthConfig: open mode allowed only on loopback", () => {
  assert.doesNotThrow(() => assertHttpAuthConfig("", "127.0.0.1"));
  assert.doesNotThrow(() => assertHttpAuthConfig("", "::1"));
  assert.throws(
    () => assertHttpAuthConfig("", "0.0.0.0"),
    /required when MCP_HTTP_HOST is not loopback/,
  );
  assert.doesNotThrow(() => assertHttpAuthConfig("tok", "0.0.0.0"));
});

test("isLoopbackHost", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});

test("openAuthenticator always admits", async () => {
  assert.equal((await openAuthenticator(authContext(undefined)))?.id, "public");
  assert.equal((await openAuthenticator(authContext("Bearer whatever")))?.id, "public");
});

test("resolveCredentialedAuth fails closed with no consumers", () => {
  assert.throws(
    () => resolveCredentialedAuth({ load: () => [] }),
    /no authorized consumers|Refusing to start open/,
  );
});

test("resolveCredentialedAuth authenticates a registered token and reports it", async () => {
  const seen: string[] = [];
  const consumers: Consumer[] = [
    {
      id: "agent-1",
      token_hash: hashToken("cma_tok"),
      created_at: "x",
      provider: "chatgpt_edu",
    },
  ];
  const authenticate = resolveCredentialedAuth({
    load: () => consumers,
    onSeen: (id) => seen.push(id),
  });
  assert.equal((await authenticate(authContext("Bearer cma_tok")))?.id, "agent-1");
  assert.equal(await authenticate(authContext("Bearer nope")), null);
  assert.deepEqual(seen, ["agent-1"]); // onSeen fires only on success
});

test("resolveCredentialedAuth accepts the env token as a consumer", async () => {
  const authenticate = resolveCredentialedAuth({
    load: () => [],
    envToken: "env-secret",
    envTokenProvider: "chatgpt_edu",
  });
  assert.equal((await authenticate(authContext("Bearer env-secret")))?.id, "env-token");
});

test("createHttpHandler rejects an oversized body with 413", async () => {
  const handler = createHttpHandler("t", async () => ({
    id: "agent",
    scopes: new Set<string>(),
    authMethod: "registry-token" as const,
  }));
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    method: string;
    socket: { remoteAddress: string };
    destroy: () => void;
  };
  req.headers = { authorization: "Bearer x" };
  req.method = "POST";
  req.socket = { remoteAddress: "127.0.0.1" };
  let destroyed = false;
  req.destroy = () => {
    destroyed = true;
  };
  let status = 0;
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: () => {},
    on: () => {},
  };
  handler(
    req as unknown as Parameters<typeof handler>[0],
    res as unknown as Parameters<typeof handler>[1],
  );
  await tick(); // auth resolves before the body handlers are attached
  // Emit a chunk larger than the 1 MiB cap.
  req.emit("data", Buffer.alloc(1_048_577));
  assert.equal(status, 413);
  assert.equal(destroyed, true);
});

test("createHttpHandler rejects an unauthenticated request with 401", async () => {
  const handler = createHttpHandler("t", async () => null);
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    method: string;
    socket: { remoteAddress: string };
  };
  req.headers = {};
  req.method = "POST";
  req.socket = { remoteAddress: "127.0.0.1" };
  let status = 0;
  let ended = false;
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: () => {
      ended = true;
    },
    on: () => {},
  };
  handler(
    req as unknown as Parameters<typeof handler>[0],
    res as unknown as Parameters<typeof handler>[1],
  );
  await tick();
  assert.equal(status, 401);
  assert.equal(ended, true);
});
