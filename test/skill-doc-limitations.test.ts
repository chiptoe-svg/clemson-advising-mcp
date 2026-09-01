// A limitations section is a list of ABSENCE CLAIMS, and absence claims rot:
// a bullet saying "there is no instructor tool" outlived get-instructor-classes
// by three days and sent live models paging search-classes to a round cap
// (2026-09-01 advisor transcripts). No parser can tell a stale "there is no X"
// from a true one, so the guard is procedural: every served skill document
// that carries a limitations section must carry a stamp pairing it with the
// toolsets it was reviewed against. Tool set changes -> this test fails ->
// a person re-reads the limitations -> updates the stamp.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { toolsetVersion } from "../src/mcp-tools/instructions.ts";

async function served(name: string): Promise<string[]> {
  const { __buildServerForTest } = await import("../src/mcp-tools/server.ts");
  const server = __buildServerForTest(name);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "limitations", version: "1" }, {});
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

function skillDocs(): string[] {
  const roots = ["skills", path.join("core", "skills")];
  const out: string[] = [];
  for (const root of roots) {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(root, e.name, "SKILL.md");
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

test("every served skill doc with a limitations section carries a current review stamp", async () => {
  // Schedule tools alone first, then the catalog barrel with its renames —
  // the same load order the drift test uses; the catalog set is the remainder.
  await import("../src/mcp-tools/index-schedule.ts");
  const sched = await served("advising-mcp-schedule");
  await import("../src/mcp-tools/index-catalog.ts");
  const { applyCatalogSkillRenames } =
    await import("../src/mcp-tools/catalog-skill-renames.ts");
  applyCatalogSkillRenames();
  const cat = (await served("advising-mcp-catalog")).filter(
    (n) => !sched.includes(n),
  );
  const expected = `limitations-reviewed-against: schedule=${toolsetVersion(
    sched,
  )} catalog=${toolsetVersion(cat)}`;

  let stamped = 0;
  for (const doc of skillDocs()) {
    const body = fs.readFileSync(doc, "utf-8");
    if (!/^## (Known l|L)imitations/m.test(body)) continue;
    const m = /limitations-reviewed-against: (\S+ \S+)/.exec(body);
    assert.ok(
      m,
      `${doc} has a limitations section but no review stamp — add:\n` +
        `<!-- ${expected} -->`,
    );
    assert.equal(
      `limitations-reviewed-against: ${m![1]}`,
      expected,
      `${doc}: the toolset changed since its limitations section was last ` +
        `reviewed. RE-READ that section — an absence claim ("there is no ` +
        `X") may have just become false — fix any, then update the stamp ` +
        `to:\n<!-- ${expected} -->`,
    );
    stamped += 1;
  }
  // If this drops to zero the guard is dead, not satisfied.
  assert.ok(stamped >= 1, "no served skill doc carries a limitations section");
});
