// Minting at reveal: this repo's registries directly, gc_alumni's via /claim.
//
// NOTHING IS MINTED AHEAD OF TIME. A raw token exists only inside the response
// that shows it, so there is no store of credentials to compromise and no TTL'd
// holding area. That is why the reveal triggers the mint rather than collecting
// something minted earlier.
//
// NO ATOMICITY BETWEEN THE HALVES, deliberately. If schedule mints and
// gc_careers fails, the person gets schedule now and is told plainly that
// careers did not land. Coordinating a rollback across two repos would add a
// failure mode worse than the one it prevents — and a partial result the page
// NAMES is recoverable, while a silent one is not.
import fs from "fs";
import path from "path";

import {
  generateToken,
  hashToken,
  loadConsumers,
  saveConsumers,
} from "../mcp-tools/consumers.js";
import type { Grant } from "./reveal-page.js";

/** Registries this process writes itself. */
const LOCAL = new Set(["schedule", "catalog"]);

/** Human labels. The server id is shown too, but a person needs the plain name. */
const LABEL: Record<string, string> = {
  schedule: "Clemson class schedule",
  catalog: "Clemson degree catalog",
  gc_alumni: "GC alumni records",
  gc_careers: "GC graduate careers",
};

const PUBLIC_BASE =
  process.env.MCP_PUBLIC_BASE ?? "https://gcworkflow.clemson.edu:8443";
const PUBLIC_PATH: Record<string, string> = {
  schedule: "/cu_schedule/",
  catalog: "/cu_catalog/",
};

const CLAIM_URL = process.env.GC_CLAIM_URL ?? "http://127.0.0.1:8014/claim";
const CLAIM_KEY_FILE =
  process.env.GC_CLAIM_KEY_FILE ??
  path.join(process.env.HOME ?? "", ".cuassistant", "gc-claim-portal.token");

/**
 * Read the claim key from disk at CALL time, not module load.
 *
 * So a rotation takes effect without restarting the portal, and so a missing
 * key fails one reveal loudly instead of preventing startup — the local half
 * still works, and the page names what did not.
 */
function claimKey(): string {
  return fs.readFileSync(CLAIM_KEY_FILE, "utf-8").trim();
}

export interface MintFailure {
  server: string;
  label: string;
  /** Shown to the person. Never a raw error body. */
  message: string;
  /** Logged, not rendered. */
  detail: string;
}

export interface MintOutcome {
  grants: Grant[];
  failures: MintFailure[];
}

/** Mint one of this repo's registries. */
function mintLocal(
  server: string,
  consumerId: string,
  scopes: string[],
): Grant {
  const token = generateToken();
  const consumers = loadConsumers(server);
  if (consumers.some((c) => c.id === consumerId)) {
    // Refuse rather than overwrite — the same guard mcp:pair has. A collision
    // here means the roster check passed and something else minted since.
    throw new Error(`consumer '${consumerId}' already exists on ${server}`);
  }
  consumers.push({
    id: consumerId,
    token_hash: hashToken(token),
    created_at: new Date().toISOString(),
    ...(scopes.length ? { scopes } : {}),
    note: "issued via the access portal",
  });
  saveConsumers(consumers, server);
  return {
    server: server === "schedule" ? "cu_schedule" : "cu_catalog",
    label: LABEL[server] ?? server,
    url: `${PUBLIC_BASE}${PUBLIC_PATH[server]}`,
    token,
    scopeSummary: scopes.length ? scopes.join(", ") : null,
  };
}

/** Claim one of gc_alumni's registries. url and disclosure come from there. */
async function mintDelegated(
  server: string,
  consumerId: string,
): Promise<Grant> {
  const res = await fetch(CLAIM_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Portal-Key": claimKey() },
    body: JSON.stringify({ consumer_id: consumerId, server }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const reason = String(body.reason ?? body.error ?? res.status);
    throw new Error(`${res.status} ${reason}`);
  }
  return {
    server,
    label: LABEL[server] ?? server,
    // Both from their side on purpose: they own the path (/gc_public became
    // /gc_careers) and the disclosure figures.
    url: String(body.url),
    token: String(body.token),
    scopeSummary:
      Array.isArray(body.scopes) && body.scopes.length
        ? (body.scopes as string[]).join(", ")
        : null,
    disclosure:
      typeof body.disclosure === "string" ? body.disclosure : undefined,
  };
}

/**
 * Mint every granted server. Never throws: a failure on one server is reported
 * alongside the tokens that did land, because the alternative is a person
 * holding nothing and not knowing which half broke.
 */
export async function mintAll(
  servers: string[],
  consumerId: string,
  authScopes: Record<string, string[]>,
): Promise<MintOutcome> {
  const grants: Grant[] = [];
  const failures: MintFailure[] = [];
  // Sorted so the page's order does not depend on roster order.
  for (const server of [...servers].sort()) {
    const label = LABEL[server] ?? server;
    try {
      if (LOCAL.has(server)) {
        grants.push(mintLocal(server, consumerId, authScopes[server] ?? []));
      } else {
        grants.push(await mintDelegated(server, consumerId));
      }
    } catch (e) {
      failures.push({
        server,
        label,
        message:
          `${label} could not be issued. Nothing is wrong with the access you ` +
          `were granted — this is a fault on our side. Ask for it to be reissued.`,
        detail: String(e),
      });
    }
  }
  return { grants, failures };
}
