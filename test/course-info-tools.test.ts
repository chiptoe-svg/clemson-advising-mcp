// Both servers' course tools answer all three directions of the prerequisite
// edges — what a course needs, what needs it, what goes alongside it — from
// ONE shared function (src/course-dependents.ts), so they cannot disagree.
// Runs against the committed core/db/catalog.db: GC 3460 is named by GC 4060
// and GC 4400 ("Preq or concurrent enrollment: GC 3460"), and GC 4440 names
// both of those.
import assert from "node:assert/strict";
import test from "node:test";

import { makeGetCourseDetails } from "../src/mcp-tools/core-search.ts";
import { getCourse } from "../src/mcp-tools/catalog.ts";

type Deps = {
  total: number;
  truncated: boolean;
  dependents: {
    code: string;
    depth: number;
    via?: string;
    prereq_text: string | null;
  }[];
};

async function call(
  tool: { handler: (a: Record<string, unknown>) => Promise<unknown> },
  args: Record<string, unknown>,
) {
  const res = (await tool.handler(args)) as {
    isError?: boolean;
    content: { text: string }[];
  };
  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

test("get-course-details: prerequisite_for lists the courses that name it", async () => {
  const b = await call(makeGetCourseDetails(), { course_code: "GC 3460" });
  const p = b.prerequisite_for as Deps;
  assert.deepEqual(
    p.dependents.map((d) => d.code),
    ["GC 4060", "GC 4400"],
  );
  assert.match(
    p.dependents[0].prereq_text ?? "",
    /concurrent enrollment: GC 3460/,
  );
});

test("get-course-details: include_chain walks further down", async () => {
  const b = await call(makeGetCourseDetails(), {
    course_code: "GC 3460",
    include_chain: true,
  });
  const p = b.prerequisite_for as Deps;
  const gc4440 = p.dependents.find((d) => d.code === "GC 4440");
  assert.equal(gc4440?.depth, 2);
});

test("get-course (catalog server): prerequisites and dependents, same answer", async () => {
  const b = await call(getCourse, { course: "GC 3460" });
  assert.equal(b.found, true);
  assert.equal(b.prereq_text, "GC 2070");
  const p = b.prerequisite_for as Deps;
  assert.deepEqual(
    p.dependents.map((d) => d.code),
    ["GC 4060", "GC 4400"],
  );
});

test("get-course: a dependents subject filter narrows the list", async () => {
  const b = await call(getCourse, {
    course: "GC 2070",
    dependents_subject: "PKSC",
  });
  const p = b.prerequisite_for as Deps;
  assert.ok(p.dependents.length > 0);
  assert.ok(p.dependents.every((d) => d.code.startsWith("PKSC ")));
});
