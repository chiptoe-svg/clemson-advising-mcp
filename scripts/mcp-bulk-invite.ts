#!/usr/bin/env -S npx tsx
// Preview and validate a roster of people to be granted MCP access.
//
//   npm run mcp:bulk-invite -- roster.csv
//   npm run mcp:bulk-invite -- roster.csv --allow-huge
//
// CSV: a header row with name, email, servers and optionally scopes, note.
//
//   name,email,servers,note
//   Jane Smith,jsmith@clemson.edu,schedule,MKT 3010 Fall 2026
//
// WHAT THIS DOES TODAY: parse, validate, and print the resolved roster with a
// fingerprint. It mints nothing and sends nothing — issuance waits on the
// approvals daemon, at which point this same resolved roster becomes the body
// of ONE approval request.
//
// WHY PREVIEW IS ITS OWN STEP rather than a --dry-run flag on a minting
// command: the failure this guards against is a file that PARSES differently
// than it reads — a shifted column swapping names and emails, a quoted comma
// splitting a row. That is invisible in a summary line and obvious in a table.
// The fingerprint then binds the approval to this exact parse, so tapping
// approve cannot authorize content other than what was reviewed here.
import fs from "fs";

import {
  parseRoster,
  rosterSummary,
  MINTABLE_SERVERS,
  DELEGATED_SERVERS,
  type MintableServer,
} from "../src/bulk-invite.js";
import { loadConsumers } from "../src/mcp-tools/consumers.js";
import { isValidScopeToken } from "../src/mcp-tools/permissions.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const allowHuge = args.includes("--allow-huge");

if (!file) {
  process.stderr.write(
    "usage: npm run mcp:bulk-invite -- <roster.csv> [--allow-huge]\n" +
      "  CSV header: name,email,servers[,scopes][,note]\n" +
      `  servers: ${[...MINTABLE_SERVERS, ...DELEGATED_SERVERS].join(", ")} ` +
      `(space, | or ; separated)\n` +
      `  ${DELEGATED_SERVERS.join("/")} are RECORDED here and issued by the ` +
      `gc_alumni repo's --from-decision\n`,
  );
  process.exit(2);
}

let text: string;
try {
  text = fs.readFileSync(file, "utf-8");
} catch (e) {
  process.stderr.write(`error: cannot read ${file}: ${String(e)}\n`);
  process.exit(2);
}

const existing: Partial<Record<MintableServer, Set<string>>> = {};
for (const s of MINTABLE_SERVERS) {
  existing[s] = new Set(loadConsumers(s).map((c) => c.id));
}

const { roster, problems } = parseRoster(text, {
  existing,
  allowHuge,
  isValidScope: isValidScopeToken,
});

if (!roster) {
  process.stderr.write(
    `\n${problems.length} problem${problems.length === 1 ? "" : "s"} in ${file} — nothing was written.\n\n`,
  );
  for (const p of problems) {
    const where = p.line > 0 ? `line ${p.line}` : "file";
    process.stderr.write(`  ${where.padEnd(9)} ${p.field.padEnd(8)} ${p.message}\n`);
  }
  process.stderr.write(
    `\nEvery problem found is listed above — fix them together and re-run.\n` +
      `No approval was requested, so a rejected roster costs nothing.\n`,
  );
  process.exit(1);
}

const w = (s: string) => process.stdout.write(s);
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

w(`\n${file}: ${roster.rows.length} recipients, all valid.\n\n`);
w(`  ${pad("ID", 16)}${pad("EMAIL", 30)}${pad("NAME", 22)}${pad("SERVERS", 26)}SCOPES\n`);
w(`  ${"-".repeat(102)}\n`);
for (const r of roster.rows) {
  w(
    `  ${pad(r.id, 16)}${pad(r.email, 30)}${pad(r.name, 22)}` +
      `${pad(r.servers.join("+"), 26)}${r.scopes.join(",") || "—"}\n`,
  );
}

w(`\n  ${rosterSummary(roster)}\n`);
w(`  fingerprint: ${roster.fingerprint}\n`);

for (const old of roster.renamed) {
  w(`\n  note: '${old}' was renamed 2026-09-13 — recorded as its current name.\n`);
}

if (roster.hasDelegated) {
  const rows = roster.rows.filter((r) => r.delegated.length);
  w(
    `\n  DELEGATED — ${rows.length} of ${roster.rows.length} rows grant a server\n` +
      `  this tool CANNOT issue. They are recorded in the approval and minted\n` +
      `  by the gc_alumni repo, which owns those registries:\n\n`,
  );
  for (const r of rows) {
    const scoped = r.alumniScopes.length ? ` [${r.alumniScopes.join(",")}]` : "";
    w(`    ${pad(r.id, 16)}${pad(r.email, 30)}${r.delegated.join("+")}${scoped}\n`);
  }
  if (rows.some((r) => r.delegated.includes("gc_alumni"))) {
    // TWO THINGS THIS BLOCK MUST NOT IMPLY, both of which an earlier draft did.
    //
    // 1. That gc_alumni serves the stripped copy. It NO LONGER DOES. It was
    //    pointed at alumni_public.db from June as containment for a server
    //    that had no auth; the per-consumer retrofit (2026-09-13) removed the
    //    reason and it was flipped back to the full working database the same
    //    day. Contact PII is now in reach of any grant.
    // 2. That a narrower scope reduces data reach. It does not: `query` —
    //    arbitrary read-only SELECT over the whole database — is inside
    //    gc.alumni.research, so research and full access read exactly the same
    //    rows. The scope hides four pipeline tools whose answers are
    //    meaningless to a faculty member. It is a CONFUSION control.
    //
    // Together those made the previous text reassuring about the wrong things,
    // in front of the operator, on every roster. Counts verified live
    // 2026-09-13; magnitudes are given rather than exact figures, because a
    // stale number inside a safety warning is its own defect.
    w(
      `\n  ⚠  gc_alumni serves the FULL WORKING DATABASE (changed 2026-09-13),\n` +
        `     not the published copy. A grant reaches CONTACT PII for roughly\n` +
        `     3,100 people: email and personal phone for over half, plus CUID\n` +
        `     and reported salary for hundreds — alongside names, employers,\n` +
        `     grad year, LinkedIn URLs and photos.\n` +
        `\n     SCOPE DOES NOT NARROW THIS. gc.alumni.research hides the 4\n` +
        `     pipeline tools and nothing else; both scopes read every record,\n` +
        `     via query. Narrow for fewer confusing tools, never for less\n` +
        `     exposure. There is no scope today that restricts data reach.\n`,
    );
  }
  if (rows.some((r) => r.delegated.includes("gc_careers"))) {
    w(
      `\n  gc_careers reads the PUBLISHED copy (alumni_public.db): no email,\n` +
        `  phone, CUID or salary, verified 0 non-null. It names graduates by\n` +
        `  design through company and location searches, filtered against\n` +
        `  opt-out and capped — safer by what it withholds, not by being\n` +
        `  aggregate-only. No scope layer, so grants are whole by construction.\n`,
    );
  }
}

if (roster.large) {
  w(
    `\n  ⚠  LARGE ROSTER — ${roster.rows.length} people in one approval.\n` +
      `     Read the table above, not just this line. A shifted column swaps\n` +
      `     names and emails and still looks entirely plausible here.\n`,
  );
}

w(
  `\n  Nothing has been minted or sent. Issuance waits on the approvals daemon;\n` +
    `  when it lands, this exact roster (fingerprint above) becomes the body of\n` +
    `  ONE approval request, and the tokens are minted only after you approve.\n\n`,
);
