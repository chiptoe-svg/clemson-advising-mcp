// Instructor preferences (Chip, 2026-10-29: "save file"): a hand-edited
// state/instructor-preferences.yaml the checker reads. Absent = none;
// unreadable or malformed = an error, never silently ignored.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "instr-prefs-"));
process.env.STATE_DIR = STATE;
const F = path.join(STATE, "instructor-preferences.yaml");
const P = await import("../src/instructor-preferences.ts");

test("no file: no preferences", () => {
  assert.equal(P.loadInstructorPreferences().size, 0);
});

test("a file's preferences load, keyed by name or email as written", () => {
  fs.writeFileSync(
    F,
    [
      "instructors:",
      '  "Jane Doe":',
      '    avoid_days: "f"',
      '    not_before: "0900"',
      "  jdoe2@clemson.edu:",
      '    not_after: "1700"',
      "    max_sections: 4",
      "",
    ].join("\n"),
  );
  const p = P.loadInstructorPreferences();
  assert.deepEqual(p.get("Jane Doe"), { avoidDays: "F", notBefore: "0900" });
  assert.deepEqual(p.get("jdoe2@clemson.edu"), {
    notAfter: "1700",
    maxSections: 4,
  });
});

test("a malformed file is an error naming the problem", () => {
  fs.writeFileSync(F, "instructors: [unclosed");
  assert.throws(
    () => P.loadInstructorPreferences(),
    /instructor preferences unreadable/,
  );
  for (const [body, why] of [
    ['instructors:\n  "A":\n    avoid_days: "FX"\n', /avoid_days/],
    ['instructors:\n  "A":\n    not_before: "9am"\n', /not_before/],
    ['instructors:\n  "A":\n    not_after: "2500"\n', /not_after/],
    ['instructors:\n  "A":\n    max_sections: 0\n', /max_sections/],
    ['instructors:\n  "A":\n    no_fridays: true\n', /no_fridays/],
    ["instructors: [1, 2]\n", /map/],
  ] as const) {
    fs.writeFileSync(F, body);
    assert.throws(() => P.loadInstructorPreferences(), why, body);
  }
  fs.rmSync(F);
});
