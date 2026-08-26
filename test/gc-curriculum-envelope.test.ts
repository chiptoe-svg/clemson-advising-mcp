import assert from "node:assert/strict";
import test from "node:test";
import { getGcRequirementRules, getGcProgramPlan, __parseAuditOutput, GcCliError, AUDIT_SCHEMA_VERSION } from "../src/gc-curriculum.ts";

// execFile's rejection carries stdout/stderr and the exit code on the Error.
function cliFailure(code: number, stdout: string): Error & { code: number; stdout: string; stderr: string } {
  return Object.assign(new Error(`Command failed: python query.py …`), { code, stdout, stderr: "" });
}

test("an exit-2 JSON envelope becomes a GcCliError carrying known_programs", async () => {
  const run = async () => { throw cliFailure(2, '{"error": "unknown program \'Economics\' for 2026-2027", "known_programs": ["Economics, BA", "Economics, BS"]}\n'); };
  await assert.rejects(() => getGcRequirementRules("2026-2027", "Economics", run), (e: unknown) => {
    assert.ok(e instanceof GcCliError);
    assert.match(e.message, /unknown program 'Economics'/);
    assert.deepEqual(e.knownPrograms, ["Economics, BA", "Economics, BS"]);
    assert.ok(!e.message.includes("Traceback"));
    return true;
  });
});

test("a non-JSON failure is still surfaced, without inventing an envelope", async () => {
  const run = async () => { throw cliFailure(1, "Traceback (most recent call last): …"); };
  await assert.rejects(() => getGcProgramPlan("2026-2027", "X", run), (e: unknown) => {
    assert.ok(!(e instanceof GcCliError));
    return true;
  });
});

test("audit output must carry the expected audit_version", () => {
  assert.equal(AUDIT_SCHEMA_VERSION, "gc-audit-v1");
  assert.deepEqual(__parseAuditOutput(JSON.stringify({ audit_version: "gc-audit-v1", slots: [] })), { audit_version: "gc-audit-v1", slots: [] });
  assert.throws(() => __parseAuditOutput(JSON.stringify({ slots: [] })), /audit_version/);
  assert.throws(() => __parseAuditOutput(JSON.stringify({ audit_version: "gc-audit-v2" })), /gc-audit-v2.*expected gc-audit-v1/);
});
