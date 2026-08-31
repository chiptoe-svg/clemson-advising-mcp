#!/usr/bin/env -S npx tsx
// Turn an APPROVED access request (.github/ISSUE_TEMPLATE/access-request.yml
// → a GitHub issue) into working tokens, in one command:
//
//   npm run mcp:grant -- --user jsmith --servers schedule,catalog --note "issue #12"
//
// For each requested server it mints a consumer (id = the username) with the
// DEFAULT scope for that server — clemson.schedule / clemson.catalog — which
// deliberately excludes the departmental layer and the legacy broad scope;
// pass --scopes explicitly to grant more (e.g. clemson.department for an
// advisor). Then it prints ONE copy-paste delivery block: the token(s), the
// URLs, and a ready client config. The raw tokens are never stored (sha256
// only, same as mcp-pair) and take effect on the next request — no restart.
//
// This is a convenience wrapper; mcp-pair remains the primitive (list, revoke,
// rotate, unscoped grants). Revoking a grant made here:
//   npm run mcp:pair -- --server <server> --revoke <username>

import {
  generateToken,
  hashToken,
  loadConsumers,
  saveConsumers,
  type Consumer,
} from "../src/mcp-tools/consumers.js";
import { isValidScopeToken } from "../src/mcp-tools/permissions.js";

type Server = "schedule" | "catalog";
const DEFAULT_SCOPE: Record<Server, string> = {
  schedule: "clemson.schedule",
  catalog: "clemson.catalog",
};

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const user = flag("user");
if (!user) fail("--user <clemson-username> is required");
if (!/^[a-z][a-z0-9_-]*$/i.test(user))
  fail(`--user must be a bare username, got "${user}"`);

const serversRaw = flag("servers") ?? "";
const servers = serversRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean) as Server[];
if (servers.length === 0)
  fail("--servers is required: schedule, catalog, or schedule,catalog");
for (const s of servers)
  if (s !== "schedule" && s !== "catalog")
    fail(`unknown server "${s}" — schedule or catalog`);

const scopesRaw = flag("scopes");
const explicitScopes = scopesRaw
  ? scopesRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : undefined;
if (explicitScopes) {
  const unknown = explicitScopes.filter((s) => !isValidScopeToken(s));
  if (unknown.length > 0) fail(`unknown scope(s): ${unknown.join(", ")}`);
}

const note = flag("note");
// The public URL of the TLS proxy (deploy/Caddyfile.example). Not committed to
// git, so it comes from the environment or a flag; the placeholder keeps the
// delivery block honest rather than silently wrong.
const baseUrl =
  flag("base-url") ??
  process.env.MCP_PUBLIC_BASE_URL ??
  "https://<your-proxy-host>:8443";

// Refuse before minting anything if ANY server already has this id — a
// half-applied grant (minted on one server, failed on the other) would need
// manual cleanup.
for (const s of servers) {
  if (loadConsumers(s).some((c) => c.id === user))
    fail(
      `consumer '${user}' already exists on ${s} — revoke first to rotate:\n` +
        `  npm run mcp:pair -- --server ${s} --revoke ${user}`,
    );
}

const minted: { server: Server; token: string; scopes: string[] }[] = [];
for (const s of servers) {
  const scopes = explicitScopes ?? [DEFAULT_SCOPE[s]];
  const token = generateToken();
  const entry: Consumer = {
    id: user,
    token_hash: hashToken(token),
    created_at: new Date().toISOString(),
    scopes,
    ...(note ? { note } : {}),
  };
  saveConsumers([...loadConsumers(s), entry], s);
  minted.push({ server: s, token, scopes });
}

const lines: string[] = [];
lines.push(`granted '${user}' on: ${servers.join(", ")}`);
for (const m of minted)
  lines.push(`  ${m.server}: scopes ${m.scopes.join(", ")}`);
lines.push("");
lines.push("--- deliver everything below this line to the requester ---");
lines.push("");
lines.push("Your Clemson advising MCP access is ready. Each server has its");
lines.push("own token; they are shown ONCE and cannot be recovered — if one");
lines.push("is lost or leaks, say so and a replacement is minted in seconds.");
lines.push("");
for (const m of minted) {
  lines.push(`${m.server.toUpperCase()} server`);
  lines.push(`  URL:    ${baseUrl}/${m.server}/`);
  lines.push(`  Header: Authorization: Bearer ${m.token}`);
  lines.push("");
}
lines.push("Claude Desktop / Claude Code config (mcpServers):");
lines.push("");
const cfg: Record<string, unknown> = {};
for (const m of minted)
  cfg[`clemson-${m.server}`] = {
    type: "http",
    url: `${baseUrl}/${m.server}/`,
    headers: { Authorization: `Bearer ${m.token}` },
  };
lines.push(JSON.stringify(cfg, null, 2));
lines.push("");
lines.push("The servers are read-only and serve published Clemson data.");
lines.push("Usage is logged under your consumer id, and calls are");
lines.push("rate-limited. The token is personal — please don't share it.");
process.stdout.write(lines.join("\n") + "\n");
