// Server instructions delivered in InitializeResult (2026-08-27).
//
// The skill tools (list-skills / get-skill-docs) are opt-in discovery and were
// called 8 times in 366 real tool calls — most clients never look. MCP's
// `instructions` field arrives at connection time whether the agent asks or
// not, so the guidance that MUST land lives there. These tests pin the content
// that traces to an observed wrong answer, so a future edit cannot quietly drop
// it.

import assert from "node:assert/strict";
import test from "node:test";

import {
  serverInstructions,
  toolsetVersion,
} from "../src/mcp-tools/instructions.ts";

const CATALOG_TOOLS = [
  "get-gc-program-plan",
  "get-gc-requirement-rules",
  "find-course-in-program",
];
const PUBLIC_TOOLS = [
  "search-classes",
  "get-schedule-freshness",
  "check-conflicts",
];

test("catalog instructions warn about the two-store split that caused the PCID miss", () => {
  const t = serverInstructions("advising-mcp-catalog", CATALOG_TOOLS);
  // The failure was: absent from one store read as absent from the degree.
  assert.match(t, /TWO SEPARATE STORES/);
  assert.match(t, /NOT absent from the degree/);
  assert.match(t, /find-course-in-program/);
  assert.match(t, /PCID/, "the concrete case is what makes the warning stick");
});

test("catalog instructions state the program/year rules", () => {
  const t = serverInstructions("advising-mcp-catalog", CATALOG_TOOLS);
  assert.match(t, /no default program/i);
  assert.match(t, /advisory/i, "non-GC audit verdicts are advisory-only");
  assert.match(t, /catalog year/i);
});

test("public instructions warn about snapshot staleness and untimed sections", () => {
  const t = serverInstructions("advising-mcp-schedule", PUBLIC_TOOLS);
  assert.match(t, /SNAPSHOT/i);
  assert.match(t, /get-schedule-freshness/);
  assert.match(t, /UNTIMED|no meeting time/i);
});

test("the two servers get different instructions", () => {
  const cat = serverInstructions("advising-mcp-catalog", CATALOG_TOOLS);
  const pub = serverInstructions("advising-mcp-schedule", PUBLIC_TOOLS);
  assert.notEqual(cat, pub);
  assert.doesNotMatch(
    pub,
    /TWO SEPARATE STORES/,
    "catalog-only guidance must not leak",
  );
});

test("toolsetVersion changes when the toolset changes, not when order does", () => {
  const a = toolsetVersion(["x", "y", "z"]);
  const reordered = toolsetVersion(["z", "x", "y"]);
  const added = toolsetVersion(["x", "y", "z", "w"]);
  const renamed = toolsetVersion(["x", "y", "zz"]);
  assert.equal(a, reordered, "order must not churn the version");
  assert.notEqual(a, added, "adding a tool must change it");
  assert.notEqual(a, renamed, "renaming a tool must change it");
});

test("instructions carry the toolset version so clients can cache and re-read", () => {
  const t = serverInstructions("advising-mcp-catalog", CATALOG_TOOLS);
  assert.match(t, new RegExp(toolsetVersion(CATALOG_TOOLS)));
  assert.match(t, /cache/i);
});

test("instructions stay small enough to prepend to every session", () => {
  for (const [name, tools] of [
    ["advising-mcp-catalog", CATALOG_TOOLS],
    ["advising-mcp-schedule", PUBLIC_TOOLS],
  ] as const) {
    const t = serverInstructions(name, tools);
    // This text is charged to context on every connection. It is guidance, not
    // documentation — if it grows past a few thousand characters it has become
    // the latter and belongs in the skill documents instead.
    assert.ok(
      t.length < 4000,
      `${name} instructions are ${t.length} chars — too long`,
    );
    assert.ok(t.length > 200, `${name} instructions look empty`);
  }
});
