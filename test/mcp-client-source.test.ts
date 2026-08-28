// Who is actually calling, when a reverse proxy sits in front (2026-08-28).
//
// Observed, not inferred: with the servers on loopback behind the campus TLS
// proxy, a real MCP request from the campus network through
// https://gcworkflow.clemson.edu:8443/cu_schedule/ logged
// `source: "127.0.0.1"`. Every off-box caller looked local. Two costs — the
// audit ledger attributes nothing, and the per-source unauthenticated throttle
// collapses into one shared bucket, so a single scanner 429s everyone else.
//
// The last test is the WIRING test: computing the right address proves nothing
// if the handler still throttles on the socket peer.

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  clientSource,
  createHttpHandler,
  UNAUTH_LIMIT,
  __resetUnauthTrackerForTest,
} from "../src/mcp-tools/server.ts";

const req = (peer: string, xff?: string | string[]) => ({
  socket: { remoteAddress: peer },
  headers: xff === undefined ? {} : { "x-forwarded-for": xff },
});

test("an UNTRUSTED peer cannot name itself with X-Forwarded-For", () => {
  // The whole point of the trust check: without it, any campus client could
  // forge an identity into the audit log and dodge the per-source throttle.
  assert.equal(clientSource(req("10.1.2.3", "9.9.9.9")), "10.1.2.3");
  assert.equal(clientSource(req("130.127.5.5", "127.0.0.1")), "130.127.5.5");
});

test("a TRUSTED proxy's X-Forwarded-For is believed", () => {
  assert.equal(clientSource(req("127.0.0.1", "130.127.9.9")), "130.127.9.9");
  assert.equal(clientSource(req("::1", "130.127.9.9")), "130.127.9.9");
});

test("the RIGHTMOST hop wins — entries to its left are client-supplied", () => {
  // Taking hops[0] would let a client behind a trusted proxy pick its own
  // address again, defeating the check one layer further in.
  assert.equal(clientSource(req("127.0.0.1", "9.9.9.9, 130.127.9.9")), "130.127.9.9");
  assert.equal(
    clientSource(req("127.0.0.1", ["9.9.9.9", "8.8.8.8, 130.127.9.9"])),
    "130.127.9.9",
  );
});

test("a trusted peer with no header falls back to the peer, not to nothing", () => {
  assert.equal(clientSource(req("127.0.0.1")), "127.0.0.1");
  assert.equal(clientSource(req("127.0.0.1", "")), "127.0.0.1");
  assert.equal(clientSource(req("127.0.0.1", " , ")), "127.0.0.1");
});

test("a missing socket address is reported as unknown, never as loopback", () => {
  // "?" is honest. Defaulting to 127.0.0.1 would silently grant proxy trust.
  assert.equal(clientSource({ headers: {} }), "?");
  assert.equal(clientSource({ socket: {}, headers: { "x-forwarded-for": "9.9.9.9" } }), "?");
});

test("WIRING: the handler throttles per FORWARDED client, not per socket peer", async () => {
  // Kills the mutation "compute clientSource, keep using req.socket.remoteAddress":
  // with that mutation both clients share one bucket and the second is 429'd.
  __resetUnauthTrackerForTest();
  const handler = createHttpHandler("t", async () => null);

  const fire = (xff: string): Promise<number> =>
    new Promise((resolve) => {
      const r = new EventEmitter() as EventEmitter & Record<string, unknown>;
      r.headers = { "x-forwarded-for": xff };
      r.method = "POST";
      r.url = "/";
      r.socket = { remoteAddress: "127.0.0.1" };
      const res = {
        writeHead: (code: number) => resolve(code),
        end: () => {},
        on: () => {},
        headersSent: false,
      };
      handler(
        r as unknown as Parameters<typeof handler>[0],
        res as unknown as Parameters<typeof handler>[1],
      );
    });

  // Exhaust one client's window.
  let last = 0;
  for (let i = 0; i < UNAUTH_LIMIT + 1; i++) last = await fire("130.127.1.1");
  assert.equal(last, 429, "the noisy client must be throttled");

  // A DIFFERENT campus client, same socket peer, must still get its 401.
  assert.equal(
    await fire("130.127.2.2"),
    401,
    "one abuser behind the proxy must not throttle everyone else",
  );
});
