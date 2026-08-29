// Configuration for the two public MCP servers — and ONLY for them.
//
// WHY THIS FILE EXISTS (2026-08-27): src/config.ts declares everything this
// repo needs — advisor model pins, Banner credentials, benchmark knobs, the
// token portal — and the MCP servers need 16 of those values. When the servers
// are extracted into their own repository
// (docs/superpowers/specs/2026-08-27-mcp-extraction-design.md) they must not
// drag the rest along: the extracted repo is public for IT review, and a config
// module full of unrelated credentials names would be both confusing and a
// standing invitation to copy something across.
//
// So the split happens HERE first, under this repo's full test suite, and the
// extraction becomes a file copy rather than a rewrite. src/config.ts re-exports
// everything below, so nothing in this repo changed or needs to know.
//
// RULE FOR EDITORS: a value belongs here only if one of the two MCP servers
// reads it. Anything advisor-, benchmark-, mail-, or portal-related belongs in
// config.ts. If you find yourself adding a model pin or an API key here, it is
// the wrong file.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// .env IS LOADED HERE, not in config.ts. This module is config.ts's dependency,
// so it evaluates FIRST — and a module that reads process.env at evaluation
// time before .env is loaded silently gets empty strings. That is exactly what
// happened when the split was first made: every value below came back "" and
// test/advisor-mcp.test.ts caught it with "cu_public must send an
// Authorization header". Whichever config module evaluates first must load the
// file; that module is this one.
//
// Keys already present in the real environment always win, so a launchd plist
// or an explicit export still overrides .env.
function loadDotEnv(): void {
  const p = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    if (m[0].trimStart().startsWith("#")) continue;
    const [, key, raw] = m;
    if (key in process.env) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, "");
  }
}
loadDotEnv();

// Repo root, derived from this file's location (src/config-mcp.ts → ..), NOT
// from process.cwd(): the daemons run with WorkingDirectory=<repo>, but tests,
// scripts, and dist/ builds do not, and the core/ paths below must be stable
// regardless. (dist/config-mcp.js → .. is also the repo root.)
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const STATE_DIR = path.resolve(
  process.env.STATE_DIR || path.join(process.cwd(), "state"),
);

// --- Transport -------------------------------------------------------------
// "stdio" (default, local/dev) or "http" (served over the network).
export const MCP_TRANSPORT = (
  process.env.MCP_TRANSPORT === "http" ? "http" : "stdio"
) as "stdio" | "http";

// --- Bind hosts and ports --------------------------------------------------
// Each server gets its OWN bind variable, defaulting to loopback, so no server
// can inherit an off-loopback bind from another. Campus exposure terminates TLS
// in a reverse proxy in front; these stay on loopback.
export const MCP_PUBLIC_HTTP_HOST =
  process.env.MCP_PUBLIC_HTTP_HOST || "127.0.0.1";
export const MCP_CATALOG_HTTP_HOST =
  process.env.MCP_CATALOG_HTTP_HOST || "127.0.0.1";
export const MCP_PUBLIC_HTTP_PORT = Number(
  process.env.MCP_PUBLIC_HTTP_PORT || 8766,
);
export const MCP_CATALOG_HTTP_PORT = Number(
  process.env.MCP_CATALOG_HTTP_PORT || 8767,
);

// --- Trusted reverse proxies -----------------------------------------------
// Addresses whose `X-Forwarded-For` this server will believe. Everything else
// is attributed to the socket peer, so a client cannot claim to be someone
// else by sending the header itself.
//
// WHY (observed 2026-08-28): with the servers on loopback behind the campus
// TLS proxy, `req.socket.remoteAddress` is 127.0.0.1 for EVERY caller. A real
// request from the campus network through
// https://gcworkflow.clemson.edu:8443/cu_schedule/ logged
// `source: "127.0.0.1"` — which reads as "a local caller" but means "we did
// not look". That is the silence-read-as-absence class again, and it costs two
// concrete things: the audit log attributes nothing, and the per-source
// unauthenticated throttle (UNAUTH_LIMIT/min) collapses into ONE shared bucket,
// so a single scanner at the front door 429s every other client and the
// throttle can no longer target the abuser.
//
// Loopback by default, because that is where a reverse proxy on the same host
// connects from. Set this only for a proxy on another address, and set it to
// the PROXY's address — never to a client range.
export const MCP_TRUSTED_PROXIES = (
  process.env.MCP_TRUSTED_PROXIES || "127.0.0.1,::1,::ffff:127.0.0.1"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// --- Credentials -----------------------------------------------------------
// Per-server bearer keys. Each server accepts only its own key plus its own
// consumer registry (state/mcp-consumers-<server>.json), so rotating or
// revoking one has no effect on the other.
export const MCP_PUBLIC_AUTH_TOKEN = process.env.MCP_PUBLIC_AUTH_TOKEN || "";
export const MCP_CATALOG_AUTH_TOKEN = process.env.MCP_CATALOG_AUTH_TOKEN || "";

// Attested model backend for those keys; must be authorized in
// policy/action-policy.yaml under agent_backends, for this server's data class,
// or auth is rejected. NOTE the default: an unset variable attests
// "openai_api", which is how an Anthropic-backed agent reached these servers
// under an OpenAI attestation before 2026-08-27. Set it explicitly per
// deployment rather than relying on this.
export const MCP_PUBLIC_AUTH_TOKEN_PROVIDER =
  process.env.MCP_PUBLIC_AUTH_TOKEN_PROVIDER || "openai_api";
export const MCP_CATALOG_AUTH_TOKEN_PROVIDER =
  process.env.MCP_CATALOG_AUTH_TOKEN_PROVIDER || "openai_api";

// --- Catalog core (core/) --------------------------------------------------
// The catalog data and the Python that BUILDS it. Since the SQL-in-Node port
// (2026-08-27) the serving path reads GC_ADVISOR_DB directly and never spawns
// Python; GC_ADVISOR_PYTHON/QUERY are retained for the differential test and
// for tooling, and GC_ADVISOR_AUDIT for audit-gc-progress, which is still a
// Python shell-out. A serving-only deployment needs the DB and the skills, not
// the interpreter.
const CORE_DIR = path.join(REPO_ROOT, "core");
export const GC_ADVISOR_DB =
  process.env.GC_ADVISOR_DB || path.join(CORE_DIR, "db", "gc_advisor.db");
export const GC_ADVISOR_PYTHON =
  process.env.GC_ADVISOR_PYTHON || path.join(CORE_DIR, ".venv", "bin", "python");
export const GC_ADVISOR_QUERY =
  process.env.GC_ADVISOR_QUERY || path.join(CORE_DIR, "scripts", "query.py");
export const GC_ADVISOR_AUDIT =
  process.env.GC_ADVISOR_AUDIT || path.join(CORE_DIR, "scripts", "audit.py");
// core/ also owns the SKILL.md documents that describe how to drive the
// catalog tools. They are read in place: the tree that owns the data owns its
// documentation.
export const GC_ADVISOR_SKILLS =
  process.env.GC_ADVISOR_SKILLS || path.join(CORE_DIR, "skills");
