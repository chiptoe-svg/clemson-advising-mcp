import assert from "node:assert/strict";
import test from "node:test";
import { getGcRequirementRules, getGcProgramPlan, getGcCourse, getGcGenEd, listGcCatalogYears, auditGcProgress, __parseAuditOutput, __defaultQueryRunnerForTest, __setQueryExecFileForTest, GcCliError, AUDIT_SCHEMA_VERSION } from "../src/gc-curriculum.ts";
import { GC_ADVISOR_DB, GC_ADVISOR_PYTHON, GC_ADVISOR_QUERY } from "../src/config-mcp.ts";

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

test("audit: an exit-2 envelope from audit.py becomes a GcCliError (P5 — core exits 2 since 8bdb446)", async () => {
  const run = async () => { throw cliFailure(2, '{"error": "invalid progress payload: unsupported progress version: None"}\n'); };
  await assert.rejects(() => auditGcProgress({ bogus: 1 }, run), (e: unknown) => {
    assert.ok(e instanceof GcCliError, `expected GcCliError, got ${String(e)}`);
    assert.match(e.message, /invalid progress payload/);
    assert.ok(!e.message.includes("Command failed"));
    return true;
  });
});

// ---------------------------------------------------------------------------
// T11 (2026-08-26 mutation review). Two gaps, both on the SUCCESS path:
//   * a zero exit whose stdout is not JSON escaped as a bare SyntaxError that
//     named neither the tool nor the subcommand — and the MCP handlers pass
//     e.message straight to the model, so that string was the whole diagnosis;
//   * defaultRunner's `timeout: 15_000` had no test at all — deleting it
//     survived, and an unbounded query.py spawn holds a turn open forever.
// ---------------------------------------------------------------------------

// A gateway/proxy error page is the realistic shape: HTTP-looking bytes on
// stdout with exit 0, because whatever answered was not query.py.
const HTML_500 = "<html>500 Internal Server Error</html>";

test("a zero exit whose stdout is not JSON rejects with a message naming the tool and subcommand", async () => {
  const cases: Array<{ label: string; call: () => Promise<unknown>; subcommand: RegExp }> = [
    { label: "years", call: () => listGcCatalogYears(async () => HTML_500), subcommand: /\byears\b/ },
    { label: "program-plan", call: () => getGcProgramPlan("2026-2027", "Marketing, BS", async () => HTML_500), subcommand: /\bprogram-plan\b/ },
    { label: "req-rules", call: () => getGcRequirementRules("2026-2027", "Marketing, BS", async () => HTML_500), subcommand: /\breq-rules\b/ },
    { label: "gen-ed", call: () => getGcGenEd("2026-2027", async () => HTML_500), subcommand: /\bgen-ed\b/ },
    { label: "course", call: () => getGcCourse("GC 1010", async () => HTML_500), subcommand: /\bcourse\b/ },
  ];
  for (const c of cases) {
    await assert.rejects(c.call, (e: unknown) => {
      assert.ok(e instanceof Error, `${c.label}: expected an Error`);
      assert.notEqual(e.name, "SyntaxError", `${c.label}: a bare SyntaxError names nothing`);
      assert.match(e.message, /query\.py/, `${c.label}: must name the tool — got ${e.message}`);
      assert.match(e.message, c.subcommand, `${c.label}: must name the subcommand — got ${e.message}`);
      assert.match(e.message, /not JSON/i, `${c.label}: must say what went wrong — got ${e.message}`);
      assert.ok(e.message.includes("500 Internal Server Error"), `${c.label}: must quote what it actually got`);
      return true;
    });
  }
});

test("an empty stdout on a zero exit is reported as such, not as an unexplained parse failure", async () => {
  await assert.rejects(
    () => listGcCatalogYears(async () => "   \n"),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /query\.py years/);
      assert.match(e.message, /<empty>/);
      return true;
    },
  );
});

test("valid JSON still parses — the guard adds a failure path, it does not change the happy one", async () => {
  assert.deepEqual(await listGcCatalogYears(async () => '["2026-2027"]'), ["2026-2027"]);
  assert.deepEqual(await getGcCourse("GC 1010", async () => '{"code":"GC 1010"}'), { code: "GC 1010" });
});

// The timeout lives inside execFile, so no DI QueryRunner can reach it; the
// spawn itself is injected instead. This proves defaultRunner PASSES
// timeout: 15_000 (and the 8 MiB maxBuffer) with the right argv. That execFile
// then kills the child on expiry is node's contract, not this module's.
test("defaultRunner spawns query.py with a 15s timeout and an 8 MiB buffer", async () => {
  const seen: Array<{ file: string; args: string[]; options: { maxBuffer: number; timeout: number } }> = [];
  __setQueryExecFileForTest(async (file, args, options) => {
    seen.push({ file, args, options });
    return { stdout: "[]" };
  });
  try {
    await __defaultQueryRunnerForTest(["years"]);
  } finally {
    __setQueryExecFileForTest(null);
  }
  assert.equal(seen.length, 1, "exactly one spawn");
  const call = seen[0]!;
  assert.equal(call.file, GC_ADVISOR_PYTHON);
  assert.deepEqual(call.args, [GC_ADVISOR_QUERY, "--db", GC_ADVISOR_DB, "years"]);
  assert.equal(
    call.options.timeout,
    15_000,
    "an unbounded query.py spawn holds the turn open until the provider timeout",
  );
  assert.equal(call.options.maxBuffer, 8 * 1024 * 1024);
});
