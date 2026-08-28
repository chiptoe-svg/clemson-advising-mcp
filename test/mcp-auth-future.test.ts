// Auth seams built for a future scheme (2026-08-27).
//
// The servers authenticate with static registry bearer tokens today. The likely
// future is an OAuth/OIDC credential from a Clemson identity provider — the same
// direction the advisor's pending-SSO item points. These tests pin the seams
// that make that a substitution rather than a rewrite, so a later refactor
// cannot quietly remove them:
//
//   - Authenticator is ASYNC (every OAuth path does I/O: JWKS, introspection)
//   - it receives a request CONTEXT, not just a header (DPoP binds to method+URL)
//   - Principal separates WHO (subject) from WHAT (clientId)
//   - expiry is enforced centrally, so a scheme that forgets cannot fail open
//   - authenticators CHAIN, so two schemes can run during a migration
//   - a 401 carries WWW-Authenticate, which is how an OAuth client discovers
//     where to authenticate

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  authContext,
  chainAuthenticators,
  createHttpHandler,
  openAuthenticator,
  resolveCredentialedAuth,
  __resetUnauthTrackerForTest,
  type Authenticator,
  type Principal,
} from "../src/mcp-tools/server.ts";
import { hashToken, type Consumer } from "../src/mcp-tools/consumers.ts";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function fakeReq(headers: Record<string, string> = {}) {
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    method: string;
    url: string;
    socket: { remoteAddress: string };
  };
  req.headers = headers;
  req.method = "POST";
  req.url = "/";
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function captureRes() {
  const captured = { status: 0, headers: {} as Record<string, string>, body: "" };
  const res = {
    writeHead: (code: number, headers?: Record<string, string>) => {
      captured.status = code;
      Object.assign(captured.headers, headers ?? {});
    },
    end: (b?: string) => { captured.body = b ?? ""; },
    on: () => {},
    headersSent: false,
  };
  return { captured, res };
}

async function run(auth: Authenticator, headers: Record<string, string> = {}) {
  __resetUnauthTrackerForTest();
  const handler = createHttpHandler("t", auth);
  const req = fakeReq(headers);
  const { captured, res } = captureRes();
  handler(
    req as unknown as Parameters<typeof handler>[0],
    res as unknown as Parameters<typeof handler>[1],
  );
  await tick();
  return captured;
}

// --- async + context --------------------------------------------------------

test("an authenticator may be genuinely async (I/O-backed, as OAuth requires)", async () => {
  const slow: Authenticator = async (ctx) => {
    await new Promise((r) => setTimeout(r, 5)); // stand-in for a JWKS fetch
    return ctx.authHeader === "Bearer good"
      ? { id: "x", scopes: new Set<string>(), authMethod: "oauth" }
      : null;
  };
  assert.equal((await slow(authContext("Bearer good")))?.id, "x");
  assert.equal(await slow(authContext("Bearer bad")), null);
});

test("the authenticator receives request context, not just the header", async () => {
  let seen: unknown = null;
  const spy: Authenticator = async (ctx) => { seen = ctx; return null; };
  await run(spy, { authorization: "Bearer z" });
  assert.deepEqual(
    Object.keys(seen as object).sort(),
    ["authHeader", "headers", "method", "source", "url"],
    "DPoP and resource indicators need method and URL, not only the header",
  );
});

// --- identity ---------------------------------------------------------------

test("Principal separates the agent (clientId) from a future end user (subject)", async () => {
  const consumers: Consumer[] = [
    { id: "agent-7", token_hash: hashToken("tok"), created_at: "t", provider: "chatgpt_edu" },
  ];
  const auth = resolveCredentialedAuth({ load: () => consumers });
  const p = (await auth(authContext("Bearer tok"))) as Principal;
  assert.equal(p.clientId, "agent-7", "a registry token identifies software");
  assert.equal(p.subject, undefined, "and NOT a person — that absence is the honest signal");
  assert.equal(p.authMethod, "registry-token");
});

test("openAuthenticator reports its own method rather than masquerading", async () => {
  const p = (await openAuthenticator(authContext(undefined))) as Principal;
  assert.equal(p.authMethod, "open");
});

// --- expiry -----------------------------------------------------------------

test("an expired principal is refused centrally, not per-scheme", async () => {
  const expired: Authenticator = async () => ({
    id: "stale", scopes: new Set<string>(), authMethod: "oauth", expiresAt: 1,
  });
  const out = await run(expired, { authorization: "Bearer whatever" });
  assert.equal(out.status, 401, "a past expiresAt must be rejected by the handler");
});

test("a principal with no expiry (registry token) still passes", async () => {
  const forever: Authenticator = async () => ({
    id: "ok", scopes: new Set<string>(), authMethod: "registry-token",
  });
  const out = await run(forever, { authorization: "Bearer whatever" });
  assert.notEqual(out.status, 401, "absent expiresAt means non-expiring, not expired");
});

// --- chaining ---------------------------------------------------------------

test("chainAuthenticators lets two schemes run side by side during a migration", async () => {
  const oauth: Authenticator = async (ctx) =>
    ctx.authHeader === "Bearer jwt"
      ? { id: "person", scopes: new Set<string>(), authMethod: "oauth", subject: "cu123" }
      : null;
  const registry: Authenticator = async (ctx) =>
    ctx.authHeader === "Bearer legacy"
      ? { id: "agent", scopes: new Set<string>(), authMethod: "registry-token" }
      : null;
  const chained = chainAuthenticators([oauth, registry]);

  assert.equal((await chained(authContext("Bearer jwt")))?.authMethod, "oauth");
  assert.equal((await chained(authContext("Bearer legacy")))?.authMethod, "registry-token");
  assert.equal(await chained(authContext("Bearer neither")), null);
});

test("chainAuthenticators is first-wins and short-circuits", async () => {
  let secondCalled = false;
  const first: Authenticator = async () => ({ id: "a", scopes: new Set<string>(), authMethod: "oauth" });
  const second: Authenticator = async () => { secondCalled = true; return null; };
  const p = await chainAuthenticators([first, second])(authContext("x"));
  assert.equal(p?.id, "a");
  assert.equal(secondCalled, false, "a later authenticator must not run after a match");
});

// --- failure and challenge --------------------------------------------------

test("a 401 carries WWW-Authenticate so an OAuth client can discover where to auth", async () => {
  const out = await run(async () => null, {});
  assert.equal(out.status, 401);
  assert.match(out.headers["www-authenticate"] ?? "", /^Bearer realm=/);
});

test("an authenticator that throws fails CLOSED with 503, not open and not a crash", async () => {
  const boom: Authenticator = async () => {
    throw new Error("introspection endpoint unreachable");
  };
  const out = await run(boom, { authorization: "Bearer x" });
  assert.equal(out.status, 503, "an auth outage must deny, never admit");
  assert.match(out.body, /authentication_unavailable/);
});
