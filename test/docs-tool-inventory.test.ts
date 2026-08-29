// docs/overview.md lists every tool each server serves. This fails when a tool
// is added, removed, or renamed without the page changing — the page describes
// tools rather than being generated from them, so this is what keeps it honest.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

async function served(name: string): Promise<string[]> {
  const { __buildServerForTest } = await import("../src/mcp-tools/server.ts");
  const server = __buildServerForTest(name);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inventory", version: "1" }, {});
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

/** Tool names under one "### <Server> server" section: every `#### \`name\`` heading, split on " · ". */
function documented(section: string): string[] {
  const doc = fs.readFileSync("docs/overview.md", "utf-8");
  const start = doc.indexOf(`### ${section}`);
  assert.ok(start >= 0, `docs/overview.md has no "### ${section}" section`);
  const rest = doc.slice(start + 1);
  const next = rest.search(/\n### /);
  const body = next === -1 ? rest : rest.slice(0, next);
  const names: string[] = [];
  for (const m of body.matchAll(/^#### (.+)$/gm)) {
    for (const part of m[1].split(" · ")) {
      const name = part.trim().replace(/^`|`$/g, "");
      if (name) names.push(name);
    }
  }
  return names.sort();
}

// Both barrels register into ONE process-wide registry, so this file loads them
// in the order the real servers would see them: the schedule tools alone first,
// then the catalog tools with the same skill-tool rename mcp-catalog.ts applies.
test("docs/overview.md documents exactly the tools the schedule server serves", async () => {
  await import("../src/mcp-tools/index-public.ts");
  assert.deepEqual(documented("Schedule server"), await served("advising-mcp-public"));
});

test("docs/overview.md documents exactly the tools the catalog server serves", async () => {
  await import("../src/mcp-tools/index-catalog.ts");
  const { applyGcSkillRenames } = await import("../src/mcp-tools/gc-skill-renames.ts");
  applyGcSkillRenames();
  const live = (await served("advising-mcp-catalog")).filter((n) => !PUBLIC_ONLY.has(n));
  assert.deepEqual(documented("Catalog server"), live);
});

// Tools the schedule barrel registers that the catalog server never serves.
// Loading both barrels in one process puts them in one registry; the real
// catalog process only ever imports its own barrel.
const PUBLIC_ONLY = new Set([
  "list-clemson-terms", "search-classes", "find-alternatives", "check-conflicts",
  "get-course-details", "find-conflict-free-schedule", "get-schedule-freshness",
  "get-sections-by-crn", "resolve-crns",
]);
