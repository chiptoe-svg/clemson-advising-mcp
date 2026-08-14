import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMcpOperation,
  isMcpOperationExposed,
} from "../src/mcp-tools/permissions.ts";

// The Clemson Browse Classes tools are public, no-auth, read-only and should be
// exposed (their policy actions are approval=none). Handler-level behavior for
// the four front-door tools (search-classes, find-alternatives, check-
// conflicts, get-course-details) lives in test/core-search.test.ts; find-
// requirement-sections' handler behavior lives in
// test/find-requirement-sections.test.ts — this file only covers the
// surviving-as-is tools (list-clemson-terms, find-conflict-free-schedule)
// plus the policy-gate wiring shared across the whole clemson surface.

test("clemson public tools are exposed", () => {
  assert.equal(isMcpOperationExposed("clemson.list_terms"), true);
  assert.equal(isMcpOperationExposed("clemson.search_classes"), true);
  assert.equal(isMcpOperationExposed("clemson.find_alternatives"), true);
  assert.equal(isMcpOperationExposed("clemson.check_conflicts"), true);
  assert.equal(isMcpOperationExposed("clemson.course_details"), true);
  assert.equal(isMcpOperationExposed("clemson.find_conflict_free_schedule"), true);
  assert.equal(isMcpOperationExposed("clemson.find_requirement_sections"), true);
});

test("removed operations are no longer in the allow-list", () => {
  assert.equal(isMcpOperationExposed("clemson.section_details"), false);
  assert.equal(isMcpOperationExposed("clemson.instructor_classes"), false);
  assert.equal(isMcpOperationExposed("clemson.room_availability"), false);
  assert.equal(isMcpOperationExposed("clemson.check_schedule_conflicts"), false);
  assert.equal(isMcpOperationExposed("clemson.find_eligible_sections"), false);
  assert.equal(isMcpOperationExposed("clemson.find_sections_by_schedule"), false);
  assert.equal(isMcpOperationExposed("clemson.gc_course"), false);
});

test("clemson tools pass the policy gate", () => {
  assert.doesNotThrow(() => assertMcpOperation("clemson.list_terms"));
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.search_classes", { input: { term: "202608" } }),
  );
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.course_details", {
      input: { term: "202608", crn: "85865" },
    }),
  );
});

test("skill docs tools are exposed and pass the policy gate", () => {
  assert.equal(isMcpOperationExposed("host.list_skills"), true);
  assert.equal(isMcpOperationExposed("host.get_skill_docs"), true);
  assert.doesNotThrow(() => assertMcpOperation("host.list_skills"));
  assert.doesNotThrow(() =>
    assertMcpOperation("host.get_skill_docs", {
      input: { name: "clemson-schedule-advising" },
    }),
  );
});

test("schedule conflict tools pass the policy gate", () => {
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.check_conflicts", {
      input: { term: "202608", crns: ["80001"] },
    }),
  );
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.find_conflict_free_schedule", {
      input: { term: "202608", fixed_crns: [], candidate_crns: ["80001"] },
    }),
  );
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.find_requirement_sections", {
      input: {
        term: "202608",
        requirement: "Specialty Area Requirement",
        completed_courses: ["GC 1010"],
      },
    }),
  );
});
