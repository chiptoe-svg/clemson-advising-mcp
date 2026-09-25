// What a model is TOLD must match what it can DO.
//
// Found by a prompt audit (2026-09-24): the served instructions named skill
// tools that did not exist on the server reading them, and named tools a
// scoped consumer could not see; and department docs shipped maintainer HTML
// comments to the model verbatim, one of which quoted a retracted policy rule.
// Each read fine and each misdirected the reader.
import assert from "node:assert/strict";
import test from "node:test";

import { serverInstructions } from "../src/mcp-tools/instructions.js";
import { getDepartmentDoc } from "../src/departments.js";

const SCHEDULE_TOOLS = ["search-classes", "list-clemson-terms"];

test("instructions never name a skill tool the reader cannot see", () => {
  // A clemson.schedule-scoped consumer (the student roster default) cannot see
  // the host-scoped skill tools, so being told to call them is a dead end.
  const s = serverInstructions("advising-mcp-schedule", SCHEDULE_TOOLS);
  assert.doesNotMatch(s, /list-skills|get-skill-docs|list-catalog-skills/);
});

test("the catalog server names its OWN skill tools, not the schedule server's", () => {
  const s = serverInstructions("advising-mcp-catalog", [
    "get-program-plan",
    "list-catalog-skills",
    "get-catalog-skill-docs",
  ]);
  assert.match(s, /`list-catalog-skills`/);
  assert.doesNotMatch(s, /`list-skills`|`get-skill-docs`/, "those do not exist on catalog");
});

test("the schedule server names its skill tools when they are visible", () => {
  const s = serverInstructions("advising-mcp-schedule", [
    ...SCHEDULE_TOOLS,
    "list-skills",
    "get-skill-docs",
  ]);
  assert.match(s, /`list-skills` \/ `get-skill-docs`/);
  assert.doesNotMatch(s, /catalog-skill/, "the other server's names do not belong here");
});

test("department docs are served without maintainer HTML comments", () => {
  const doc = getDepartmentDoc("gc");
  assert.ok(doc, "gc department doc missing");
  assert.doesNotMatch(doc.content, /<!--/, "maintainer notes reached the model");
  // The retracted rule must not reach the model even as a quotation.
  assert.doesNotMatch(doc.content, /must be in the summer/i);
});

test("the schedule server's skill tools promise only what it serves", async () => {
  // ae45b5f wrote the catalog's pitch ("the advising method: degree audits,
  // prerequisite checks...") into the schedule server's descriptions too. 8766
  // serves only clemson-schedule-advising (SCHEDULE_SKILLS); the method docs
  // are catalog-only, so a model sent to fetch them here finds nothing.
  const { __skillTools, SCHEDULE_SKILLS } = await import("../src/mcp-tools/skills.js");
  assert.deepEqual([...SCHEDULE_SKILLS], ["clemson-schedule-advising"], "re-check this text");
  for (const t of [__skillTools.listSkills, __skillTools.getSkillDocs]) {
    assert.doesNotMatch(t.tool.description ?? "", /advising method|degree audit|DegreeWorks/i, t.tool.name);
  }
});
