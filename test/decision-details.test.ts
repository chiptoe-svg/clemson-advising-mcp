// The decision details are read by three repos. These pin the shape, because
// the alternative — describing it in a message — is how the gc_alumni session
// came to build a parser against a reasonable guess of it.
import assert from "node:assert/strict";
import test from "node:test";

import { parseRoster, type Server } from "../src/bulk-invite.js";
import { rosterToDecisionDetails } from "../src/portal/decision-details.js";

const VALID = new Set(["clemson.schedule", "clemson.catalog", "clemson.department", "host"]);
const opts = { existing: {} as Partial<Record<Server, Set<string>>>, isValidScope: (s: string) => VALID.has(s) };
const build = (csv: string) => {
  const r = parseRoster(csv, opts);
  assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
  return rosterToDecisionDetails(r.roster!);
};

test("every recipient carries BOTH id and email", () => {
  // Not interchangeable: email is where the PIN goes, id is the ledger
  // identity. Deriving one from the other means three repos implementing the
  // same local-part rule and disagreeing on the first dotted address.
  const d = build("name,email,servers\nJane Smith,j.smith@clemson.edu,schedule\n");
  assert.equal(d.recipients[0].id, "j.smith");
  assert.equal(d.recipients[0].email, "j.smith@clemson.edu");
  assert.equal(d.recipients[0].name, "Jane Smith");
});

test("the fingerprint travels with the details", () => {
  // It is what binds the approval to the parse that was reviewed.
  const d = build("name,email,servers\nJane,jsmith@clemson.edu,schedule\n");
  assert.match(d.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(d.version, 1);
});

test("auth_scopes is keyed by SERVER, not flat", () => {
  const d = build(
    "name,email,servers,scopes\n" +
      'Jane,jsmith@clemson.edu,schedule|catalog,"clemson.schedule clemson.catalog"\n',
  );
  assert.deepEqual(d.recipients[0].auth_scopes, {
    schedule: ["clemson.schedule"],
    catalog: ["clemson.catalog"],
  });
});

test("a cross-cutting scope applies to every mintable server", () => {
  const d = build(
    'name,email,servers,scopes\nJane,jsmith@clemson.edu,schedule|catalog,"host"\n',
  );
  assert.deepEqual(d.recipients[0].auth_scopes, {
    schedule: ["host"],
    catalog: ["host"],
  });
});

test("alumni scopes land under gc_alumni, never merged with this repo's", () => {
  const d = build(
    "name,email,servers,scopes\n" +
      'Jane,jsmith@clemson.edu,schedule|gc_alumni,"clemson.schedule gc.alumni.research"\n',
  );
  assert.deepEqual(d.recipients[0].auth_scopes, {
    schedule: ["clemson.schedule"],
    gc_alumni: ["gc.alumni.research"],
  });
});

test("granted-whole is an ABSENT key, never an empty array", () => {
  // Per the shared registry contract, absent/empty means full access. Emitting
  // [] invites a reader to treat it as "no scopes granted" — the fail-open and
  // fail-closed readings of the same value.
  const d = build("name,email,servers\nJane,jsmith@clemson.edu,gc_careers\n");
  assert.deepEqual(d.recipients[0].auth_scopes, {});
  assert.ok(!("gc_careers" in d.recipients[0].auth_scopes));
});

test("servers lists delegated and mintable together, sorted", () => {
  const d = build("name,email,servers\nJane,jsmith@clemson.edu,gc_careers|schedule\n");
  assert.deepEqual(d.recipients[0].servers, ["gc_careers", "schedule"]);
});

test("an empty note is omitted rather than carried as an empty string", () => {
  const withNote = build("name,email,servers,note\nJane,jsmith@clemson.edu,schedule,MKT 3010\n");
  assert.equal(withNote.recipients[0].note, "MKT 3010");
  const without = build("name,email,servers\nJane,jsmith@clemson.edu,schedule\n");
  assert.ok(!("note" in without.recipients[0]));
});

test("mailcal's contract holds: every recipient has a usable email", () => {
  // mailcal reads recipients[i].email and nothing else. A recipient without
  // one would fail at SEND time, on an approval already spent.
  const d = build(
    "name,email,servers\nA,a@clemson.edu,schedule\nB,b@g.clemson.edu,gc_careers\n",
  );
  for (const r of d.recipients) {
    assert.match(r.email, /^[^\s,;"'<>()[\]]+@[^\s,;"'<>()[\]]+$/);
  }
});
