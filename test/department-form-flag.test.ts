// The `form` flag on a department slot entry: a known value is served as-is,
// and an unknown one is a load ERROR — a typo silently dropped would serve a
// course as counting with no form when the department requires one.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dept-form-"));
process.env.DEPARTMENTS_DIR = DIR;
const { getDepartmentRules } = await import("../src/departments.ts");

function dept(id: string, entry: string): void {
  fs.mkdirSync(path.join(DIR, id), { recursive: true });
  fs.writeFileSync(
    path.join(DIR, id, "rules.yaml"),
    `slots:\n  - slot_type: "X Requirement"\n    allow:\n      - ${entry}\n`,
  );
}

test("form: substitution is served on the entry", () => {
  dept("ok", '{ code: "GC 4440", note: "n", form: "substitution" }');
  const a = getDepartmentRules("ok")!.slots[0].allow[0];
  assert.deepEqual(a, { code: "GC 4440", note: "n", form: "substitution" });
});

test("an unknown form value is an error, never dropped", () => {
  dept("typo", '{ code: "GC 4440", form: "substitute" }');
  assert.throws(() => getDepartmentRules("typo"), /form/);
});
