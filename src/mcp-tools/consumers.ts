// Per-consumer credential registry for the two MCP HTTP servers.
//
// Each authorized caller is provisioned its OWN bearer token with
// `npm run mcp:pair -- --server <public|catalog> --id <agent>`. Only the
// SHA-256 hash of each token is stored, in state/mcp-consumers-<server>.json.
// A request is accepted only if the presented bearer hashes to a registered
// consumer; the matched consumer id becomes the identity in the usage ledger.
// Grant = add an entry; revoke = remove it. Each server reads its own file, so
// a token minted for one is not accepted by the other.
//
// Tokens do not expire (an expiry timer would silently sever a working
// integration). Lifecycle is instead explicit revoke plus staleness reporting
// (`staleConsumers`): created_at and last_seen_at make unused tokens visible
// without breaking anything.

import crypto from "crypto";
import fs from "fs";
import path from "path";

import { STATE_DIR } from "../config-mcp.js";

export interface Consumer {
  /** Stable caller identifier, e.g. "advisor". Used as the ledger identity. */
  id: string;
  /** sha256 hex of the bearer token. The raw token is never stored. */
  token_hash: string;
  /** ISO timestamp the token was minted. */
  created_at: string;
  /** ISO timestamp the token was last accepted, when tracked. */
  last_seen_at?: string;
  /** Free-text operator note (e.g. what the agent is for). */
  note?: string;
  /** Capability scope tokens (see SCOPE_OPERATIONS); absent/empty = full access. */
  scopes?: string[];
}

/**
 * Registry file for one server. Each HTTP server keeps its OWN registry so a
 * token minted for one is not accepted by another — preserving the per-server
 * key isolation the env tokens have always had (see src/mcp-public.ts's AUTH
 * note). The unnamed default is the original path, kept for token-portal.ts.
 */
const REGISTRY_PATH = (registry?: string): string =>
  path.join(
    STATE_DIR,
    registry ? `mcp-consumers-${registry}.json` : "mcp-consumers.json",
  );
const DAY_MS = 86_400_000;

/** sha256 hex digest of a token. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf-8").digest("hex");
}

/** Mint a high-entropy, prefixed bearer token. */
export function generateToken(): string {
  return `cma_${crypto.randomBytes(32).toString("base64url")}`;
}

/** Parse a registry document, dropping entries that lack id or token_hash. */
export function parseConsumers(raw: string): Consumer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { consumers?: unknown[] })?.consumers ?? []);
  if (!Array.isArray(list)) return [];
  return list.filter(
    (c): c is Consumer =>
      !!c &&
      typeof (c as Consumer).id === "string" &&
      typeof (c as Consumer).token_hash === "string",
  );
}

/** Load the on-disk registry (empty when the file is absent or unreadable). */
export function loadConsumers(registry?: string): Consumer[] {
  try {
    return parseConsumers(fs.readFileSync(REGISTRY_PATH(registry), "utf-8"));
  } catch {
    return [];
  }
}

/** Persist the registry with owner-only permissions. */
export function saveConsumers(consumers: Consumer[], registry?: string): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  // ATOMIC: write to a temp file in the same directory, then rename. A plain
  // writeFileSync truncates in place, so a concurrent reader sees a partial
  // file — measured at 21% of reads during a write — and parseConsumers
  // swallows the JSON error and returns []. A concurrent read-modify-write
  // (mcp:pair --revoke) then wrote that [] back: an adversarial-review probe
  // destroyed all 3001 seeded entries this way. rename(2) is atomic within a
  // filesystem, so a reader sees either the old file or the new one.
  const target = REGISTRY_PATH(registry);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ consumers }, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
  try {
    fs.chmodSync(REGISTRY_PATH(registry), 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * Constant-time match of a presented `Authorization` header against the
 * registry. Returns the matched Consumer, or null. Compares fixed-length hex
 * digests so the comparison leaks neither the token nor its length.
 *
 * The returned object is a live reference into the caller's `consumers` array —
 * read it, do not mutate it. Persisted changes go through loadConsumers ->
 * mutate -> saveConsumers (see recordSeen).
 */
export function authenticateConsumer(
  authHeader: string | undefined,
  consumers: Consumer[],
): Consumer | null {
  const prefix = "Bearer ";
  if (!authHeader || !authHeader.startsWith(prefix)) return null;
  const got = Buffer.from(hashToken(authHeader.slice(prefix.length)));
  for (const c of consumers) {
    const exp = Buffer.from(c.token_hash);
    if (got.length === exp.length && crypto.timingSafeEqual(got, exp)) {
      return c;
    }
  }
  return null;
}

/** Backward-compatible: returns just the matched consumer id, or null. */
export function authenticateBearer(
  authHeader: string | undefined,
  consumers: Consumer[],
): string | null {
  return authenticateConsumer(authHeader, consumers)?.id ?? null;
}

/** Update a consumer's last_seen_at (best effort; no-op for unknown ids). */
// last_seen_at is a staleness signal measured in DAYS (staleConsumers), so it
// does not need second-level precision — and paying a full registry
// read-modify-write per authenticated request to get it is the kind of cost
// that only bites once the system succeeds. Writes are debounced per consumer:
// at most one every SEEN_DEBOUNCE_MS. Under sustained load this turns one file
// rewrite per request into one per consumer per hour.
const SEEN_DEBOUNCE_MS = 3_600_000; // 1 hour
const lastSeenWrite = new Map<string, number>();

/** Test seam: forget the debounce state. */
export function __resetSeenDebounceForTest(): void {
  lastSeenWrite.clear();
}

export function recordSeen(
  id: string,
  nowIso: string,
  registry?: string,
  nowMs: number = Date.now(),
): void {
  const key = `${registry ?? ""}:${id}`;
  const last = lastSeenWrite.get(key);
  if (last !== undefined && nowMs - last < SEEN_DEBOUNCE_MS) return;
  try {
    const list = loadConsumers(registry);
    const c = list.find((x) => x.id === id);
    if (!c) return; // e.g. the synthetic "env-token" is not on disk
    c.last_seen_at = nowIso;
    saveConsumers(list, registry);
    // Only after a SUCCESSFUL write: a consumer absent from disk (the synthetic
    // env-token) returns above without marking, so it never suppresses a real
    // write should that id later be paired.
    lastSeenWrite.set(key, nowMs);
  } catch {
    /* best effort */
  }
}

export interface StaleOptions {
  nowMs: number;
  /** Flag tokens minted more than this many days ago. */
  maxAgeDays: number;
  /** Flag tokens not used within this many days (never-seen counts from created_at). */
  maxIdleDays: number;
}

export interface StaleConsumer {
  id: string;
  reason: "age" | "idle";
  ageDays: number;
  idleDays: number;
}

/**
 * Report tokens worth rotating/revoking: too old, or unused too long. This is
 * the warn-don't-break form of "expiry alerting" — it never rejects a token,
 * it only surfaces staleness for a deliberate rotation decision.
 */
export function staleConsumers(
  consumers: Consumer[],
  opts: StaleOptions,
): StaleConsumer[] {
  const out: StaleConsumer[] = [];
  for (const c of consumers) {
    const created = Date.parse(c.created_at);
    const lastSeen = c.last_seen_at ? Date.parse(c.last_seen_at) : created;
    const ageDays = Number.isNaN(created)
      ? 0
      : Math.floor((opts.nowMs - created) / DAY_MS);
    const idleDays = Number.isNaN(lastSeen)
      ? 0
      : Math.floor((opts.nowMs - lastSeen) / DAY_MS);
    if (ageDays > opts.maxAgeDays) {
      out.push({ id: c.id, reason: "age", ageDays, idleDays });
    } else if (idleDays > opts.maxIdleDays) {
      out.push({ id: c.id, reason: "idle", ageDays, idleDays });
    }
  }
  return out;
}
