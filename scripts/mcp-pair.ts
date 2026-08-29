#!/usr/bin/env -S npx tsx
// Mint, list, and revoke per-agent bearer tokens for the public (8766) and
// catalog (8767) MCP servers.
//
//   npm run mcp:pair -- --server public  --id claude-code
//   npm run mcp:pair -- --server catalog --id claude-code
//   npm run mcp:pair -- --server public  --list
//   npm run mcp:pair -- --server public  --revoke claude-code
//
// The raw token is printed ONCE and never stored — only its sha256 hash goes
// into state/mcp-consumers-<server>.json (0600). Losing it means minting a new
// one, which is the intended failure mode.
//
// Each server has its OWN registry file, so a token minted for `public` is not
// accepted by `catalog`. Pair an agent that needs both against both.
//
// The server reloads its registry on every request, so a mint or revoke takes
// effect on the NEXT call — no daemon restart needed. (A restart IS needed for
// tool or policy changes; see docs/operations.md §5.)

import {
  generateToken,
  hashToken,
  loadConsumers,
  saveConsumers,
  type Consumer,
} from "../src/mcp-tools/consumers.js";

type Server = "public" | "catalog";

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const server = flag("server");
if (server !== "public" && server !== "catalog") {
  fail("--server must be 'public' or 'catalog'");
}
const registry: Server = server;

const consumers = loadConsumers(registry);

// --- list -------------------------------------------------------------------
if (has("list")) {
  if (consumers.length === 0) {
    process.stdout.write(
      `no paired consumers for '${registry}' (the env token still works)\n`,
    );
  } else {
    for (const c of consumers) {
      process.stdout.write(
        `${c.id}\tcreated=${c.created_at}` +
          `\tlast_seen=${c.last_seen_at ?? "never"}${c.note ? `\t${c.note}` : ""}\n`,
      );
    }
  }
  process.exit(0);
}

// --- revoke -----------------------------------------------------------------
const revokeId = flag("revoke");
if (revokeId) {
  const next = consumers.filter((c) => c.id !== revokeId);
  if (next.length === consumers.length) fail(`no consumer '${revokeId}' on ${registry}`);
  saveConsumers(next, registry);
  process.stdout.write(`revoked '${revokeId}' on ${registry}; effective on the next request\n`);
  process.exit(0);
}

// --- mint -------------------------------------------------------------------
const id = flag("id");
if (!id) fail("--id <agent> is required");

if (consumers.some((c) => c.id === id)) {
  fail(`consumer '${id}' already exists on ${registry} — revoke it first to rotate`);
}

const token = generateToken();
const entry: Consumer = {
  id,
  token_hash: hashToken(token),
  created_at: new Date().toISOString(),
  ...(flag("note") ? { note: flag("note") } : {}),
};
saveConsumers([...consumers, entry], registry);

process.stdout.write(
  `paired '${id}' on ${registry}\n\n` +
    `  Authorization: Bearer ${token}\n\n` +
    `This token is shown ONCE and is not recoverable. It works only on the ` +
    `${registry} server and takes effect on the next request.\n`,
);
