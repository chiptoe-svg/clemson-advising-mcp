// The departmental layer: decisions recorded by departments, served by two
// tools gated behind the clemson.department scope. Two properties matter:
//
//   1. SCOPE INVISIBILITY — a catalog-scoped consumer (student-facing) must
//      not merely be refused; the tools must be absent from its tools/list.
//   2. PROVENANCE HONESTY — every response says it is departmental data, a
//      known department with nothing recorded says so, an unknown department
//      is an error naming the valid ids, and an unreadable store is an ERROR,
//      never "no rules recorded".
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import "../src/mcp-tools/index-catalog.ts";
import {
  SCOPE_OPERATIONS,
  expandScopes,
} from "../src/mcp-tools/permissions.ts";
import { toolsForScope } from "../src/mcp-tools/server.ts";
import { __deptTools } from "../src/mcp-tools/department.ts";

function body(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

// --- scope invisibility ------------------------------------------------------

test("a catalog-scoped consumer cannot see the department tools at all", () => {
  const catalogScope = expandScopes(["clemson.catalog"]);
  assert.ok(!catalogScope.has("clemson.department_rules"));
  assert.ok(!catalogScope.has("clemson.department_docs"));
  const visible = toolsForScope(catalogScope).map((t) => t.name);
  assert.ok(
    !visible.includes("get-department-rules"),
    "hidden from tools/list",
  );
  assert.ok(!visible.includes("get-department-doc"), "hidden from tools/list");
});

test("the legacy broad `clemson` scope does NOT include the departmental layer", () => {
  const broad = expandScopes(["clemson"]);
  assert.ok(
    !broad.has("clemson.department_rules"),
    "a token minted with the old broad scope must not silently gain department data",
  );
});

test("the clemson.department scope grants exactly the two department operations", () => {
  assert.deepEqual([...SCOPE_OPERATIONS["clemson.department"]].sort(), [
    "clemson.department_docs",
    "clemson.department_rules",
  ]);
  const scoped = expandScopes(["clemson.department"]);
  const visible = toolsForScope(scoped)
    .map((t) => t.name)
    .sort();
  assert.deepEqual(visible, ["get-department-doc", "get-department-rules"]);
});

test("an unscoped consumer (the advisor) sees the department tools", () => {
  const full = expandScopes(undefined);
  assert.ok(full.has("clemson.department_rules"));
  assert.ok(full.has("clemson.department_docs"));
});

// --- the tools, against the real departments/ store --------------------------

test("get-department-rules serves GC's recorded decisions with departmental provenance", async () => {
  const res = await __deptTools.departmentRules.handler({ department: "gc" });
  assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]));
  const b = body(res as never);
  assert.equal(b.department, "gc");
  assert.match(String(b._source), /departmental decision/);
  const slots = b.slots as { slot_type: string; allow: { code: string }[] }[];
  const specialty = slots.find(
    (s) => s.slot_type === "Specialty Area Requirement",
  );
  assert.ok(specialty, "GC's specialty decisions present");
  const codes = specialty!.allow.map((c) => c.code);
  for (const c of ["MKT 4200", "GC 3610", "PKSC 3689"]) {
    assert.ok(codes.includes(c), `missing ${c}`);
  }
});

test("get-department-rules serves the GC faculty roster with Banner join keys", async () => {
  // The snapshot has no department column; this roster is the only honest
  // source for "GC faculty", and banner_name is the exact string the schedule
  // server's instructor tools match.
  const res = await __deptTools.departmentRules.handler({ department: "gc" });
  const b = body(res as never);
  const faculty = b.faculty as {
    name: string;
    banner_name?: string;
    note?: string;
  }[];
  assert.equal(faculty.length, 15);
  const pindar = faculty.find((f) => f.name === "Lori Pindar");
  assert.equal(pindar?.banner_name, "Lori Marlise Pindar");
  // Chip's roster wrote "Dersken"; he asked for spelling corrections, so the
  // entry carries Banner's spelling with no residual flag.
  const derksen = faculty.find((f) => f.name === "Gerry Derksen");
  assert.equal(derksen?.banner_name, "Gerry Wade Derksen");
});

test("a known department with nothing recorded says so — never an empty answer", async () => {
  const res = await __deptTools.departmentRules.handler({
    department: "marketing",
  });
  const b = body(res as never);
  assert.deepEqual(b.slots, []);
  assert.match(String(b.note), /recorded no slot decisions yet/);
  assert.match(String(b.note), /not proof/i);
});

test("an unknown department is an error naming the valid ids", async () => {
  const res = await __deptTools.departmentRules.handler({
    department: "underwater-basketry",
  });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /Unknown department/);
  assert.match((res.content[0] as { text: string }).text, /gc/);
});

test("omitting the department lists the known ids", async () => {
  const res = await __deptTools.departmentRules.handler({});
  const b = body(res as never);
  assert.ok((b.departments as string[]).includes("gc"));
  assert.ok((b.departments as string[]).includes("marketing"));
});

test("get-department-doc serves the GC policy document", async () => {
  const res = await __deptTools.departmentDocs.handler({ department: "gc" });
  const b = body(res as never);
  assert.match(String(b.content), /Specialty-area approval/);
  assert.match(String(b._source), /departmental decision/);
});

test("a thin department document states its thinness", async () => {
  const res = await __deptTools.departmentDocs.handler({
    department: "accounting",
  });
  const b = body(res as never);
  assert.match(
    String(b.content),
    /No department advising policy has been recorded/,
  );
});

// --- unreadable store is an ERROR, never silence -----------------------------

test("an unreadable rules file is an error, not 'no rules recorded'", async () => {
  // Same defect class as everything else in this repo: the store knowing
  // nothing must never be reported as the department having decided nothing.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "advising-mcp-dept-"));
  fs.mkdirSync(path.join(tmp, "broken"));
  fs.writeFileSync(path.join(tmp, "broken", "rules.yaml"), "slots: [unclosed");
  const prev = process.env.DEPARTMENTS_DIR;
  process.env.DEPARTMENTS_DIR = tmp;
  try {
    // config reads env at module load; departments.ts reads config — use a
    // child process so the override actually takes effect.
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `import("./src/departments.ts").then(m => {
           try { m.getDepartmentRules("broken"); console.log("SILENT"); }
           catch (e) { console.log("THREW: " + e.message); }
         })`,
      ],
      { env: { ...process.env, DEPARTMENTS_DIR: tmp }, encoding: "utf-8" },
    );
    assert.match(out, /THREW: department rules unreadable/);
    assert.ok(
      !out.includes("SILENT"),
      "an unreadable store must not read as empty",
    );
  } finally {
    if (prev === undefined) delete process.env.DEPARTMENTS_DIR;
    else process.env.DEPARTMENTS_DIR = prev;
  }
});
