// Server instructions — the "here is how to use me" document every client
// receives ONCE, automatically, in the MCP initialize response.
//
// WHY THIS EXISTS (2026-08-27, owner suggestion): these servers already ship
// skill documents behind list-skills / get-skill-docs, but that is opt-in
// discovery — an agent has to already suspect the docs exist and then spend two
// calls fetching them. Measured reality: 8 calls out of 366. Most clients never
// look, so the guidance may as well not be there.
//
// MCP's `instructions` field solves the delivery problem the skill tools cannot:
// it is part of InitializeResult, so it arrives at connection time whether or
// not the agent thinks to ask, and costs no tool call. The skill tools remain
// for depth; this is the part that must reach EVERY client.
//
// CONTENT RULE: this text is prepended to a model's context on every session
// with this server. It must earn its tokens. Put here only what a competent
// agent would otherwise get WRONG — not a tool listing (the client already has
// tools/list with full descriptions), and not prose about what Clemson is.
// Each line below traces to an observed failure.

import crypto from "crypto";

/**
 * A short, stable fingerprint of the exposed tool surface. Clients that cache
 * these instructions can compare it across connections and re-read only when it
 * changes — the "or when toolsets have changed" half of the one-time-fetch idea.
 * Derived from tool NAMES only, so a description edit does not churn the hash
 * while adding, removing, or renaming a tool does.
 */
export function toolsetVersion(toolNames: readonly string[]): string {
  return crypto
    .createHash("sha256")
    .update([...toolNames].sort().join("\n"), "utf-8")
    .digest("hex")
    .slice(0, 12);
}

const SHARED = `
These tools return published Clemson data. Every answer you give from them
should be traceable to what they returned — do not supplement from memory, and
do not infer a fact the tools did not state. Each response carries a \`_source\`.
`.trim();

const PUBLIC_GUIDANCE = `
This server serves the CLASS SCHEDULE (sections, meeting times, instructors,
seats) for a given term.

What agents get wrong here:

- SCHEDULE DATA IS A DATED SNAPSHOT, not live Banner. Seat counts and section
  lists were true when the snapshot was taken. Call \`get-schedule-freshness\`
  before making any claim about seat availability, and state the as-of time when
  you do. Never tell a student a seat is open without it.
- SECTIONS WITH NO MEETING TIME EXIST (online, asynchronous, arranged). Any
  day/time filter silently excludes them. If a student asks for "afternoon
  classes", untimed sections are not absent from the catalog — they are absent
  from your filter. Say so.
- TERMS ARE EXPLICIT. Resolve the term with \`list-clemson-terms\` rather than
  assuming the current one; "fall" is ambiguous in August.
`.trim();

const CATALOG_GUIDANCE = `
This server serves the DEGREE CATALOG (program plans, requirement rules, General
Education, prerequisites) for the College of Business programs.

What agents get wrong here — the first point is the one that has actually caused
a wrong answer to a real advisor:

- A PROGRAM'S REQUIREMENTS LIVE IN TWO SEPARATE STORES. The named requirement
  slots (lab science, specialty area, technical, REACH) come from
  \`get-gc-requirement-rules\`. Everything else — most required courses, and all
  one-of choice slots — lives in the semester plan from \`get-gc-program-plan\`.
  NEITHER tool sees the other's data.
  Therefore: a course absent from one of them is NOT absent from the degree.
  To answer "does this program require X" or "what is the X requirement", call
  \`find-course-in-program\`, which searches BOTH and whose not-found IS
  authoritative. (Observed failure, 2026-08-27: an advisor asked about the PCID
  requirement; the rules tool answered without mentioning PCID, and the reply
  was "no such requirement exists". PCID 3040/3140 is a real 3-credit choice
  slot in the plan.)
- PROGRAM AND CATALOG YEAR ARE REQUIRED and there is no default program. Eight
  programs exist; if you were not told which, ask rather than assuming. If the
  session supplied one by assumption rather than choice, say which you used.
- PREREQUISITE ELIGIBILITY IS THREE-VALUED, not yes/no. \`find-requirement-sections\`
  returns \`prereqEligible: "eligible" | "not_eligible" | "undetermined"\`.
  "undetermined" is the honest answer for a rule the structured data cannot
  decide — an OR ("ECON 2000 or ECON 2110 or ECON 2120"), a grade minimum, a
  standing or consent gate, or a text that did not parse. That is roughly a
  third of courses with prerequisites. NEVER report a student ineligible on an
  "undetermined": read \`prereqText\` and tell them what the rule says.
- AUDIT VERDICTS FOR NON-GC PROGRAMS ARE ADVISORY. Confirm against DegreeWorks.
- REQUIREMENTS ARE PER CATALOG YEAR. A student follows the catalog they entered
  under, which is often not the newest.
`.trim();

/**
 * The instructions document for one server. `name` is the server name passed to
 * buildServer ("advising-mcp-public" / "advising-mcp-catalog").
 */
export function serverInstructions(
  name: string,
  toolNames: readonly string[],
): string {
  const specific = name.includes("catalog")
    ? CATALOG_GUIDANCE
    : PUBLIC_GUIDANCE;
  return [
    specific,
    "",
    SHARED,
    "",
    `Toolset version: ${toolsetVersion(toolNames)} (${toolNames.length} tools).`,
    "These instructions change only when the toolset does; cache them against",
    "that version and re-read when it differs.",
    "",
    "SKILL DOCUMENTS AND STALENESS. `list-skills` / `get-skill-docs` (named",
    "`list-gc-skills` / `get-gc-skill-docs` on the catalog server) carry longer",
    "worked examples. Fetch them ONCE and reuse them — but every tool result",
    'carries `_meta["cuassistant/skillsVersion"]`, a digest of the skill',
    "documents' content. Record it when you fetch the docs; if a later result",
    "shows a different value, your copy is out of date — re-fetch it with the",
    'tool named in `_meta["cuassistant/skillsDocTool"]`. The version changes',
    "only when the documents' CONTENT changes, so it will not churn.",
  ].join("\n");
}
