#!/usr/bin/env -S npx tsx
// Mint, list, and revoke per-agent bearer tokens for the public (8766) and
// catalog (8767) MCP servers.
//
//   npm run mcp:pair -- --server public  --id claude-code --provider anthropic
//   npm run mcp:pair -- --server catalog --id claude-code --provider anthropic
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
// tool or policy changes; see src/mcp-server.md.)

import {
  generateToken,
  hashToken,
  loadConsumers,
  saveConsumers,
  type Consumer,
} from "../src/mcp-tools/consumers.js";
import { getAgentBackends } from "../src/policy.js";

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
        `${c.id}\tprovider=${c.provider ?? "(none)"}\tcreated=${c.created_at}` +
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
const provider = flag("provider");
if (!id) fail("--id <agent> is required");
if (!provider) fail("--provider <backend> is required (it is checked against policy at auth time)");

// Fail EARLY on a provider policy will reject, rather than minting a token that
// silently 401s on first use. The data-class dimension is not re-checked here:
// policy is the authority at auth time, and this is a convenience guard.
const declared = getAgentBackends().find((b) => b.provider === provider);
if (!declared) {
  fail(
    `provider '${provider}' is not declared in policy/action-policy.yaml agent_backends ` +
      `(declared: ${getAgentBackends().map((b) => b.provider).join(", ")})`,
  );
}
if (!declared.authorized) {
  fail(`provider '${provider}' is declared but authorized: false — pairing it would 401`);
}
if (declared.data_classes && !declared.data_classes.includes("public")) {
  fail(
    `provider '${provider}' is restricted to data classes ` +
      `[${declared.data_classes.join(", ")}] and both MCP servers serve 'public'`,
  );
}

if (consumers.some((c) => c.id === id)) {
  fail(`consumer '${id}' already exists on ${registry} — revoke it first to rotate`);
}

const token = generateToken();
const entry: Consumer = {
  id,
  token_hash: hashToken(token),
  created_at: new Date().toISOString(),
  provider,
  ...(flag("note") ? { note: flag("note") } : {}),
};
saveConsumers([...consumers, entry], registry);

process.stdout.write(
  `paired '${id}' on ${registry} (provider=${provider})\n\n` +
    `  Authorization: Bearer ${token}\n\n` +
    `This token is shown ONCE and is not recoverable. It works only on the ` +
    `${registry} server and takes effect on the next request.\n`,
);
