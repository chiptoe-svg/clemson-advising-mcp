// Regression guard for the Banner cold-session outage (2026-08-12).
//
// Banner is behind an F5 load balancer that pins a session to one backend via a
// BIGipServer* cookie set only on a fresh connection. Node's global fetch reuses
// keep-alive connections, and on a reused one the F5 drops that cookie, so the
// term-bind and the follow-up searchResults split across backends -> totalCount:0
// ("cold session"). The daily refresh hit it ~every run. The fix: every Banner
// request must go out with `Connection: close` so each gets a fresh socket and
// the stickiness cookie. This test fails if that header is ever dropped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BANNER_USER_AGENT, listClemsonTerms } from "../src/clemson-classes.js";

test("Banner requests are sent with Connection: close (no keep-alive reuse)", async () => {
  const orig = globalThis.fetch;
  const seen: Array<Record<string, string>> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push({ ...((init?.headers as Record<string, string>) ?? {}) });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    await listClemsonTerms(1);
  } finally {
    globalThis.fetch = orig;
  }

  assert.equal(seen.length, 1, "listClemsonTerms should issue exactly one request");
  // Case-insensitive: the header name may be normalized by the runtime.
  const headers = seen[0];
  const connValue = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === "connection",
  )?.[1];
  assert.equal(
    connValue,
    "close",
    "Banner fetch must send Connection: close to force a fresh socket per request",
  );
});

test("Banner requests identify this service in User-Agent (never Node's anonymous default)", async () => {
  // Daily sweeps from an unidentified client are what a Banner operator blocks.
  // The traffic must be attributable to us before anyone has to ask.
  const orig = globalThis.fetch;
  const seen: Array<Record<string, string>> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push({ ...((init?.headers as Record<string, string>) ?? {}) });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    await listClemsonTerms(1);
  } finally {
    globalThis.fetch = orig;
  }
  const ua = Object.entries(seen[0]).find(([k]) => k.toLowerCase() === "user-agent")?.[1];
  assert.equal(ua, BANNER_USER_AGENT);
  assert.match(String(ua), /clemson-advising-mcp\//, "names the service");
  assert.match(String(ua), /github\.com\/chiptoe-svg\/clemson-advising-mcp/, "points at the repo");
});
