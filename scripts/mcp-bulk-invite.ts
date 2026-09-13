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

import { parseRoster, rosterSummary, MINTABLE_SERVERS, type Server } from "../src/bulk-invite.js";
import { loadConsumers } from "../src/mcp-tools/consumers.js";
import { isValidScopeToken } from "../src/mcp-tools/permissions.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const allowHuge = args.includes("--allow-huge");

if (!file) {
  process.stderr.write(
    "usage: npm run mcp:bulk-invite -- <roster.csv> [--allow-huge]\n" +
      "  CSV header: name,email,servers[,scopes][,note]\n" +
      `  servers: ${MINTABLE_SERVERS.join(" or ")} (space, | or ; separated)\n`,
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

const existing: Partial<Record<Server, Set<string>>> = {};
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
w(`  ${pad("ID", 16)}${pad("EMAIL", 30)}${pad("NAME", 22)}${pad("SERVERS", 18)}SCOPES\n`);
w(`  ${"-".repeat(94)}\n`);
for (const r of roster.rows) {
  w(
    `  ${pad(r.id, 16)}${pad(r.email, 30)}${pad(r.name, 22)}` +
      `${pad(r.servers.join("+"), 18)}${r.scopes.join(",")}\n`,
  );
}

w(`\n  ${rosterSummary(roster)}\n`);
w(`  fingerprint: ${roster.fingerprint}\n`);

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
