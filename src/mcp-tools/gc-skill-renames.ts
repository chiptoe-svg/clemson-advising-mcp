// src/mcp-tools/gc-skill-renames.ts
// Side-effect-free source of truth for the GC-specific renames of the
// catalog server's (8767) `list-skills`/`get-skill-docs` copies.
//
// skills.js is loaded by BOTH the public barrel and the catalog barrel, so
// both servers advertised `list-skills`/`get-skill-docs` under the same
// names with byte-identical text. src/mcp-catalog.ts renames the catalog's
// copies (not the public server's — `list-skills` meant the public server's
// skills before this server had any, and the advisor's prompt and the
// shipped skill documents refer to it under that name) and gives them
// GC-specific descriptions, since skills.ts's original text self-refers to
// the public server's tool names, which is wrong on 8767.
//
// This module does NOT import mcp-catalog.ts or call startMcpServer() — it
// only imports renameRegisteredTool from server.ts — so it is safe to import
// from a unit test without binding a port or opening a stdio transport.
import { renameRegisteredTool } from "./server.js";
import { setSkillListToolName } from "./skills.js";

export interface GcSkillRename {
  from: string;
  to: string;
  description: string;
}

export const GC_SKILL_RENAMES: readonly GcSkillRename[] = [
  {
    from: "list-skills",
    to: "list-gc-skills",
    description:
      "List the GC advisor's skill documents by name and " +
      "description. Pass a name to get-gc-skill-docs to retrieve the full " +
      "content.",
  },
  {
    from: "get-skill-docs",
    to: "get-gc-skill-docs",
    description:
      "Return the full documentation for a GC advisor " +
      "skill by name. Use list-gc-skills to discover available skill names.",
  },
];

/** Applies every GC skill-tool rename in GC_SKILL_RENAMES, in order. */
export function applyGcSkillRenames(): void {
  for (const { from, to, description } of GC_SKILL_RENAMES) {
    renameRegisteredTool(from, to, description);
    // Runtime error strings must follow the advertised name too — renaming the
    // tool while its own errors point at the old name is how 8767 came to tell
    // callers to use a tool it does not have.
    if (from === "list-skills") setSkillListToolName(to);
  }
}
