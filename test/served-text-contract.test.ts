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
  assert.doesNotMatch(
    s,
    /`list-skills`|`get-skill-docs`/,
    "those do not exist on catalog",
  );
});

test("the schedule server names its skill tools when they are visible", () => {
  const s = serverInstructions("advising-mcp-schedule", [
    ...SCHEDULE_TOOLS,
    "list-skills",
    "get-skill-docs",
  ]);
  assert.match(s, /`list-skills` \/ `get-skill-docs`/);
  assert.doesNotMatch(
    s,
    /catalog-skill/,
    "the other server's names do not belong here",
  );
});

test("department docs are served without maintainer HTML comments", () => {
  const doc = getDepartmentDoc("gc");
  assert.ok(doc, "gc department doc missing");
  assert.doesNotMatch(
    doc.content,
    /<!--/,
    "maintainer notes reached the model",
  );
  // The retracted rule must not reach the model even as a quotation.
  assert.doesNotMatch(doc.content, /must be in the summer/i);
});

test("the schedule server's skill tools promise only what it serves", async () => {
  // ae45b5f wrote the catalog's pitch ("the advising method: degree audits,
  // prerequisite checks...") into the schedule server's descriptions too. 8766
  // serves only clemson-schedule-advising (SCHEDULE_SKILLS); the method docs
  // are catalog-only, so a model sent to fetch them here finds nothing.
  const { __skillTools, SCHEDULE_SKILLS } =
    await import("../src/mcp-tools/skills.js");
  assert.deepEqual(
    [...SCHEDULE_SKILLS],
    ["clemson-schedule-advising"],
    "re-check this text",
  );
  for (const t of [__skillTools.listSkills, __skillTools.getSkillDocs]) {
    assert.doesNotMatch(
      t.tool.description ?? "",
      /advising method|degree audit|DegreeWorks/i,
      t.tool.name,
    );
  }
});

test("the tools that compete with get-program-graph point to it", async () => {
  // Cob_advisor benchmark 2026-10-07: of 14 trials that could see the graph,
  // half still chose get-program-plan + a get-course-details loop. Their
  // descriptions now route multi-term planning to the graph.
  const { getCourseDetails } = await import("../src/mcp-tools/core-search.js");
  const { programPlan } = await import("../src/mcp-tools/catalog.js");
  for (const t of [getCourseDetails, programPlan]) {
    assert.match(t.tool.description ?? "", /get-program-graph/, t.tool.name);
  }
});

test("the tools that compete with the teaching tools point to them — for a consumer that holds them", async () => {
  // Cob_advisor 2026-10-07: a two-term faculty list took 27 calls (24
  // get-course-details + 3 search-classes) and never touched a teaching tool;
  // both sit in the scheduling tail, so the model used what was loaded.
  await import("../src/mcp-tools/core-search.js");
  const { toolsForScope } = await import("../src/mcp-tools/server.js");
  const { SCOPE_OPERATIONS } = await import("../src/mcp-tools/permissions.js");
  const admin = new Set([
    ...SCOPE_OPERATIONS["clemson.schedule"],
    ...SCOPE_OPERATIONS["clemson.admin"],
  ]);
  const listed = toolsForScope(admin);
  for (const name of ["get-course-details", "search-classes"]) {
    const d = listed.find((t) => t.name === name)?.description ?? "";
    assert.match(d, /get-instructor-classes/, name);
    assert.match(d, /get-teaching-load/, name);
  }
});

test("a consumer without the admin tools is never pointed at them", async () => {
  // Cob_advisor 2026-11-22: the advisor (schedule scope only) kept calling a
  // non-existent get_instructor_classes on T2b/T9h because search-classes
  // named it. It gets the route it can call instead.
  await import("../src/mcp-tools/core-search.js");
  const { toolsForScope } = await import("../src/mcp-tools/server.js");
  const { SCOPE_OPERATIONS } = await import("../src/mcp-tools/permissions.js");
  const listed = toolsForScope(new Set(SCOPE_OPERATIONS["clemson.schedule"]));
  assert.ok(listed.length > 0);
  for (const t of listed) {
    assert.doesNotMatch(
      t.description ?? "",
      /get-instructor-classes|get-teaching-load/,
      t.name,
    );
  }
  const d = listed.find((t) => t.name === "search-classes")?.description ?? "";
  assert.match(d, /`instructor` filter/);
  assert.match(d, /one call per subject/);
});

test("get-program-graph routes what-if questions to what-if-plan and explains slack", async () => {
  // T8b 2026-10-20: models given the graph misread it (Spark 1/8, 27B 5/8).
  const { programGraph } = await import("../src/mcp-tools/program-graph.js");
  const d = programGraph.tool.description ?? "";
  assert.match(d, /what-if-plan/);
  assert.match(d, /slack/);
});
