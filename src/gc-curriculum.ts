// GC curriculum data layer — bridges to the gc_advisor project's query.py CLI
// (JSON in/out) so gc_advisor's CatalogAccess stays the single source of truth.
// Read-only; the curriculum DB holds public catalog data.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  GC_ADVISOR_PYTHON,
  GC_ADVISOR_QUERY,
  GC_ADVISOR_AUDIT,
  GC_ADVISOR_DB,
} from "./config-mcp.js";

const execFileAsync = promisify(execFile);

import {
  getCourse as getCourseRow,
  getGenEd as getGenEdRows,
  getProgramPlan as getProgramPlanRow,
  getRequirementRules as getRequirementRulesRows,
  knownPrograms,
  listCatalogYears,
  openCatalog,
} from "./catalog-read.js";

/** The audit contract version this service understands (core/src/gc_advisor/audit/engine.py:AUDIT_SCHEMA_VERSION). */
export const AUDIT_SCHEMA_VERSION = "gc-audit-v1";

/** A structured failure from core's CLI (exit 2 + one-line JSON on stdout). */
export class GcCliError extends Error {
  constructor(
    message: string,
    public readonly knownPrograms: string[] = [],
  ) {
    super(message);
    this.name = "GcCliError";
  }
}

/** Turns an execFile rejection into GcCliError when core sent an envelope; rethrows otherwise. */
function rethrowCliFailure(e: unknown): never {
  const err = e as { code?: unknown; stdout?: unknown };
  if (err && err.code === 2 && typeof err.stdout === "string") {
    let env: { error?: unknown; known_programs?: unknown } | null = null;
    try {
      env = JSON.parse(err.stdout.trim()) as { error?: unknown; known_programs?: unknown };
    } catch {
      env = null; // stdout was not an envelope — surface the original failure
    }
    if (env && typeof env.error === "string") {
      const known = Array.isArray(env.known_programs)
        ? env.known_programs.filter((s): s is string => typeof s === "string")
        : [];
      throw new GcCliError(
        known.length ? `${env.error}. Known programs: ${known.join("; ")}` : env.error,
        known,
      );
    }
  }
  throw e;
}

/**
 * Parse a CLI's stdout, naming the subcommand when it turns out not to be JSON.
 *
 * A zero exit whose stdout is an HTML error page, a stray warning, or a
 * traceback printed to stdout used to escape as a bare
 * `SyntaxError: Unexpected token '<', "<html>500<"... is not valid JSON`,
 * which names neither the tool that was run nor what it was asked for. The MCP
 * handlers surface `e.message` verbatim to the model, so that string was the
 * whole diagnosis. This keeps the failure a failure, and makes it legible.
 */
function parseCliJson(subcommand: string, out: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    const snippet = out.trim().slice(0, 200) || "<empty>";
    throw new Error(
      `gc_advisor query.py ${subcommand} exited 0 but its stdout was not JSON: ${snippet}`,
    );
  }
}

/** Exposed for tests: validates the audit contract before anything reads the body. */
export function __parseAuditOutput(out: string): Record<string, unknown> {
  const parsed = JSON.parse(out) as Record<string, unknown>;
  const v = parsed.audit_version;
  if (v !== AUDIT_SCHEMA_VERSION) {
    throw new Error(
      `audit output carries audit_version ${v === undefined ? "<missing>" : String(v)}, expected ${AUDIT_SCHEMA_VERSION} — core and service are out of step`,
    );
  }
  return parsed;
}

/** Runs gc_advisor's query.py with the given subcommand args, returns stdout. */
export type QueryRunner = (args: string[]) => Promise<string>;

/**
 * The spawn `defaultRunner` uses, injectable for tests only.
 *
 * `timeout: 15_000` below is enforced by execFile itself, not by anything in
 * this module — so no DI-runner test can reach it, and deleting it survived
 * mutation (2026-08-26 review, T11). This seam lets a test read back the
 * options defaultRunner actually passes. It proves the option is passed; that
 * execFile then honours it is node's contract, not ours.
 */
type ExecFileAsync = (
  file: string,
  args: string[],
  options: { maxBuffer: number; timeout: number },
) => Promise<{ stdout: string }>;

let execFileForTest: ExecFileAsync | null = null;
export function __setQueryExecFileForTest(fn: ExecFileAsync | null): void {
  execFileForTest = fn;
}

const defaultRunner: QueryRunner = async (args) => {
  const spawn = execFileForTest ?? (execFileAsync as unknown as ExecFileAsync);
  const { stdout } = await spawn(
    GC_ADVISOR_PYTHON,
    [GC_ADVISOR_QUERY, "--db", GC_ADVISOR_DB, ...args],
    { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
  );
  return stdout;
};

/** Exposed so the seam above has something to drive. Not for production use. */
export const __defaultQueryRunnerForTest: QueryRunner = (args) => defaultRunner(args);

/** Runs the audit CLI with JSON piped to stdin (payloads are too large for argv). */
export type AuditRunner = (stdin: string) => Promise<string>;

function runAuditWithStdin(stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      GC_ADVISOR_PYTHON,
      [GC_ADVISOR_AUDIT, "--db", GC_ADVISOR_DB],
      { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      // Callback-style execFile does NOT attach stdout/stderr to the error
      // (only the promisified form does); attach them so rethrowCliFailure
      // can read core's exit-2 JSON envelope off `err.stdout`.
      (err, stdout, stderr) =>
        err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout),
    );
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

// Test-only seam, same shape as __setGcRequirementRulesRunner below: lets a
// test see the record the audit tool actually submits (Phase B4 fills its
// program / catalog_year) without spawning Python.
let auditRunner: AuditRunner = runAuditWithStdin;

export function __setGcAuditRunner(run: AuditRunner): void {
  auditRunner = run;
}

export function __resetGcAuditRunner(): void {
  auditRunner = runAuditWithStdin;
}

export async function auditGcProgress(
  progress: unknown,
  run: AuditRunner = auditRunner,
): Promise<unknown> {
  const out = await run(JSON.stringify(progress)).catch(rethrowCliFailure);
  return __parseAuditOutput(out);
}


// --- Node-backed catalog reads (2026-08-27) ---------------------------------
//
// These five reads used to spawn core/scripts/query.py per call (~31 ms, and a
// ~267 req/s ceiling). They are now served in-process from the same SQLite file
// (~2 ms). The Python is unchanged and remains the oracle:
// test/catalog-read-differential.test.ts diffs Node against it for EVERY
// program x catalog year (36 plans, 36 rule sets, 9 gen-ed years, 40 courses).
//
// The `run` parameter is preserved on every function. When a caller passes one
// explicitly — only tests do — the CLI path still runs, so the error-envelope
// and timeout tests keep exercising the code they were written for. Production
// callers omit it and get the Node path.
//
// auditGcProgress is NOT here: the audit engine stays in Python (see
// src/catalog-read.ts).

function withCatalog<T>(fn: (db: ReturnType<typeof openCatalog>) => T): T {
  const db = openCatalog(GC_ADVISOR_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Translate a reader error into the SAME envelope query.py produced, so callers
 * that already handle GcCliError (with its known_programs list) are unaffected
 * by which implementation answered.
 */
function asCliError(err: unknown, year: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/^No program /.test(msg)) {
    const known = withCatalog((db) => knownPrograms(db, year));
    // The list must go in the MESSAGE, not only on the property. The MCP tool
    // handlers surface `e.message` and nothing else, so a knownPrograms property
    // never reaches the model — which is how the port silently dropped the
    // disambiguation an advisor asking about "Economics" used to get, while
    // test/core-cli-e2e.test.ts kept passing because it asserts the property.
    // Format is byte-identical to rethrowCliFailure's, so the two paths are
    // genuinely indistinguishable downstream, as the port claimed.
    throw new GcCliError(
      known.length ? `${msg}. Known programs: ${known.join("; ")}` : msg,
      known,
    );
  }
  throw err;
}

export async function listGcCatalogYears(
  run?: QueryRunner,
): Promise<string[]> {
  if (run) {
    const out = await run(["years"]).catch(rethrowCliFailure);
    return parseCliJson("years", out) as string[];
  }
  return withCatalog((db) => listCatalogYears(db));
}

export async function getGcProgramPlan(
  year: string,
  name: string,
  run?: QueryRunner,
): Promise<unknown> {
  if (run) {
    const out = await run(["program-plan", "--year", year, "--name", name]).catch(rethrowCliFailure);
    return parseCliJson("program-plan", out);
  }
  try {
    return withCatalog((db) => getProgramPlanRow(db, year, name));
  } catch (e) {
    return asCliError(e, year);
  }
}

// Test-only seam: lets tests override the runner getGcRequirementRules falls
// back to when a caller (e.g. the MCP tool handler) omits `run`, without
// changing that function's public signature.
let requirementRulesRunner: QueryRunner = defaultRunner;

export function __setGcRequirementRulesRunner(run: QueryRunner): void {
  requirementRulesRunner = run;
}

export function __resetGcRequirementRulesRunner(): void {
  requirementRulesRunner = defaultRunner;
}

export async function getGcRequirementRules(
  year: string,
  name: string,
  run: QueryRunner | null = requirementRulesRunner === defaultRunner ? null : requirementRulesRunner,
): Promise<unknown> {
  if (run) {
    const out = await run(["req-rules", "--year", year, "--name", name]).catch(rethrowCliFailure);
    return parseCliJson("req-rules", out);
  }
  try {
    return withCatalog((db) => getRequirementRulesRows(db, year, name));
  } catch (e) {
    return asCliError(e, year);
  }
}

// Test-only seam, same shape as __setGcRequirementRulesRunner above.
let genEdRunner: QueryRunner = defaultRunner;

export function __setGcGenEdRunner(run: QueryRunner): void {
  genEdRunner = run;
}

export function __resetGcGenEdRunner(): void {
  genEdRunner = defaultRunner;
}

export async function getGcGenEd(
  year: string,
  run: QueryRunner | null = genEdRunner === defaultRunner ? null : genEdRunner,
): Promise<unknown> {
  if (run) {
    const out = await run(["gen-ed", "--year", year]).catch(rethrowCliFailure);
    return parseCliJson("gen-ed", out);
  }
  return withCatalog((db) => getGenEdRows(db, year));
}

export async function getGcCourse(
  code: string,
  run?: QueryRunner,
): Promise<unknown> {
  if (run) {
    const out = await run(["course", "--code", code]).catch(rethrowCliFailure);
    return parseCliJson("course", out);
  }
  return withCatalog((db) => getCourseRow(db, code));
}
