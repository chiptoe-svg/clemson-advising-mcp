// src/mcp-schedule.ts
// Public Clemson class-schedule MCP server. Defaults to stdio for local/dev;
// serves HTTP when MCP_TRANSPORT=http. It holds no secrets and only reaches
// Clemson's public Banner API.
//
// AUTH: MCP_SCHEDULE_AUTH_TOKEN, distinct from the catalog server's key and from
// anything on 8765, PLUS this server's own consumer registry
// (state/mcp-consumers-schedule.json, minted with `npm run mcp:pair -- --server
// public --id <agent>`). 8765's registry (the unnamed default path) is still
// never consulted, and the catalog server's registry is a different file, so a
// token minted here works only here and revoking it touches only this server.
// With no key AND an empty registry there are zero consumers and
// resolveCredentialedAuth throws at startup rather than serving open.
//
// Per-agent tokens are what make usage attributable: each call is recorded in
// state/analytics/mcp-calls.jsonl under the matched consumer id, so traffic
// from a paired agent is separable from the shared env token.
//
// BIND: MCP_SCHEDULE_HTTP_HOST (its own variable, default loopback). Set to
// 0.0.0.0 for campus reachability. NOTE: StreamableHTTPServerTransport has no
// Host/Origin validation, so off loopback the bearer is the only gate — there
// is no DNS-rebinding protection to enable.
import "./mcp-tools/index-schedule.js";
import { loadConsumers, recordSeen } from "./mcp-tools/consumers.js";
import { startMcpServer } from "./mcp-tools/server.js";
import {
  MCP_TRANSPORT,
  MCP_SCHEDULE_HTTP_HOST,
  MCP_SCHEDULE_HTTP_PORT,
  MCP_SCHEDULE_AUTH_TOKEN,
} from "./config-mcp.js";

startMcpServer({
  name: "advising-mcp-schedule",
  transport: MCP_TRANSPORT,
  httpHost: MCP_SCHEDULE_HTTP_HOST,
  httpPort: MCP_SCHEDULE_HTTP_PORT,
  auth: {
    kind: "registry",
    envToken: MCP_SCHEDULE_AUTH_TOKEN,
    load: () => loadConsumers("schedule"),
    onSeen: (id) => recordSeen(id, new Date().toISOString(), "schedule"),
  },
}).catch((err) => {
  process.stderr.write(
    `[advising-mcp-schedule] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
