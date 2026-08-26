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
} from "./config.js";

const execFileAsync = promisify(execFile);

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

const defaultRunner: QueryRunner = async (args) => {
  const { stdout } = await execFileAsync(
    GC_ADVISOR_PYTHON,
    [GC_ADVISOR_QUERY, "--db", GC_ADVISOR_DB, ...args],
    { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
  );
  return stdout;
};

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

export async function listGcCatalogYears(
  run: QueryRunner = defaultRunner,
): Promise<string[]> {
  const out = await run(["years"]).catch(rethrowCliFailure);
  return JSON.parse(out) as string[];
}

export async function getGcProgramPlan(
  year: string,
  name: string,
  run: QueryRunner = defaultRunner,
): Promise<unknown> {
  const out = await run(["program-plan", "--year", year, "--name", name]).catch(rethrowCliFailure);
  return JSON.parse(out);
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
  run: QueryRunner = requirementRulesRunner,
): Promise<unknown> {
  const out = await run(["req-rules", "--year", year, "--name", name]).catch(rethrowCliFailure);
  return JSON.parse(out);
}

export async function getGcGenEd(
  year: string,
  run: QueryRunner = defaultRunner,
): Promise<unknown> {
  const out = await run(["gen-ed", "--year", year]).catch(rethrowCliFailure);
  return JSON.parse(out);
}

export async function getGcCourse(
  code: string,
  run: QueryRunner = defaultRunner,
): Promise<unknown> {
  const out = await run(["course", "--code", code]).catch(rethrowCliFailure);
  return JSON.parse(out);
}
