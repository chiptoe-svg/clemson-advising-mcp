// src/mcp-tools/index-catalog.ts
// Public GC curriculum barrel — no credentials. Imported by the
// Tool barrel for the catalog server (src/mcp-catalog.ts): importing this
// registers every catalog tool.
import "./catalog.js";
import "./clemson-advising.js";
// Skill documents for the GC tools above. The catalog entry point narrows
// exposure to CATALOG_SKILLS; the fail-closed default applies until it does.
import "./skills.js";
