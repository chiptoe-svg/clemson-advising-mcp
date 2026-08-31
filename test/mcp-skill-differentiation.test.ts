// Regression test for the byte-identical `list-skills`/`get-skill-docs` copies
// that src/mcp-catalog.ts renames onto the catalog server (8767) as
// `list-catalog-skills`/`get-catalog-skill-docs`.
//
// Before this fix, the rename moved the name but kept the text verbatim, so:
//   1. A model holding both servers' tool lists could not tell the two
//      corpora apart (8766 = public advising skill; 8767 = GC advisor
//      skills) — the descriptions read identically.
//   2. get-catalog-skill-docs said "Use list-skills to discover available skill
//      names" — the OTHER server's tool, not its own sibling
//      list-catalog-skills.
//
// This test validates the REAL shipped renames, not a hand-copied duplicate
// of them. src/mcp-catalog.ts is not imported directly: that module calls
// startMcpServer() at load time (binds a port / opens a stdio transport),
// which is not safe to trigger from a unit test. Instead this loads the same
// barrel mcp-catalog.ts loads (index-catalog.ts, which registers list-skills
// / get-skill-docs under their bare public names) and then calls the REAL
// applyCatalogSkillRenames() from catalog-skill-renames.ts — the exact function
// mcp-catalog.ts calls at module load — so a regression in either the
// override text or the rename mechanism itself is caught. If someone edits
// the shipped override text in catalog-skill-renames.ts (e.g. reintroduces the
// get-catalog-skill-docs -> "list-skills" pointer bug), this test must fail.

import assert from "node:assert/strict";
import test from "node:test";

import "../src/mcp-tools/index-catalog.ts";
import {
  registerTools,
  renameRegisteredTool,
} from "../src/mcp-tools/server.ts";
import { __skillTools } from "../src/mcp-tools/skills.ts";
import {
  CATALOG_SKILL_RENAMES,
  applyCatalogSkillRenames,
} from "../src/mcp-tools/catalog-skill-renames.ts";
import type { McpToolDefinition } from "../src/mcp-tools/types.ts";

/** Tool.description is optional on the SDK type; every tool here always sets it. */
function requireDescription(t: McpToolDefinition): string {
  assert.ok(
    typeof t.tool.description === "string",
    `expected "${t.tool.name}" to have a description`,
  );
  return t.tool.description as string;
}

function renameFor(to: string) {
  const rename = CATALOG_SKILL_RENAMES.find((r) => r.to === to);
  assert.ok(
    rename,
    `expected CATALOG_SKILL_RENAMES to contain a rename targeting "${to}"`,
  );
  return rename;
}

// Capture the public server's descriptions BEFORE renaming: applyCatalogSkillRenames
// mutates the tool objects __skillTools references in place, so reading these
// after the rename would just return the new (catalog) text.
const publicListSkillsDescription = requireDescription(__skillTools.listSkills);
const publicGetSkillDocsDescription = requireDescription(
  __skillTools.getSkillDocs,
);

// The REAL renames, applied exactly as src/mcp-catalog.ts applies them at
// module load — no hand-copied duplicate of the override text here.
applyCatalogSkillRenames();

// The catalog copies must SAY they are the catalog server's — the gc- prefix
// (and GC-flavored description text) was dropped 2026-08-31 when every gc-
// tool name went; the differentiation requirement itself is unchanged.
const CATALOG_PHRASE = /catalog server|catalog-server/;

test("list-catalog-skills is renamed and its description matches CATALOG_SKILL_RENAMES and differs from the public list-skills text", () => {
  assert.equal(__skillTools.listSkills.tool.name, "list-catalog-skills");
  const desc = requireDescription(__skillTools.listSkills);
  assert.equal(
    desc,
    renameFor("list-catalog-skills").description,
    "the registered description must equal CATALOG_SKILL_RENAMES's description",
  );
  assert.notEqual(
    desc,
    publicListSkillsDescription,
    "list-catalog-skills must not carry the public server's byte-identical text",
  );
  assert.match(desc, CATALOG_PHRASE);
});

test("get-catalog-skill-docs is renamed and its description matches CATALOG_SKILL_RENAMES and differs from the public get-skill-docs text", () => {
  assert.equal(__skillTools.getSkillDocs.tool.name, "get-catalog-skill-docs");
  const desc = requireDescription(__skillTools.getSkillDocs);
  assert.equal(
    desc,
    renameFor("get-catalog-skill-docs").description,
    "the registered description must equal CATALOG_SKILL_RENAMES's description",
  );
  assert.notEqual(
    desc,
    publicGetSkillDocsDescription,
    "get-catalog-skill-docs must not carry the public server's byte-identical text",
  );
  assert.match(desc, CATALOG_PHRASE);
});

test("get-catalog-skill-docs points at its own sibling, not the public server's tool", () => {
  const desc = requireDescription(__skillTools.getSkillDocs);
  // "list-catalog-skills" contains neither the substring "list-skills" nor
  // "get-skill-docs" (the "-gc-" infix breaks both), so a plain .includes
  // check is safe here and cannot pass by accident via the new name.
  assert.ok(
    desc.includes("list-catalog-skills"),
    `expected a self-consistent pointer to list-catalog-skills, got: ${desc}`,
  );
  assert.ok(
    !desc.includes("list-skills"),
    `must not reference the OTHER server's tool "list-skills", got: ${desc}`,
  );
});

// ---------------------------------------------------------------------------
// Unit test for renameRegisteredTool's 3-arg form.
// ---------------------------------------------------------------------------

test("renameRegisteredTool: the 3-arg form replaces the description; the 2-arg form does not", () => {
  const twoArg: McpToolDefinition = {
    operation: "clemson.list_terms",
    category: "meta",
    tool: {
      name: "x-rename-2arg",
      description: "original description",
      inputSchema: { type: "object" },
    },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
  const threeArg: McpToolDefinition = {
    operation: "host.list_skills",
    category: "meta",
    tool: {
      name: "x-rename-3arg",
      description: "original description",
      inputSchema: { type: "object" },
    },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
  registerTools([twoArg, threeArg]);

  renameRegisteredTool("x-rename-2arg", "x-rename-2arg-renamed");
  renameRegisteredTool(
    "x-rename-3arg",
    "x-rename-3arg-renamed",
    "new description",
  );

  assert.equal(twoArg.tool.name, "x-rename-2arg-renamed");
  assert.equal(
    twoArg.tool.description,
    "original description",
    "2-arg rename must not touch the description",
  );

  assert.equal(threeArg.tool.name, "x-rename-3arg-renamed");
  assert.equal(
    threeArg.tool.description,
    "new description",
    "3-arg rename must replace the description",
  );
});
