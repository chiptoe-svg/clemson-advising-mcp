// THE CROSS-IMPLEMENTATION CONTRACT for the consumer registry.
//
// WHY THIS EXISTS. One registry format now has TWO implementations: this repo's
// TypeScript (src/mcp-tools/consumers.ts) and gc_alumni's Python
// (mcp_server/_auth.py, retrofitted 2026-09-13). Each has its own tests. Each
// passes. Nothing else checks that they mean the SAME THING by the format.
//
// The failure that costs: a token minted by `mcp:pair` is rejected by the other
// implementation. A valid credential returning 401 reads as "wrong token", so
// the next person debugs the token, the file, the header — anything but a
// semantic difference between two green test suites.
//
// This file and test/fixtures/registry-contract.json are the CANONICAL side of
// that contract. gc_alumni loads the same JSON and asserts the same outcomes.
// Change the fixture only by agreement with that repo; changing it on one side
// is exactly the drift it exists to catch.
//
// WHAT IT FOUND ON ITS FIRST RUN (2026-09-13): this implementation matched the
// `Bearer ` prefix case-SENSITIVELY while the Python one lowercased it. RFC 7235
// §2.1 makes the scheme name case-insensitive, so a client sending `bearer <t>`
// authenticated against gc_alumni and got a 401 here — same token, same person,
// different answer per server.
//
// THREE RULES, each from a defect observed while building this:
//   1. A MISSING OR UNPARSEABLE FIXTURE FAILS. The usual behaviour — skip when
//      the path is wrong — yields a green run that checked nothing.
//   2. EVERY VECTOR IS CONSUMED. A row no assertion reads is worse than a
//      missing one: it looks authoritative and is checked by nothing, so the
//      first person to trust it debugs the implementation instead of the file.
//   3. THE COUNT IS ASSERTED. A truncated or half-written fixture must not pass
//      by containing fewer cases than it should.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  hashToken,
  parseConsumers,
  authenticateConsumer,
  type Consumer,
} from "../src/mcp-tools/consumers.js";
import { expandScopes, allExposedOperations } from "../src/mcp-tools/permissions.js";

const FIXTURE = path.join("test", "fixtures", "registry-contract.json");

/** Rule 1: absent or malformed fixture is a FAILURE, never a skip. */
function loadFixture(): any {
  let raw: string;
  try {
    raw = fs.readFileSync(FIXTURE, "utf-8");
  } catch (e) {
    throw new Error(
      `${FIXTURE} is missing or unreadable (${String(e)}). This fixture is the ` +
        `shared contract with gc_alumni; a missing file must fail rather than ` +
        `silently skip, or the suite goes green having checked nothing.`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${FIXTURE} is not valid JSON (${String(e)})`);
  }
}

const FX = loadFixture();

/** Rule 2: every vector read increments this; rule 3 checks it at the end. */
let consumed = 0;

test("fixture declares the version this loader understands", () => {
  assert.equal(FX.version, 1, "fixture version changed — review before bumping");
});

for (const v of FX.hash_vectors) {
  test(`hash: ${v.name}`, () => {
    consumed++;
    assert.equal(
      hashToken(v.raw),
      v.sha256,
      `hashToken(${JSON.stringify(v.raw)}) disagrees with the shared vector. ` +
        `This is the encoding contract (utf-8 in, lowercase hex out); a ` +
        `divergence here means tokens minted by one implementation are ` +
        `unrecognizable to the other.`,
    );
  });
}

const REGISTRY = parseConsumers(JSON.stringify(FX.registry));

for (const v of FX.auth_vectors) {
  test(`auth: ${v.name}`, () => {
    consumed++;
    const got = authenticateConsumer(v.header ?? undefined, REGISTRY)?.id ?? null;
    assert.equal(
      got,
      v.expect,
      `header ${JSON.stringify(v.header)} resolved to ${JSON.stringify(got)}, ` +
        `contract says ${JSON.stringify(v.expect)}`,
    );
  });
}

for (const v of FX.parse_vectors) {
  test(`parse: ${v.name}`, () => {
    consumed++;
    const ids = parseConsumers(v.raw).map((c: Consumer) => c.id);
    assert.deepEqual(ids, v.expect_ids);
  });
}

for (const v of FX.scope_vectors) {
  test(`scope: ${v.name}`, () => {
    consumed++;
    const got = expandScopes(v.scopes ?? undefined);
    if (v.expect === "full") {
      assert.deepEqual(
        [...got].sort(),
        [...allExposedOperations()].sort(),
        "absent/empty scopes must mean FULL access (default-allow)",
      );
    } else {
      assert.equal(got.size, 0, "an unrecognized scope must grant nothing");
    }
  });
}

// Rules 2 and 3, asserted last so they see the final count.
test("every vector in the fixture was consumed by an assertion", () => {
  const declared =
    FX.hash_vectors.length +
    FX.auth_vectors.length +
    FX.parse_vectors.length +
    FX.scope_vectors.length;
  assert.equal(
    consumed,
    declared,
    `${declared} vectors in the fixture, ${consumed} consumed. An unasserted ` +
      `vector reads as authoritative and is checked by nothing.`,
  );
  assert.ok(
    declared >= 20,
    `only ${declared} vectors — the fixture looks truncated; it should carry ` +
      `hash, auth, parse and scope classes`,
  );
});
