#!/usr/bin/env -S npx tsx
// Health check for the two MCP servers. Exit 0 healthy, 1 degraded, 2 down.
//
//   npm run health:check
//   npm run health:check -- --json      # for a monitor
//
// WHAT IT CHECKS, and why each one is here rather than a generic "is it up":
//
//   listening   A 401 proves routing, the listener, and the auth path. A 200
//               without a token is WORSE than being down — it means the server
//               is serving open — so that case reports DOWN, not healthy.
//   tools       The startup line is the only place the loaded tool list
//               appears. A server that restarted before a tool change was
//               saved serves the old build and fails silently.
//   freshness   The most common failure here is not a crash. It is the servers
//               answering confidently from a snapshot that stopped being true.
//               Nothing else in this check would notice.
//
// It deliberately does NOT need a bearer token: everything above is observable
// without one, and a health check that holds a credential is a health check
// that can leak one.

import fs from "node:fs";
import path from "node:path";
import {
  MCP_SCHEDULE_HTTP_PORT,
  MCP_CATALOG_HTTP_PORT,
  CATALOG_DB,
} from "../src/config-mcp.js";

const json = process.argv.includes("--json");
const SNAPSHOT_DIR = path.resolve("state/clemson");
/**
 * Snapshots are per-term SQLite files (`202608.db`), with `.json.gz` kept as
 * the raw fetch. An earlier version of this check globbed `*.json`, found
 * nothing, and reported DOWN against a perfectly healthy system — a monitor
 * would have paged someone. "I looked in the wrong place" must never render as
 * "there is nothing there".
 */
const SNAPSHOT_EXTS = [".db", ".json.gz"];
/**
 * Where the startup line lives. `{which}` is "schedule" or "catalog". A pattern
 * rather than a prefix because log naming is a deployment choice, and a prefix
 * cannot express every shape someone has already chosen.
 */
const LOG_PATTERN =
  process.env.MCP_LOG_PATTERN || "advising-mcp.{which}.err.log";
/** A daily refresh plus a full day of slack. Beyond this, someone should look. */
const STALE_HOURS = 36;

type Check = { name: string; status: "ok" | "warn" | "down"; detail: string };
const checks: Check[] = [];
const add = (name: string, status: Check["status"], detail: string) =>
  checks.push({ name, status, detail });

async function probe(which: string, port: number): Promise<void> {
  let code: number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
      signal: AbortSignal.timeout(5000),
    });
    code = res.status;
  } catch (e) {
    add(
      `${which}:listening`,
      "down",
      `no answer on ${port} (${(e as Error).message})`,
    );
    return;
  }
  if (code === 401) add(`${which}:listening`, "ok", `401 on ${port}`);
  else if (code === 200)
    add(
      `${which}:listening`,
      "down",
      `200 UNAUTHENTICATED on ${port} — serving open`,
    );
  else add(`${which}:listening`, "down", `${code} on ${port}, expected 401`);

  // The tool list lives only in the startup line.
  const log = path.join(
    process.env.HOME ?? "",
    "Library/Logs",
    LOG_PATTERN.replace("{which}", which),
  );
  try {
    const lines = fs.readFileSync(log, "utf-8").trimEnd().split("\n");
    const last = [...lines].reverse().find((l) => l.includes("tools:"));
    const n = last ? (last.split("tools:")[1] ?? "").split(",").length : 0;
    if (n > 0) add(`${which}:tools`, "ok", `${n} tools loaded`);
    else add(`${which}:tools`, "warn", "no startup line with a tool list");
  } catch {
    add(`${which}:tools`, "warn", `cannot read ${log}`);
  }
}

function checkFreshness(): void {
  let newest = 0;
  try {
    for (const f of fs.readdirSync(SNAPSHOT_DIR)) {
      if (!SNAPSHOT_EXTS.some((e) => f.endsWith(e))) continue;
      const m = fs.statSync(path.join(SNAPSHOT_DIR, f)).mtimeMs;
      if (m > newest) newest = m;
    }
  } catch {
    add(
      "schedule:freshness",
      "down",
      `no snapshot directory at ${SNAPSHOT_DIR}`,
    );
    return;
  }
  if (newest === 0) {
    add(
      "schedule:freshness",
      "down",
      "no snapshots — run: npm run clemson:refresh",
    );
    return;
  }
  const hours = (Date.now() - newest) / 3_600_000;
  const age = `${hours.toFixed(1)}h old`;
  if (hours > STALE_HOURS)
    add(
      "schedule:freshness",
      "warn",
      `${age} — the daily refresh is not running`,
    );
  else add("schedule:freshness", "ok", age);
}

function checkCatalogDb(): void {
  try {
    const s = fs.statSync(CATALOG_DB);
    // Present but empty is the interesting case: the catalog server answers
    // with nothing rather than failing, which reads as "no such program".
    if (s.size < 1_000_000)
      add(
        "catalog:db",
        "warn",
        `${CATALOG_DB} is only ${s.size} bytes — truncated?`,
      );
    else add("catalog:db", "ok", `${(s.size / 1e6).toFixed(1)} MB`);
  } catch {
    add("catalog:db", "down", `missing: ${CATALOG_DB}`);
  }
}

await probe("schedule", MCP_SCHEDULE_HTTP_PORT);
await probe("catalog", MCP_CATALOG_HTTP_PORT);
checkFreshness();
checkCatalogDb();

const worst = checks.some((c) => c.status === "down")
  ? "down"
  : checks.some((c) => c.status === "warn")
    ? "warn"
    : "ok";

if (json) {
  console.log(JSON.stringify({ status: worst, checks }, null, 2));
} else {
  for (const c of checks) {
    const mark =
      c.status === "ok" ? "ok  " : c.status === "warn" ? "WARN" : "DOWN";
    console.log(`  ${mark}  ${c.name.padEnd(22)} ${c.detail}`);
  }
  console.log(`\n${worst.toUpperCase()}`);
}
process.exit(worst === "ok" ? 0 : worst === "warn" ? 1 : 2);
