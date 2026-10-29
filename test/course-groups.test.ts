// Course groups (2026-10-28): the courses students take together, generated
// from the catalog plan's semesters so they work for any program and follow
// catalog changes, with hand-saved overrides in state/course-groups.yaml.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "course-groups-"));
process.env.STATE_DIR = STATE;
const G = await import("../src/course-groups.ts");

const item = (
  code: string | null,
  one_of: string[] = [],
  slot: string | null = null,
) => ({
  kind: code ? "course" : one_of.length ? "choice" : "slot",
  course_code: code,
  one_of,
  slot_type: slot,
  credits: 3,
  footnote_refs: [],
});
const plan = {
  name: "Graphic Communications, BS",
  total_credits: 120,
  description: null,
  footnotes: [],
  source_url: null,
  groups: [
    {
      label: "Freshman/Second Semester",
      kind: "term",
      credit_total: 15,
      items: [item("GC 1040"), item(null, ["STAT 2220", "STAT 2300"])],
    },
    {
      label: "Junior/First Semester",
      kind: "term",
      credit_total: 15,
      items: [
        item("GC 3400"),
        item("GC 4060"),
        item("MKT 3010"),
        item(null, [], "Elective"),
      ],
    },
  ],
};
const coreqs = (c: string) => (c === "GC 1040" ? ["GC 1041"] : []);

test("one group per plan semester; slots are unresolved", () => {
  const gs = G.groupsFromPlan(plan, coreqs);
  const jr = gs.find((g) => g.name.endsWith("Junior/First Semester"))!;
  assert.equal(jr.name, "Graphic Communications, BS — Junior/First Semester");
  assert.deepEqual(jr.needs, [["GC 3400"], ["GC 4060"], ["MKT 3010"]]);
  assert.deepEqual(jr.unresolved, ["Elective"]);
  assert.equal(jr.source, "generated");
});

test("a choice item is one need; a coreq lab joins as its own need", () => {
  const fr = G.groupsFromPlan(plan, coreqs)[0]!;
  assert.deepEqual(fr.needs, [
    ["GC 1040"],
    ["STAT 2220", "STAT 2300"],
    ["GC 1041"],
  ]);
});

test("no saved file means no saved groups; a malformed one is an error", () => {
  assert.deepEqual(G.loadSavedGroups(), []);
  fs.writeFileSync(path.join(STATE, "course-groups.yaml"), "groups: [unclosed");
  assert.throws(() => G.loadSavedGroups(), /course groups unreadable/);
  fs.writeFileSync(path.join(STATE, "course-groups.yaml"), "groups: 7\n");
  assert.throws(() => G.loadSavedGroups(), /must be a list/);
});

test("a saved group overrides the generated one with the same name", () => {
  fs.writeFileSync(
    path.join(STATE, "course-groups.yaml"),
    [
      "groups:",
      '  - name: "Graphic Communications, BS — Junior/First Semester"',
      '    courses: ["GC 3400", "GC 4060", ["PSYC 2010", "SOC 2010"]]',
      '  - name: "GC lab block"',
      '    courses: ["GC 4061", "GC 4401"]',
    ].join("\n"),
  );
  const merged = G.mergeGroups(
    G.groupsFromPlan(plan, coreqs),
    G.loadSavedGroups(),
  );
  const jr = merged.find((g) => g.name.endsWith("Junior/First Semester"))!;
  assert.equal(jr.source, "saved");
  assert.deepEqual(jr.needs, [
    ["GC 3400"],
    ["GC 4060"],
    ["PSYC 2010", "SOC 2010"],
  ]);
  assert.ok(merged.some((g) => g.name === "GC lab block"));
  assert.equal(merged.length, 3);
});
