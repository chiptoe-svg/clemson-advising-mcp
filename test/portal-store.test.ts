// The PIN lifecycle is the security boundary of the portal: it is the only
// thing standing between "approved" and "holding a credential". These pin the
// properties whose failure is silent or exploitable.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  openStore,
  insertGrant,
  findByEmail,
  verifyPin,
  rotatePin,
  markRevealed,
  expireLapsed,
  hashPin,
  pinMatches,
  generatePin,
} from "../src/portal/store.js";

const HOUR = 3_600_000;
const NOW = 1_760_000_000_000;

const fresh = (o: Partial<Parameters<typeof insertGrant>[1]> = {}) => {
  const db = openStore(":memory:");
  const id = insertGrant(
    db,
    {
      decision_id: "dec-1",
      email: "jsmith@clemson.edu",
      consumer_id: "jsmith",
      name: "Jane Smith",
      servers: ["schedule"],
      auth_scopes: { schedule: ["clemson.schedule"] },
      pin_hash: hashPin("123456"),
      pin_expires_at: NOW + 24 * HOUR,
      claim_expires_at: NOW + 7 * 24 * HOUR,
      ...o,
    },
    NOW,
  );
  return { db, id };
};

test("the PIN is never stored, only its hash", () => {
  const { db } = fresh();
  const raw = JSON.stringify(db.prepare("SELECT * FROM pending_grant").all());
  assert.doesNotMatch(raw, /123456/, "the PIN itself must not be in the row");
  assert.match(raw, new RegExp(hashPin("123456")));
});

test("pinMatches is length-guarded and rejects a wrong pin", () => {
  assert.ok(pinMatches("123456", hashPin("123456")));
  assert.ok(!pinMatches("123457", hashPin("123456")));
  // A truncated/garbage hash must not throw — timingSafeEqual does on length
  // mismatch, which would surface as a 500 instead of a clean failure.
  assert.doesNotThrow(() => pinMatches("123456", "deadbeef"));
  assert.ok(!pinMatches("123456", "deadbeef"));
});

test("a correct PIN verifies", () => {
  const { db } = fresh();
  const r = verifyPin(db, "jsmith@clemson.edu", "123456", 5, NOW);
  assert.ok(r.ok);
  assert.equal(r.grant.consumer_id, "jsmith");
});

test("email matching is case-insensitive", () => {
  const { db } = fresh();
  assert.ok(verifyPin(db, "JSmith@Clemson.EDU", "123456", 5, NOW).ok);
});

test("a wrong PIN counts an attempt and the cap locks it", () => {
  const { db } = fresh();
  for (let i = 0; i < 5; i++) {
    const r = verifyPin(db, "jsmith@clemson.edu", "000000", 5, NOW);
    assert.equal(r.ok, false);
  }
  const locked = verifyPin(db, "jsmith@clemson.edu", "123456", 5, NOW);
  assert.equal(locked.ok, false);
  assert.equal((locked as { reason: string }).reason, "too_many_attempts");
});

test("an EXPIRED pin still counts an attempt", () => {
  // Otherwise a brute-force can be laundered through stale codes: guess freely
  // against an expired PIN, and the counter never moves.
  const { db } = fresh();
  verifyPin(db, "jsmith@clemson.edu", "000000", 5, NOW + 25 * HOUR);
  const g = findByEmail(db, "jsmith@clemson.edu")!;
  assert.equal(g.attempts, 1);
});

test("an expired CLAIM is reported as such, not as a wrong PIN", () => {
  // Different facts. A person who typed the right code deserves the real
  // reason, and "wrong PIN" would send them to check the code they got right.
  const { db } = fresh();
  const r = verifyPin(db, "jsmith@clemson.edu", "123456", 5, NOW + 8 * 24 * HOUR);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "claim_expired");
  assert.equal(findByEmail(db, "jsmith@clemson.edu"), null, "and it is swept");
});

test("the claim window is checked BEFORE the PIN", () => {
  // A lapsed claim with a wrong PIN must report the claim, not the PIN —
  // otherwise someone re-requests a code for a grant that no longer exists.
  const { db } = fresh();
  const r = verifyPin(db, "jsmith@clemson.edu", "999999", 5, NOW + 8 * 24 * HOUR);
  assert.equal((r as { reason: string }).reason, "claim_expired");
});

test("an unknown address is 'no_grant', indistinguishable from a wrong one", () => {
  const { db } = fresh();
  const r = verifyPin(db, "nobody@clemson.edu", "123456", 5, NOW);
  assert.equal((r as { reason: string }).reason, "no_grant");
});

test("a fresh PIN replaces the old one and resets attempts", () => {
  // Resetting is deliberate: a new code is a new secret, and carrying the old
  // count would let five wrong guesses lock someone out with no way back.
  const { db } = fresh();
  for (let i = 0; i < 4; i++) verifyPin(db, "jsmith@clemson.edu", "000000", 5, NOW);
  const rr = rotatePin(db, "jsmith@clemson.edu", hashPin("654321"), NOW + 24 * HOUR, 5, NOW);
  assert.ok(rr.ok);
  assert.equal(findByEmail(db, "jsmith@clemson.edu")!.attempts, 0);
  assert.ok(verifyPin(db, "jsmith@clemson.edu", "654321", 5, NOW).ok);
  assert.equal(verifyPin(db, "jsmith@clemson.edu", "123456", 5, NOW).ok, false);
});

test("a resend NEVER extends the claim window", () => {
  // The whole reason the two clocks differ. If a resend extended the claim,
  // repeated clicking would make an authorized-but-unclaimed grant immortal.
  const { db } = fresh();
  const before = findByEmail(db, "jsmith@clemson.edu")!.claim_expires_at;
  rotatePin(db, "jsmith@clemson.edu", hashPin("654321"), NOW + 48 * HOUR, 5, NOW);
  assert.equal(findByEmail(db, "jsmith@clemson.edu")!.claim_expires_at, before);
});

test("resends are capped", () => {
  const { db } = fresh();
  for (let i = 0; i < 5; i++) {
    assert.ok(rotatePin(db, "jsmith@clemson.edu", hashPin("111111"), NOW + HOUR, 5, NOW).ok);
  }
  const r = rotatePin(db, "jsmith@clemson.edu", hashPin("111111"), NOW + HOUR, 5, NOW);
  assert.equal((r as { reason: string }).reason, "too_many_resends");
});

test("a resend against a lapsed claim fails as claim_expired", () => {
  const { db } = fresh();
  const r = rotatePin(db, "jsmith@clemson.edu", hashPin("1"), NOW, 5, NOW + 8 * 24 * HOUR);
  assert.equal((r as { reason: string }).reason, "claim_expired");
});

test("a revealed grant cannot be claimed again", () => {
  // The page is shown once; a second verify must not mint a second token.
  const { db, id } = fresh();
  assert.ok(verifyPin(db, "jsmith@clemson.edu", "123456", 5, NOW).ok);
  markRevealed(db, id, NOW);
  const again = verifyPin(db, "jsmith@clemson.edu", "123456", 5, NOW);
  assert.equal((again as { reason: string }).reason, "no_grant");
});

test("one live grant per address per decision", () => {
  const { db } = fresh();
  assert.throws(() =>
    insertGrant(db, {
      decision_id: "dec-1",
      email: "jsmith@clemson.edu",
      consumer_id: "jsmith",
      name: "Jane Smith",
      servers: ["schedule"],
      auth_scopes: {},
      pin_hash: hashPin("1"),
      pin_expires_at: NOW,
      claim_expires_at: NOW,
    }),
  );
});

test("the sweep makes status a fact rather than a read-time guess", () => {
  const { db } = fresh();
  assert.equal(expireLapsed(db, NOW + 8 * 24 * HOUR), 1);
  assert.equal(expireLapsed(db, NOW + 8 * 24 * HOUR), 0, "idempotent");
});

test("scopes and servers survive the round trip", () => {
  const { db } = fresh({
    servers: ["schedule", "gc_alumni"],
    auth_scopes: { schedule: ["clemson.schedule"], gc_alumni: ["gc.alumni.research"] },
  });
  const g = findByEmail(db, "jsmith@clemson.edu")!;
  assert.deepEqual(g.servers, ["schedule", "gc_alumni"]);
  assert.deepEqual(g.auth_scopes.gc_alumni, ["gc.alumni.research"]);
});

test("PINs come from the CSPRNG, not a predictable generator", () => {
  // Math.random is V8's xorshift128+; its state is recoverable from a few
  // outputs. The resend endpoint is UNAUTHENTICATED, so an attacker can drive
  // the generator, and anyone holding one grant sees real outputs — enough to
  // predict codes issued to other people. This asserts the shape and the
  // spread; the primitive itself is pinned by the source-level check below.
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const p = generatePin(6);
    assert.match(p, /^\d{6}$/, "must be exactly 6 digits, zero-padded");
    seen.add(p);
  }
  assert.ok(seen.size > 1900, `only ${seen.size} distinct in 2000 — suspiciously clustered`);
});

test("the low digit is not biased", () => {
  // A modulo of a wider random value biases low digits. randomInt is
  // rejection-sampled; this would catch a regression to `% 10**n`.
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 20000; i++) counts[Number(generatePin(6).at(-1))]++;
  for (const c of counts) assert.ok(c > 1500 && c < 2500, `digit skew: ${counts}`);
});

test("no portal source uses Math.random", () => {
  // The property that matters is the PRIMITIVE, and no distribution test can
  // tell a good PRNG from a CSPRNG — only reading the source can.
  const dir = new URL("../src/portal/", import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const src = fs.readFileSync(new URL(f, dir), "utf-8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(code, /Math\.random/, `${f} uses Math.random`);
  }
});
