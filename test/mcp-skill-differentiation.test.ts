// Regression test for the byte-identical `list-skills`/`get-skill-docs` copies
// that src/mcp-catalog.ts renames onto the catalog server (8767) as
// `list-gc-skills`/`get-gc-skill-docs`.
//
// Before this fix, the rename moved the name but kept the text verbatim, so:
//   1. A model holding both servers' tool lists could not tell the two
//      corpora apart (8766 = public advising skill; 8767 = GC advisor
//      skills) — the descriptions read identically.
//   2. get-gc-skill-docs said "Use list-skills to discover available skill
//      names" — the OTHER server's tool, not its own sibling
//      list-gc-skills.
//
// This test validates the REAL shipped renames, not a hand-copied duplicate
// of them. src/mcp-catalog.ts is not imported directly: that module calls
// startMcpServer() at load time (binds a port / opens a stdio transport),
// which is not safe to trigger from a unit test. Instead this loads the same
// barrel mcp-catalog.ts loads (index-catalog.ts, which registers list-skills
// / get-skill-docs under their bare public names) and then calls the REAL
// applyGcSkillRenames() from gc-skill-renames.ts — the exact function
// mcp-catalog.ts calls at module load — so a regression in either the
// override text or the rename mechanism itself is caught. If someone edits
// the shipped override text in gc-skill-renames.ts (e.g. reintroduces the
// get-gc-skill-docs -> "list-skills" pointer bug), this test must fail.

import assert from "node:assert/strict";
import test from "node:test";

import "../src/mcp-tools/index-catalog.ts";
import { registerTools, renameRegisteredTool } from "../src/mcp-tools/server.ts";
import { __skillTools } from "../src/mcp-tools/skills.ts";
import {
  GC_SKILL_RENAMES,
  applyGcSkillRenames,
} from "../src/mcp-tools/gc-skill-renames.ts";
import type { McpToolDefinition } from "../src/mcp-tools/types.ts";

/** Tool.description is optional on the SDK type; every tool here always sets it. */
function requireDescription(t: McpToolDefinition): string {
  assert.ok(typeof t.tool.description === "string", `expected "${t.tool.name}" to have a description`);
  return t.tool.description as string;
}

function renameFor(to: string) {
  const rename = GC_SKILL_RENAMES.find((r) => r.to === to);
  assert.ok(rename, `expected GC_SKILL_RENAMES to contain a rename targeting "${to}"`);
  return rename;
}

// Capture the public server's descriptions BEFORE renaming: applyGcSkillRenames
// mutates the tool objects __skillTools references in place, so reading these
// after the rename would just return the new (GC) text.
const publicListSkillsDescription = requireDescription(__skillTools.listSkills);
const publicGetSkillDocsDescription = requireDescription(__skillTools.getSkillDocs);

// The REAL renames, applied exactly as src/mcp-catalog.ts applies them at
// module load — no hand-copied duplicate of the override text here.
applyGcSkillRenames();

const GC_PHRASE = /Graphic Communications|GC advisor/;

test("list-gc-skills is renamed and its description matches GC_SKILL_RENAMES and differs from the public list-skills text", () => {
  assert.equal(__skillTools.listSkills.tool.name, "list-gc-skills");
  const desc = requireDescription(__skillTools.listSkills);
  assert.equal(
    desc,
    renameFor("list-gc-skills").description,
    "the registered description must equal GC_SKILL_RENAMES's description",
  );
  assert.notEqual(
    desc,
    publicListSkillsDescription,
    "list-gc-skills must not carry the public server's byte-identical text",
  );
  assert.match(desc, GC_PHRASE);
});

test("get-gc-skill-docs is renamed and its description matches GC_SKILL_RENAMES and differs from the public get-skill-docs text", () => {
  assert.equal(__skillTools.getSkillDocs.tool.name, "get-gc-skill-docs");
  const desc = requireDescription(__skillTools.getSkillDocs);
  assert.equal(
    desc,
    renameFor("get-gc-skill-docs").description,
    "the registered description must equal GC_SKILL_RENAMES's description",
  );
  assert.notEqual(
    desc,
    publicGetSkillDocsDescription,
    "get-gc-skill-docs must not carry the public server's byte-identical text",
  );
  assert.match(desc, GC_PHRASE);
});

test("get-gc-skill-docs points at its own sibling, not the public server's tool", () => {
  const desc = requireDescription(__skillTools.getSkillDocs);
  // "list-gc-skills" contains neither the substring "list-skills" nor
  // "get-skill-docs" (the "-gc-" infix breaks both), so a plain .includes
  // check is safe here and cannot pass by accident via the new name.
  assert.ok(
    desc.includes("list-gc-skills"),
    `expected a self-consistent pointer to list-gc-skills, got: ${desc}`,
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
    tool: {
      name: "x-rename-2arg",
      description: "original description",
      inputSchema: { type: "object" },
    },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
  const threeArg: McpToolDefinition = {
    operation: "mail.list_messages",
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
