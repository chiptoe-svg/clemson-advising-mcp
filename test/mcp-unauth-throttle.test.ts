import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  createHttpHandler,
  UNAUTH_LIMIT,
  __resetUnauthTrackerForTest,
} from "../src/mcp-tools/server.ts";
import { __configureLogForTest, __resetLogForTest } from "../src/log.ts";

/** Authentication is async (it must be, for any OAuth scheme), so the 401/429 is
 *  written a microtask after the call. Await a tick before reading the status. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function hit(
  handler: ReturnType<typeof createHttpHandler>,
  remote: string,
): Promise<number> {
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    method: string;
    socket: { remoteAddress: string };
  };
  req.headers = {};
  req.method = "POST";
  req.socket = { remoteAddress: remote };
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
  await tick();
  return status;
}

test("unauthenticated requests: 401 up to the per-source limit, then 429 for the rest of the window; other sources unaffected; logs stay sparse", async () => {
  __resetUnauthTrackerForTest();
  const lines: string[] = [];
  __configureLogForTest({
    sink: (line: string) => {
      lines.push(line);
    },
  } as never);
  try {
    let t = 1_000_000;
    const handler = createHttpHandler("t", async () => null, { now: () => t });
    const codes: number[] = [];
    for (let i = 0; i < UNAUTH_LIMIT + 5; i++)
      codes.push(await hit(handler, "10.0.0.9"));
    assert.deepEqual(
      codes.slice(0, UNAUTH_LIMIT),
      Array(UNAUTH_LIMIT).fill(401),
    );
    assert.deepEqual(codes.slice(UNAUTH_LIMIT), Array(5).fill(429));
    assert.equal(
      await hit(handler, "10.0.0.10"),
      401,
      "a different source is not throttled",
    );
    // 35 attempts from the first source produced ONE log line (the first hit), not 35.
    assert.equal(
      lines.filter(
        (l) => l.includes("mcp unauthorized request") && l.includes("10.0.0.9"),
      ).length,
      1,
      lines.join("\n"),
    );
    // Window rolls over: back to 401.
    t += 61_000;
    assert.equal(await hit(handler, "10.0.0.9"), 401);
  } finally {
    __resetLogForTest();
    __resetUnauthTrackerForTest();
  }
});

// --- per-CONSUMER rate limiting (extraction hardening, 2026-08-28) ----------
//
// The throttle above bounds UNAUTHENTICATED attempts per source address. An
// authenticated consumer was unbounded — fine while the only caller was the
// advisor on loopback, not fine once these servers are campus-served and tokens
// are issued to other people's agents.
//
// Keyed on the CONSUMER, not the address: agents can share an egress IP, and
// the point is to bound one credential's blast radius.

import {
  CONSUMER_LIMIT,
  parseConsumerLimit,
  __resetConsumerRateForTest,
} from "../src/mcp-tools/server.ts";

const tickC = (): Promise<void> => new Promise((r) => setImmediate(r));

async function authedHit(
  handler: ReturnType<typeof createHttpHandler>,
  remote: string,
): Promise<number> {
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    method: string;
    url: string;
    socket: { remoteAddress: string };
  };
  req.headers = { authorization: "Bearer ok" };
  req.method = "POST";
  req.url = "/";
  req.socket = { remoteAddress: remote };
  let status = 0;
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: () => {},
    on: () => {},
    headersSent: false,
  };
  handler(
    req as unknown as Parameters<typeof handler>[0],
    res as unknown as Parameters<typeof handler>[1],
  );
  await tickC();
  return status;
}

test("an AUTHENTICATED consumer is bounded, and the 429 names it", async () => {
  __resetUnauthTrackerForTest();
  __resetConsumerRateForTest();
  const handler = createHttpHandler("t", async () => ({
    id: "greedy-agent",
    scopes: new Set<string>(),
    authMethod: "registry-token" as const,
  }));
  const codes: number[] = [];
  for (let i = 0; i < CONSUMER_LIMIT + 3; i++)
    codes.push(await authedHit(handler, "10.0.0.5"));
  assert.ok(
    codes.slice(0, CONSUMER_LIMIT).every((c) => c !== 429),
    "requests within the ceiling must not be throttled",
  );
  assert.deepEqual(
    codes.slice(CONSUMER_LIMIT),
    [429, 429, 429],
    "past it, 429",
  );
});

test("the limit follows the CREDENTIAL, not the source address", async () => {
  // Two agents behind one egress IP must not consume each other's budget, and
  // one agent moving between addresses must not escape its own.
  __resetUnauthTrackerForTest();
  __resetConsumerRateForTest();
  let who = "agent-a";
  const handler = createHttpHandler("t", async () => ({
    id: who,
    scopes: new Set<string>(),
    authMethod: "registry-token" as const,
  }));
  for (let i = 0; i < CONSUMER_LIMIT + 1; i++)
    await authedHit(handler, "10.0.0.9");
  assert.equal(
    await authedHit(handler, "10.0.0.9"),
    429,
    "agent-a is over its ceiling",
  );
  who = "agent-b";
  assert.notEqual(
    await authedHit(handler, "10.0.0.9"),
    429,
    "a DIFFERENT consumer on the SAME address must have its own budget",
  );
  who = "agent-a";
  assert.equal(
    await authedHit(handler, "10.0.0.250"),
    429,
    "the same consumer from a DIFFERENT address is still over its ceiling",
  );
});

test("MCP_CONSUMER_RATE_LIMIT: garbage falls back to the default instead of disabling the limit", () => {
  // Number("abc") is NaN and `count > NaN` is always false — the old parse
  // turned a typo into an unlimited credential.
  assert.equal(parseConsumerLimit("abc"), 600);
  assert.equal(parseConsumerLimit(""), 600);
  assert.equal(parseConsumerLimit(undefined), 600);
  assert.equal(parseConsumerLimit("0"), 600);
  assert.equal(parseConsumerLimit("-5"), 600);
  assert.equal(parseConsumerLimit("250"), 250);
});
