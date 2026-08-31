// src/mcp-tools/catalog-skill-renames.ts
// Side-effect-free source of truth for the catalog-specific renames of the
// catalog server's (8767) `list-skills`/`get-skill-docs` copies.
//
// skills.js is loaded by BOTH the public barrel and the catalog barrel, so
// both servers advertised `list-skills`/`get-skill-docs` under the same
// names with byte-identical text. src/mcp-catalog.ts renames the catalog's
// copies (not the public server's — `list-skills` meant the public server's
// skills before this server had any, and the advisor's prompt and the
// shipped skill documents refer to it under that name) and gives them
// catalog-specific descriptions, since skills.ts's original text self-refers to
// the public server's tool names, which is wrong on 8767.
//
// (The renamed pair carried a gc- prefix until 2026-08-31; the catalog covers
// all seven College of Business programs, so the prefix was misleading and
// every gc- tool name was dropped in the same pass.)
//
// This module does NOT import mcp-catalog.ts or call startMcpServer() — it
// only imports renameRegisteredTool from server.ts — so it is safe to import
// from a unit test without binding a port or opening a stdio transport.
import { renameRegisteredTool } from "./server.js";
import { setSkillListToolName } from "./skills.js";

export interface CatalogSkillRename {
  from: string;
  to: string;
  description: string;
}

export const CATALOG_SKILL_RENAMES: readonly CatalogSkillRename[] = [
  {
    from: "list-skills",
    to: "list-catalog-skills",
    description:
      "List the catalog server's skill documents by name and " +
      "description. Pass a name to get-catalog-skill-docs to retrieve the full " +
      "content.",
  },
  {
    from: "get-skill-docs",
    to: "get-catalog-skill-docs",
    description:
      "Return the full documentation for a catalog-server " +
      "skill by name. Use list-catalog-skills to discover available skill names.",
  },
];

/** Applies every catalog skill-tool rename in CATALOG_SKILL_RENAMES, in order. */
export function applyCatalogSkillRenames(): void {
  for (const { from, to, description } of CATALOG_SKILL_RENAMES) {
    renameRegisteredTool(from, to, description);
    // Runtime error strings must follow the advertised name too — renaming the
    // tool while its own errors point at the old name is how 8767 came to tell
    // callers to use a tool it does not have.
    if (from === "list-skills") setSkillListToolName(to);
  }
}
