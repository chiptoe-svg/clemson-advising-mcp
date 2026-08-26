import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHttpHandler, UNAUTH_LIMIT, __resetUnauthTrackerForTest } from "../src/mcp-tools/server.ts";
import { __configureLogForTest, __resetLogForTest } from "../src/log.ts";

function hit(handler: ReturnType<typeof createHttpHandler>, remote: string): number {
  const req = new EventEmitter() as EventEmitter & { headers: Record<string, string>; method: string; socket: { remoteAddress: string } };
  req.headers = {}; req.method = "POST"; req.socket = { remoteAddress: remote };
  let status = 0;
  const res = { writeHead: (code: number) => { status = code; }, end: () => {}, on: () => {} };
  handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);
  return status;
}

test("unauthenticated requests: 401 up to the per-source limit, then 429 for the rest of the window; other sources unaffected; logs stay sparse", () => {
  __resetUnauthTrackerForTest();
  const lines: string[] = [];
  __configureLogForTest({ sink: (line: string) => { lines.push(line); } } as never);
  try {
    let t = 1_000_000;
    const handler = createHttpHandler("t", () => null, { now: () => t });
    const codes: number[] = [];
    for (let i = 0; i < UNAUTH_LIMIT + 5; i++) codes.push(hit(handler, "10.0.0.9"));
    assert.deepEqual(codes.slice(0, UNAUTH_LIMIT), Array(UNAUTH_LIMIT).fill(401));
    assert.deepEqual(codes.slice(UNAUTH_LIMIT), Array(5).fill(429));
    assert.equal(hit(handler, "10.0.0.10"), 401, "a different source is not throttled");
    // 35 attempts from the first source produced ONE log line (the first hit), not 35.
    assert.equal(lines.filter((l) => l.includes("mcp unauthorized request") && l.includes("10.0.0.9")).length, 1, lines.join("\n"));
    // Window rolls over: back to 401.
    t += 61_000;
    assert.equal(hit(handler, "10.0.0.9"), 401);
  } finally {
    __resetLogForTest();
    __resetUnauthTrackerForTest();
  }
});
