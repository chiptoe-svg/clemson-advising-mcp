// MCP server bootstrap and tool registration.
//
// Pattern mirrors NanoClaw v2's container/agent-runner/src/mcp-tools/server.ts:
// each tool module calls registerTools([...]) at import time; index.ts imports
// each module for side effect, then calls startMcpServer().
//
// AUTH MODEL (HTTP transport)
// ===========================
// The credentialed server authenticates each request against a per-agent token
// REGISTRY (src/mcp-tools/consumers.ts): every authorized agent has its own
// bearer token; the matched consumer id is the audit identity; grant/revoke is
// per-agent. The server FAILS CLOSED — it refuses to start over HTTP with no
// authorized consumers, so an un-provisioned agent on the same host gets
// nothing.
//
// The public (8766) and catalog (8767) servers use the same "registry" auth,
// but with an EMPTY consumer source and a single per-server env key
// (MCP_PUBLIC_AUTH_TOKEN / MCP_CATALOG_AUTH_TOKEN), so each accepts exactly one
// bearer and revoking one does not affect the other or 8765. They are the only
// servers permitted a non-loopback bind (MCP_PUBLIC_HTTP_HOST /
// MCP_CATALOG_HTTP_HOST); 8765 stays on MCP_HTTP_HOST, loopback.
//
// "open" mode (no credentials) remains available for stdio/dev and is still
// refused on a non-loopback bind by assertHttpAuthConfig.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "http";

import {
  authenticateConsumer,
  hashToken,
  loadConsumers,
  type Consumer,
} from "./consumers.js";
import { TOOL_CATEGORY_META_KEY, type McpToolDefinition } from "./types.js";
import {
  allExposedOperations,
  expandScopes,
  isMcpOperationExposed,
} from "./permissions.js";
import { isAgentBackendAuthorized, type DataClass } from "../policy.js";
import { auditContext } from "./audit.js";
import { recordMcpCall } from "./usage.js";
import { serverInstructions } from "./instructions.js";
import {
  SKILLS_DOC_TOOL_META_KEY,
  SKILLS_VERSION_META_KEY,
  currentSkillsVersion,
} from "./surface-version.js";
import { log as appLog } from "../log.js";

/** Reject bodies larger than this on the HTTP transport (local DoS guard). */
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** An authenticator that has not answered within this long denies the request. */
export const AUTH_TIMEOUT_MS = 10_000;

function log(msg: string): void {
  process.stderr.write(`[cuassistant-mcp] ${msg}\n`);
}

// --- Unauthenticated-request accounting ---------------------------------
// The MCP HTTP ports can be campus-bound. Every unauthenticated request used to
// write one line straight to stderr — launchd's never-rotated err.log — at
// ~74 bytes per request with no limit (measured 1.4 GB/day at 215 req/s,
// 2026-08-26 review, F1/S5). Now: 401s are counted per source address in a
// one-minute window, logged through src/log.ts (rotated) at the first hit and
// every LOG_EVERY hits, and a source exceeding UNAUTH_LIMIT in the window gets
// 429 (Retry-After) for the rest of it — a bearer-guessing loop is throttled
// to UNAUTH_LIMIT attempts per minute per address, and the log grows by a
// handful of lines instead of one per attempt.
const UNAUTH_WINDOW_MS = 60_000;
export const UNAUTH_LIMIT = 30;
const LOG_EVERY = 100;
const unauthBySource = new Map<string, { windowStart: number; count: number }>();

export function __resetUnauthTrackerForTest(): void {
  unauthBySource.clear();
}

/** Returns "log" when this hit should be logged, "throttle" when it exceeds the limit, else "silent". */
function noteUnauthenticated(source: string, now: number): "log" | "throttle" | "silent" {
  let entry = unauthBySource.get(source);
  if (!entry || now - entry.windowStart >= UNAUTH_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    unauthBySource.set(source, entry);
    if (unauthBySource.size > 10_000) unauthBySource.clear(); // bounded memory under a spray
  }
  entry.count += 1;
  if (entry.count > UNAUTH_LIMIT) return "throttle";
  if (entry.count === 1 || entry.count % LOG_EVERY === 0) return "log";
  return "silent";
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function shouldRegisterMcpTool(t: Partial<McpToolDefinition>): boolean {
  if (!t.operation) {
    return false;
  }
  return isMcpOperationExposed(t.operation);
}

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (!shouldRegisterMcpTool(t)) {
      log(
        `skipping tool "${t.tool.name}" because operation ` +
          `"${t.operation ?? "(missing)"}" is not active and ` +
          `policy-approved`,
      );
      continue;
    }
    if (!t.category) {
      log(`skipping tool "${t.tool.name}" because it declares no category`);
      continue;
    }
    if (toolMap.has(t.tool.name)) {
      log(`warning: duplicate tool "${t.tool.name}" — skipping`);
      continue;
    }
    t.tool._meta = { ...(t.tool._meta ?? {}), [TOOL_CATEGORY_META_KEY]: t.category };
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

/** Test-only accessor for the module-private registry. */
export function __registeredToolsForTest(): McpToolDefinition[] {
  return allTools;
}

/**
 * Rename an already-registered tool on THIS process only.
 *
 * Tool modules register at import time under fixed names, so a module loaded by
 * two entry points offers the same name on both servers. That is fine until one
 * consumer bridges both: the advisor exposes tools under bare names, so two
 * servers offering `list-skills` is a startup error there (advisor-mcp.ts).
 *
 * Renames both the map key and the advertised name, so dispatch and tools/list
 * stay consistent. Throws on an unknown source name or an occupied target — a
 * rename that silently did nothing would reintroduce the collision it exists to
 * prevent, and one that overwrote a live tool would be worse still.
 *
 * An optional `description` replaces the tool's advertised description too.
 * Two servers can share a module-level tool definition (e.g. skills.ts) but
 * expose genuinely different corpora under the renamed name — without this,
 * the renamed copy keeps the original's text verbatim, including any
 * self-references to the pre-rename name. Omitting it leaves the description
 * untouched, exactly as before this parameter existed.
 */
export function renameRegisteredTool(
  from: string,
  to: string,
  description?: string,
): void {
  const t = toolMap.get(from);
  if (!t) throw new Error(`cannot rename unknown tool "${from}"`);
  if (toolMap.has(to))
    throw new Error(`cannot rename "${from}" to "${to}": already registered`);
  toolMap.delete(from);
  t.tool.name = to;
  if (description !== undefined) t.tool.description = description;
  toolMap.set(to, t);
}

/**
 * The authenticated caller.
 *
 * Shaped for a future in which the credential is an OAuth/OIDC token from a
 * Clemson identity provider rather than a static bearer from our own registry
 * (see docs/superpowers/specs/2026-08-27-mcp-extraction-design.md). Today every
 * field but `id`/`scopes` is optional and the registry authenticator fills only
 * what it knows; the point is that adding a second scheme does not change this
 * type, the handler, or the audit trail.
 *
 * `id` stays the AUDIT identity — what appears in mcp-calls.jsonl — so the usage
 * ledger remains comparable across an auth migration.
 */
export interface Principal {
  /** Audit identity. Registry: the consumer id. OAuth: typically subject or client. */
  id: string;
  scopes: Set<string>;
  /** Attested model backend, checked against policy agent_backends. */
  provider?: string;
  /**
   * WHO, when the credential carries an end user (OAuth `sub`). Distinct from
   * `clientId` (WHAT software) — the registry conflates them because a static
   * token identifies only an agent, and that conflation is exactly what an SSO
   * migration would need to undo.
   */
  subject?: string;
  /** WHAT software is calling (OAuth client_id), when distinguishable. */
  clientId?: string;
  /** Epoch ms after which this principal must not be reused. Registry tokens do not expire. */
  expiresAt?: number;
  /** How the caller authenticated — recorded so a migration is visible in the ledger. */
  authMethod: "registry-token" | "open" | "oauth";
}

/**
 * Context handed to an authenticator. An object rather than a bare header
 * because OAuth needs more than the Authorization value: DPoP binds to method
 * and URL, resource indicators need the request target, and useful audit logs
 * need the source.
 */
export interface AuthContext {
  authHeader: string | undefined;
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  source: string;
}

/**
 * Build an AuthContext from just a bearer header, defaulting the rest.
 *
 * For callers that have no HTTP request to describe — the stdio transport, and
 * tests — so that adding a field to AuthContext does not break every call site.
 */
export function authContext(
  authHeader: string | undefined,
  over: Partial<AuthContext> = {},
): AuthContext {
  return { authHeader, method: "POST", url: "/", headers: {}, source: "local", ...over };
}

/**
 * Authenticates a request; resolves to the Principal, or null to reject.
 *
 * ASYNC ON PURPOSE, though today's registry check is pure computation: every
 * realistic OAuth path is asynchronous (JWKS fetch, token introspection,
 * revocation check). Making this async once, now, costs one `await`; retrofitting
 * it later would touch the request path, both authenticators, and every test.
 */
export type Authenticator = (ctx: AuthContext) => Promise<Principal | null>;

/** Open mode: no credentials (public server, loopback-only). Full public scope. */
export const openAuthenticator: Authenticator = async () => ({
  id: "public",
  scopes: allExposedOperations(),
  authMethod: "open",
});

/**
 * Try each authenticator in order; the first non-null wins.
 *
 * The migration seam: an OAuth authenticator can be placed ahead of the registry
 * one so both credential types work at once, then the registry entry removed
 * when every consumer has moved. Neither the handler nor the tools change.
 */
export function chainAuthenticators(
  authenticators: readonly Authenticator[],
): Authenticator {
  return async (ctx) => {
    for (const a of authenticators) {
      const p = await a(ctx);
      if (p) return p;
    }
    return null;
  };
}

/** Fail closed: open mode is only allowed on a loopback bind. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
export function assertHttpAuthConfig(expected: string, host: string): void {
  if (!expected && !isLoopbackHost(host)) {
    throw new Error(
      `MCP_AUTH_TOKEN is required when MCP_HTTP_HOST is not loopback (got "${host}")`,
    );
  }
}

export interface ResolveAuthOptions {
  /** Optional single token (MCP_AUTH_TOKEN) accepted as an "env-token" consumer. */
  envToken?: string;
  /** Provider attested for the env-token consumer (MCP_AUTH_TOKEN_PROVIDER). */
  envTokenProvider?: string;
  /** Registry loader; defaults to the on-disk registry. Injectable for tests. */
  load?: () => Consumer[];
  /** Called with the consumer id on each successful auth (for last-seen touch). */
  onSeen?: (consumerId: string) => void;
  /**
   * The data class this server serves. Passed to the policy attestation check,
   * so a backend restricted to `public` (policy/action-policy.yaml
   * `agent_backends[].data_classes`) is accepted here only if this server
   * declares itself public.
   *
   * Omitted = undeclared. A restricted backend is REFUSED against an undeclared
   * server — fail closed, so adding a new server without saying what it serves
   * loses access rather than silently inheriting it.
   */
  dataClass?: DataClass;
}

/**
 * Build the credentialed authenticator. THROWS (fail closed) when there are no
 * authorized consumers, so the server never silently runs open. Reloads the
 * registry per call so `mcp:pair`/revoke take effect without a restart.
 */
export function resolveCredentialedAuth(
  opts: ResolveAuthOptions = {},
): Authenticator {
  const load = opts.load ?? loadConsumers;
  const envToken = (opts.envToken ?? "").trim();
  const envTokenProvider = (opts.envTokenProvider ?? "").trim();
  const gather = (): Consumer[] => {
    const live = load();
    if (envToken) {
      live.push({
        id: "env-token",
        token_hash: hashToken(envToken),
        created_at: "",
        provider: envTokenProvider || undefined,
      });
    }
    return live;
  };
  if (gather().length === 0) {
    throw new Error(
      "credentialed MCP HTTP server has no authorized consumers — provision " +
        "one with `npm run mcp:pair -- --id <agent> --provider <p>` (or set " +
        "MCP_AUTH_TOKEN + MCP_AUTH_TOKEN_PROVIDER). Refusing to start open.",
    );
  }
  if (envToken && !envTokenProvider) {
    log(
      "warning: MCP_AUTH_TOKEN is set but MCP_AUTH_TOKEN_PROVIDER is empty — " +
        "the env-token consumer has no provider and will be rejected at auth time.",
    );
  }
  return async (ctx) => {
    const consumer = authenticateConsumer(ctx.authHeader, gather());
    if (!consumer) return null;
    // Runtime attestation re-check (fail closed): the consumer must declare a
    // provider that policy currently authorizes. Flipping authorized:false in
    // policy cuts the agent off on the next request after a process restart
    // (policy is loaded once at process start, like every other policy action).
    if (
      !consumer.provider ||
      !isAgentBackendAuthorized(consumer.provider, opts.dataClass)
    ) {
      log(
        `auth: rejecting "${consumer.id}" — provider ` +
          `"${consumer.provider ?? "(none)"}" not authorized for data class ` +
          `"${opts.dataClass ?? "(undeclared)"}" (model_unauthorized)`,
      );
      return null;
    }
    opts.onSeen?.(consumer.id);
    return {
      id: consumer.id,
      scopes: expandScopes(consumer.scopes),
      provider: consumer.provider,
      // A static registry token identifies an AGENT, not a person, so there is
      // no subject to report. An OAuth authenticator would fill `subject` here,
      // and that difference is deliberately visible rather than papered over.
      clientId: consumer.id,
      authMethod: "registry-token",
    };
  };
}

/** The Tool descriptors whose operation is within `scopes` (for ListTools). */
export function toolsForScope(scopes: Set<string>) {
  return allTools.filter((t) => scopes.has(t.operation)).map((t) => t.tool);
}

/** Whether a registered tool's operation is within `scopes` (for CallTool). */
export function isToolInScope(toolName: string, scopes: Set<string>): boolean {
  const t = toolMap.get(toolName);
  return !!t && scopes.has(t.operation);
}

/** Test seam: buildServer is module-private, but wiring tests must exercise the
 *  real thing (instructions attached, _meta stamped) rather than its parts. */
export function __buildServerForTest(name: string, principal?: Principal): Server {
  return buildServer(name, principal);
}

function buildServer(name: string, principal?: Principal): Server {
  const scopes = principal?.scopes ?? allExposedOperations();
  const consumerId = principal?.id ?? "stdio";
  // `instructions` reaches every client in the initialize response — no tool
  // call, no agent initiative. That is why the guidance that MUST land (the
  // two-store catalog trap, snapshot staleness, untimed sections) lives here
  // rather than only in the skill documents, which measured 8 calls out of 366.
  // Scoped to the tools this principal can actually see.
  const visibleToolNames = toolsForScope(scopes).map((t) => t.name);
  const server = new Server(
    { name, version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: serverInstructions(name, visibleToolNames),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsForScope(scopes),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;
    const tool = toolMap.get(toolName);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }
    if (!scopes.has(tool.operation)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: tool "${toolName}" is not in this agent's scope`,
          },
        ],
        isError: true,
      };
    }
    // Usage accounting BEFORE the handler runs: the question this answers is
    // "who called what, how often", and a call that throws or times out is
    // still a call. Recording after the await would silently under-count
    // exactly the failures worth seeing. Never throws (see usage.ts).
    recordMcpCall({
      server: name,
      consumerId,
      provider: principal?.provider,
      tool: toolName,
      authMethod: principal?.authMethod,
      subject: principal?.subject,
    });
    const result = await auditContext.run(
      { consumerId, provider: principal?.provider },
      () => tool.handler(args ?? {}),
    );
    // Stamp the skills version on EVERY result. A client that cached the skill
    // document compares this against the version it holds and re-fetches when
    // they differ — staleness is detected on a channel it is already reading,
    // with no extra round trip and no cooperation required for the information
    // to be present. See surface-version.ts.
    return {
      ...result,
      _meta: {
        ...(result._meta ?? {}),
        [SKILLS_VERSION_META_KEY]: currentSkillsVersion(),
        [SKILLS_DOC_TOOL_META_KEY]: toolMap.has("get-gc-skill-docs")
          ? "get-gc-skill-docs"
          : "get-skill-docs",
      },
    };
  });
  return server;
}

export function createHttpHandler(
  name: string,
  authenticate: Authenticator,
  opts: { now?: () => number } = {},
): http.RequestListener {
  const now = opts.now ?? Date.now;
  return (req, res) => {
    void (async () => {
    const source = req.socket.remoteAddress ?? "?";
    // The 503 path below covers an authenticator that THROWS. It does not cover
    // one that never settles — a JWKS fetch or introspection call with no
    // timeout — which holds the socket and the handler open indefinitely
    // (verified: neither headersTimeout nor requestTimeout applies, because both
    // measure request RECEIPT, which has already completed). Race it.
    let timer: NodeJS.Timeout | undefined;
    let principal = await Promise.race([
      authenticate({
        authHeader: req.headers.authorization,
        method: req.method ?? "?",
        url: req.url ?? "/",
        headers: req.headers,
        source,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          appLog.warn("mcp auth timed out", { server: name, source });
          resolve(null); // fail CLOSED: a slow authenticator denies, never admits
        }, AUTH_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    // Expiry is enforced HERE, once, rather than inside each authenticator:
    // registry tokens never expire, but OAuth access tokens always do, and a
    // scheme that forgot the check would fail open. Central and unmissable.
    // Reject anything that is not a FINITE, FUTURE number. `NaN <= now()` is
    // false, so the original `!== undefined && <= now()` accepted NaN — and NaN
    // is the single most likely value a real OAuth authenticator produces on a
    // malformed token (`Number(claims.exp)`, `Date.parse(bad)`, and
    // `Number(undefined)` all yield it). Found by adversarial review 2026-08-27
    // in the one check described as "central and unmissable".
    if (principal?.expiresAt !== undefined) {
      const exp = principal.expiresAt;
      if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= now()) {
        appLog.warn("mcp credential expired or malformed", {
          server: name,
          id: principal.id,
          expiresAt: String(exp),
        });
        principal = null;
      }
    }
    if (!principal) {
      const verdict = noteUnauthenticated(source, now());
      if (verdict === "throttle") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        res.end(JSON.stringify({ error: "too many unauthenticated requests" }));
        return;
      }
      if (verdict === "log") {
        appLog.warn("mcp unauthorized request", {
          server: name,
          method: req.method ?? "?",
          source,
          countInWindow: unauthBySource.get(source)?.count ?? 1,
        });
      }
      // RFC 6750 challenge. Correct for plain bearer today, and the exact header
      // an MCP OAuth client expects to discover where to authenticate — a future
      // scheme extends this value rather than adding a new mechanism.
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="${name}"`,
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      const buf = c as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "payload_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (tooLarge) return;
      let body: unknown = undefined;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          /* no body */
        }
      }
      // Stateless MCP: a FRESH server+transport per request. Sharing one
      // stateless transport across requests 500s on the post-initialize
      // notifications/initialized POST (verified by the nanoclaw integration test).
      void (async () => {
        const server = buildServer(name, principal);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      })();
    });
    })().catch((err) => {
      // An authenticator that throws (a JWKS fetch failing, an introspection
      // endpoint timing out) must fail CLOSED and must not take the process
      // down. Today's registry check cannot throw; a future network-backed one
      // certainly can, which is the whole reason this catch exists now.
      appLog.error("mcp auth pipeline failed", {
        server: name,
        err: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "authentication_unavailable" }));
      }
    });
  };
}

export type AuthConfig =
  | { kind: "open" }
  | {
      kind: "registry";
      envToken?: string;
      envTokenProvider?: string;
      onSeen?: (id: string) => void;
      /**
       * Override the consumer source. Defaults to the shared on-disk registry
       * (state/mcp-consumers.json), which is what the credentialed server uses.
       *
       * The public (8766) and catalog (8767) servers pass `() => []` so their
       * ONLY credential is their own envToken. Without this they would inherit
       * every per-agent token minted for 8765 — which would both widen those
       * tokens' reach and break per-server revocation, since removing a key
       * from one server's env would leave the registry tokens still working.
       * It is also what makes the fail-closed check meaningful for them: with
       * an empty registry, a missing env key means zero consumers and
       * resolveCredentialedAuth throws at startup instead of serving open.
       *
       * UPDATE 2026-08-26: 8766/8767 now pass a loader scoped to their OWN
       * registry file (`loadConsumers("public")` / `loadConsumers("catalog")`),
       * not `() => []`. Every guarantee above still holds — the files are
       * per-server, so a token minted for one is not accepted by the other and
       * revocation stays per-server. What changed is only that each server can
       * now have MORE than one credential, so callers are individually
       * identifiable in state/analytics/mcp-calls.jsonl instead of sharing one
       * anonymous env token. 8765's registry (the unnamed default path) is
       * still never consulted here.
       */
      load?: () => Consumer[];
      /** The data class this server serves; see ResolveAuthOptions.dataClass. */
      dataClass?: DataClass;
    };

export interface StartOptions {
  name: string;
  transport?: "stdio" | "http";
  httpHost?: string;
  httpPort?: number;
  auth: AuthConfig;
}

/**
 * Returns the http.Server when the HTTP transport is used (undefined for
 * stdio). Callers in production ignore it; tests need it so a server that
 * wrongly STARTS — the exact failure the fail-closed check exists to prevent —
 * can be closed and reported as a failure, instead of holding the event loop
 * open and hanging the run.
 */
export async function startMcpServer(
  opts: StartOptions,
): Promise<http.Server | undefined> {
  if ((opts.transport ?? "stdio") === "http") {
    const host = opts.httpHost ?? "127.0.0.1";
    const port = opts.httpPort ?? 8765;
    let authenticate: Authenticator;
    let mode: string;
    if (opts.auth.kind === "open") {
      assertHttpAuthConfig("", host);
      authenticate = openAuthenticator;
      mode = "OPEN-loopback (no credentials, public data)";
    } else {
      const load = opts.auth.load ?? loadConsumers;
      authenticate = resolveCredentialedAuth({
        envToken: opts.auth.envToken,
        envTokenProvider: opts.auth.envTokenProvider,
        onSeen: opts.auth.onSeen,
        dataClass: opts.auth.dataClass,
        load,
      });
      const count = load().length + (opts.auth.envToken ? 1 : 0);
      mode = `registry (${count} authorized consumer${count === 1 ? "" : "s"})`;
    }
    const httpServer = http.createServer(
      createHttpHandler(opts.name, authenticate),
    );
    httpServer.listen(port, host, () => {
      log(
        `${opts.name} http on ${host}:${port} — auth: ${mode}; tools: ${allTools
          .map((t) => t.tool.name)
          .join(", ")}`,
      );
    });
    return httpServer;
  }
  const server = buildServer(opts.name);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(
    `${opts.name} stdio started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(", ")}`,
  );
}
