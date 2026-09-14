// Roster import: validation, collisions, fingerprint stability.
//
// The properties worth pinning are the ones whose failure is SILENT. A rejected
// roster is obvious. What is not obvious: a roster that mints one token for two
// people, one that overwrites a live daemon's credential, one that grants a
// student cohort more than it names, or an approval bound to a parse other than
// the one the operator reviewed.
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRoster,
  fingerprintRoster,
  rosterSummary,
  splitCsvLine,
  SANITY_CEILING,
  LARGE_ROSTER,
  type Server,
} from "../src/bulk-invite.js";

const VALID_SCOPES = new Set([
  "clemson.schedule",
  "clemson.catalog",
  "clemson.department",
  "host",
]);
const opts = (existing: Partial<Record<Server, Set<string>>> = {}, allowHuge = false) => ({
  existing,
  allowHuge,
  isValidScope: (s: string) => VALID_SCOPES.has(s),
});

const HEAD = "name,email,servers\n";
const ok = (t: string) => {
  const r = parseRoster(t, opts());
  assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
  return r.roster!;
};
const bad = (t: string, o = opts()) => {
  const r = parseRoster(t, o);
  assert.equal(r.roster, null, "expected rejection");
  return r.problems;
};

test("csv splitter handles quotes, doubled quotes and commas in fields", () => {
  assert.deepEqual(splitCsvLine('a,b,c'), ["a", "b", "c"]);
  assert.deepEqual(splitCsvLine('"Smith, Jane",j@x,sched'), ["Smith, Jane", "j@x", "sched"]);
  assert.deepEqual(splitCsvLine('"say ""hi""",b'), ['say "hi"', "b"]);
});

test("a minimal valid roster resolves", () => {
  const r = ok(HEAD + "Jane Smith,jsmith@clemson.edu,schedule\n");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].id, "jsmith");
  assert.deepEqual(r.rows[0].servers, ["schedule"]);
  assert.equal(r.large, false);
});

test("id is the local part, never the address — it lands in the usage ledger", () => {
  const r = ok(HEAD + "Jane,JSmith@Clemson.EDU,schedule\n");
  assert.equal(r.rows[0].id, "jsmith");
  assert.equal(r.rows[0].email, "jsmith@clemson.edu");
});

test("default scope is NARROW, not full access", () => {
  // mcp:pair treats absent scopes as full access, which is right for one
  // deliberate mint and wrong for seventy rows nobody reads individually.
  const r = ok(HEAD + "Jane,jsmith@clemson.edu,schedule\n");
  assert.deepEqual(r.rows[0].scopes, ["clemson.schedule"]);
  const both = ok(HEAD + "Jane,jsmith@clemson.edu,schedule|catalog\n");
  assert.deepEqual(both.rows[0].scopes.sort(), ["clemson.catalog", "clemson.schedule"]);
});

test("an explicit scopes column overrides the default", () => {
  const r = ok("name,email,servers,scopes\nJane,jsmith@clemson.edu,schedule,host\n");
  assert.deepEqual(r.rows[0].scopes, ["host"]);
});

test("servers accept space, pipe or semicolon separation", () => {
  for (const sep of [" ", "|", ";"]) {
    const r = ok(HEAD + `Jane,jsmith@clemson.edu,"schedule${sep}catalog"\n`);
    assert.deepEqual(r.rows[0].servers.sort(), ["catalog", "schedule"]);
  }
});

test("non-Clemson domains are refused", () => {
  const p = bad(HEAD + "Jane,jane@gmail.com,schedule\n");
  assert.match(p[0].message, /not permitted/);
});

test("a delegated server is RECORDED but never mintable here", () => {
  // The safety property is not "alumni is refused" — a roster may legitimately
  // grant it. It is that this tool CANNOT ISSUE it: the grant is recorded in
  // the approval and minted by the repo that owns that registry. A student
  // roster therefore cannot pick up alumni access from this command, even if a
  // typo puts it in the servers column.
  const r = ok(HEAD + "Jane,jsmith@clemson.edu,gc_alumni\n");
  assert.deepEqual(r.rows[0].delegated, ["gc_alumni"]);
  assert.deepEqual(r.rows[0].mintable, [], "must never be mintable here");
  assert.equal(r.hasDelegated, true);
});

test("a row can mix mintable and delegated servers", () => {
  const r = ok(HEAD + "Jane,jsmith@clemson.edu,schedule|gc_careers\n");
  assert.deepEqual(r.rows[0].mintable, ["schedule"]);
  assert.deepEqual(r.rows[0].delegated, ["gc_careers"]);
  assert.deepEqual(r.rows[0].scopes, ["clemson.schedule"], "scopes cover the mintable half only");
});

test("gc_public is accepted as the old name for gc_careers, and noted", () => {
  // Renamed 2026-09-13. An unknown-server error would read as a typo rather
  // than a rename, and old notes will carry the old name for a while.
  const r = ok(HEAD + "Jane,jsmith@clemson.edu,gc_public\n");
  assert.deepEqual(r.rows[0].delegated, ["gc_careers"]);
  assert.deepEqual(r.renamed, ["gc_public"]);
});

test("scopes on a delegated-only row are refused, not silently dropped", () => {
  // Neither delegated server consults a scope at request time. Accepting one
  // would record a control that does not exist — and the person reading the
  // roster would believe access had been limited.
  const p = bad("name,email,servers,scopes\nJane,jsmith@clemson.edu,gc_alumni,host\n");
  assert.match(p[0].message, /granted whole/);
});

test("a delegated grant changes the fingerprint", () => {
  // The approval covers delegated grants too, so they must bind to the tap.
  const a = ok(HEAD + "Jane,jsmith@clemson.edu,schedule\n").fingerprint;
  const b = ok(HEAD + "Jane,jsmith@clemson.edu,schedule|gc_alumni\n").fingerprint;
  assert.notEqual(a, b);
});

test("the summary names delegated servers explicitly on the card", () => {
  // Approving a roster that grants gc_alumni is a materially different act
  // from approving one that grants class times; the card is where that has to
  // be legible, since the roster itself never appears there.
  const r = ok(HEAD + "Jane,jsmith@clemson.edu,schedule|gc_alumni\n");
  assert.match(rosterSummary(r), /DELEGATED: gc_alumni/);
  const plain = ok(HEAD + "Jane,jsmith@clemson.edu,schedule\n");
  assert.doesNotMatch(rosterSummary(plain), /DELEGATED/);
});

test("an existing-id collision is checked for mintable servers only", () => {
  // This process cannot read the gc_alumni registry and must not pretend to:
  // a clean result here is not evidence the id is free over there.
  const r = parseRoster(HEAD + "Jane,jsmith@clemson.edu,gc_alumni\n", opts({
    schedule: new Set(["jsmith"]),
  }));
  assert.equal(r.problems.length, 0, "a schedule collision must not block a gc_alumni grant");
});

test("an unknown server is named, not silently dropped", () => {
  const p = bad(HEAD + "Jane,jsmith@clemson.edu,shcedule\n");
  assert.match(p[0].message, /unknown server 'shcedule'/);
});

test("two addresses with the same local part collide on one id", () => {
  // jsmith@clemson.edu and jsmith@g.clemson.edu are two rows and one consumer.
  // Minting silently would give one person a token the file says is another's.
  const p = bad(
    HEAD + "Jane,jsmith@clemson.edu,schedule\nJohn,jsmith@g.clemson.edu,schedule\n",
  );
  assert.match(p[0].message, /already taken by line 2/);
});

test("a duplicated address is reported once, as a duplicate", () => {
  const p = bad(HEAD + "Jane,jsmith@clemson.edu,schedule\nJane,jsmith@clemson.edu,schedule\n");
  assert.equal(p.length, 1);
  assert.match(p[0].message, /duplicate of line 2/);
});

test("colliding with a LIVE consumer is refused, never overwritten", () => {
  // One roster row whose local part matched `advisor` would otherwise revoke
  // the running advisor daemon's credential with nothing saying so.
  const p = bad(HEAD + "Ops,advisor@clemson.edu,schedule\n", opts({
    schedule: new Set(["advisor"]),
  }));
  assert.match(p[0].message, /already exists on the schedule registry/);
});

test("a collision on one server does not block an unrelated server", () => {
  const r = ok(HEAD + "Jane,jsmith@clemson.edu,catalog\n");
  assert.equal(r.rows[0].id, "jsmith");
  // same id exists on schedule only; this row asks for catalog
  const r2 = parseRoster(HEAD + "Jane,jsmith@clemson.edu,catalog\n", opts({
    schedule: new Set(["jsmith"]),
  }));
  assert.equal(r2.problems.length, 0);
});

test("EVERY problem is reported in one pass, not one at a time", () => {
  // What makes all-or-nothing bearable at 300 rows is a single pass that names
  // every fault, so the operator fixes once instead of discovering serially.
  const p = bad(
    HEAD +
      "Jane,jane@gmail.com,schedule\n" +
      ",jsmith@clemson.edu,schedule\n" +
      "Bob,bob@clemson.edu,nosuch\n",
  );
  assert.equal(p.length, 3);
  assert.deepEqual(p.map((x) => x.line), [2, 3, 4]);
});

test("problems are ordered by line so the report reads top to bottom", () => {
  const p = bad(HEAD + "A,a@gmail.com,schedule\nB,b@clemson.edu,nope\n");
  assert.ok(p[0].line < p[1].line);
});

test("a missing required column fails before any row is examined", () => {
  const p = bad("name,email\nJane,jsmith@clemson.edu\n");
  assert.equal(p.length, 1);
  assert.match(p[0].message, /missing required column 'servers'/);
});

test("an empty file and a header-only file are both refused", () => {
  assert.match(bad("")[0].message, /empty/);
  assert.match(bad(HEAD)[0].message, /no data rows/);
});

test("blank lines and CRLF are tolerated", () => {
  const r = ok(HEAD.replace("\n", "\r\n") + "\r\nJane,jsmith@clemson.edu,schedule\r\n\r\n");
  assert.equal(r.rows.length, 1);
});

test("a large roster is FLAGGED, never refused", () => {
  const rows = Array.from(
    { length: LARGE_ROSTER + 20 },
    (_, i) => `S${i},s${i}@clemson.edu,schedule`,
  ).join("\n");
  const r = ok(HEAD + rows + "\n");
  assert.equal(r.rows.length, LARGE_ROSTER + 20);
  assert.equal(r.large, true, "should be flagged for a louder review");
  assert.match(rosterSummary(r), /LARGE ROSTER/);
});

test("past the sanity ceiling it refuses, and says it is overridable", () => {
  const rows = Array.from(
    { length: SANITY_CEILING + 1 },
    (_, i) => `S${i},s${i}@clemson.edu,schedule`,
  ).join("\n");
  const p = bad(HEAD + rows + "\n");
  assert.match(p[0].message, /--allow-huge/);
  assert.match(p[0].message, /not a limit on how many people/);
  // and the override actually works
  const r = parseRoster(HEAD + rows + "\n", opts({}, true));
  assert.equal(r.problems.length, 0);
});

test("fingerprint is stable across row order and formatting", () => {
  const a = ok(HEAD + "Jane,jsmith@clemson.edu,schedule\nBob,bob@clemson.edu,catalog\n");
  const b = ok(HEAD + "Bob,bob@clemson.edu,catalog\nJane,jsmith@clemson.edu,schedule\n");
  assert.equal(a.fingerprint, b.fingerprint, "reordering must not change it");
});

test("fingerprint changes when WHO or WHAT changes", () => {
  const base = ok(HEAD + "Jane,jsmith@clemson.edu,schedule\n").fingerprint;
  const other = ok(HEAD + "Jane,jsmith@clemson.edu,catalog\n").fingerprint;
  const person = ok(HEAD + "Jane,jdoe@clemson.edu,schedule\n").fingerprint;
  const named = ok(HEAD + "Jane Q,jsmith@clemson.edu,schedule\n").fingerprint;
  assert.notEqual(base, other, "changing the server must change it");
  assert.notEqual(base, person, "changing the person must change it");
  assert.notEqual(base, named, "changing the displayed name must change it");
});

test("fingerprint ignores line numbers", () => {
  // Otherwise inserting a blank line would invalidate an approval for an
  // identical roster, and operators would learn to ignore fingerprint changes.
  const a = ok(HEAD + "Jane,jsmith@clemson.edu,schedule\n");
  const b = ok(HEAD + "\n\nJane,jsmith@clemson.edu,schedule\n");
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(fingerprintRoster(a.rows), b.fingerprint);
});

test("summary carries count, servers and a fingerprint prefix", () => {
  const r = ok(HEAD + "Jane,jsmith@clemson.edu,schedule\nBob,bob@clemson.edu,catalog\n");
  const s = rosterSummary(r);
  assert.match(s, /2 recipients/);
  assert.match(s, /catalog \+ schedule/);
  assert.match(s, new RegExp(r.fingerprint.slice(0, 12)));
});

// --- Cross-repo contract: mailcal's send-on-decision rejects any recipient
// that is not a single bare address (no commas, semicolons, quotes, angle
// brackets or spaces), returning recipient_not_clemson: invalid. That check
// runs AFTER Chip has approved the decision, so anything this parser lets
// through fails at send time on a spent approval. These assert the parser is
// structurally incapable of emitting such an address — not that it happens
// not to today.
test("no resolved address can carry a character mailcal rejects", () => {
  const hostile = [
    "jane,doe@clemson.edu",
    "jane;doe@clemson.edu",
    '"jane"@clemson.edu',
    "jane<smith>@clemson.edu",
    "Jane Smith <jsmith@clemson.edu>",
    "jsmith@clemson.edu, bob@clemson.edu",
    "jsmith@clemson.edu;bob@clemson.edu",
    "jsmith@clemson.edu>",
  ];
  for (const email of hostile) {
    const r = parseRoster(`${HEAD}Jane,"${email.replace(/"/g, '""')}",schedule\n`, opts());
    assert.equal(r.roster, null, `parser accepted a hostile address: ${email}`);
    // A rejection is only evidence if it is the RIGHT rejection — otherwise a
    // quoting accident in the test could reject the row for an unrelated
    // reason and this would pass while proving nothing.
    assert.ok(
      r.problems.some((p) => p.field === "email"),
      `rejected ${email}, but not on the email field: ${JSON.stringify(r.problems)}`,
    );
  }
});

test("every address the parser emits survives mailcal's shape check", () => {
  // The independent witness: re-derive mailcal's rule here rather than trusting
  // that ours implies it. If either side's rule moves, this fails.
  const MAILCAL_OK = /^[^\s,;"'<>()[\]]+@[^\s,;"'<>()[\]]+$/;
  const r = ok(
    HEAD +
      "Jane,jsmith@clemson.edu,schedule\n" +
      "Bob,b.lee-2@g.clemson.edu,catalog\n" +
      "Amy,a_k99@clemson.edu,schedule\n",
  );
  for (const row of r.rows) {
    assert.match(row.email, MAILCAL_OK, `would be refused at send time: ${row.email}`);
    assert.equal(row.email.trim(), row.email, "address carries surrounding whitespace");
  }
});
