// test/_artifacts.ts
//
// One place that answers "does this machine carry the local artifacts the
// live-data tests need?" — and one place that decides what to do when it does
// not.
//
// Three kinds of local artifact are NOT in git and are NOT reproducible in CI:
//   * core/db/gc_advisor.db   the built GC catalog database
//   * state/clemson/<term>.db the Banner class-schedule snapshots
//   * core/.venv/bin/python   the provisioned Python core
// A fourth prerequisite behaves the same way: CLEMSON_LLM_API_KEY, which the
// provider-resolution tests need in order for the OpenAI-track target to
// resolve at all (it normally arrives via .env, which CI does not have).
//
// The rule this file encodes:
//   * On a machine WITHOUT them (CI, a fresh clone) an artifact-dependent test
//     must SKIP with a counted string reason — never fail, never hang.
//   * On the working machine, `npm run test:gate` sets REQUIRE_ARTIFACTS=1 and
//     requireArtifacts() THROWS — a missing artifact must never read as green
//     just because the suite politely skipped past it.
//
// Guarded files call requireArtifacts(...) once at the top, then use the
// exported guards in `{ skip }` options. The reason must be a STRING (not
// `true`) so `# skipped` counts it and the CI step can report the number.
//
// NOTE ON IMPORT ORDER: src/config.ts snapshots STATE_DIR / GC_ADVISOR_* from
// the environment at module-load time. A test file that rewrites
// process.env.STATE_DIR to a temp directory (the no-snapshot files do) must NOT
// import this module — it would resolve the real paths or, worse, pin config.ts
// to the temp value for everything imported after it.
import fs from "node:fs";
import path from "node:path";

import {
  CLEMSON_LLM_API_KEY,
  GC_ADVISOR_DB,
  GC_ADVISOR_PYTHON,
  STATE_DIR,
} from "../src/config.ts";

/** The built GC catalog database (core/db/gc_advisor.db) exists. */
export const CORE_DB_PRESENT = fs.existsSync(GC_ADVISOR_DB);

/** The provisioned Python core (core/.venv/bin/python) exists. */
export const CORE_PYTHON_PRESENT = fs.existsSync(GC_ADVISOR_PYTHON);

/**
 * A Banner snapshot exists under STATE_DIR/clemson.
 * With a term code, that exact snapshot; with none, any snapshot at all.
 */
export function SNAPSHOT_PRESENT(term?: string): boolean {
  const dir = path.join(STATE_DIR, "clemson");
  if (term !== undefined) return fs.existsSync(path.join(dir, `${term}.db`));
  try {
    return fs.readdirSync(dir).some((name) => /^\d{6}\.db$/.test(name));
  } catch {
    return false;
  }
}

/** The Clemson LLM gateway key is configured (normally via .env). */
export const GATEWAY_KEY_PRESENT = CLEMSON_LLM_API_KEY !== "";

// --- `{ skip }` reasons -----------------------------------------------------
//
// Each is `false` (run it) or a string (skip, and say why). node:test counts a
// string reason in `# skipped`; `true` would too, but says nothing in the log.

export const SKIP_NO_CORE_DB: false | string = CORE_DB_PRESENT
  ? false
  : "core/db/gc_advisor.db absent";

export const SKIP_NO_CORE_PYTHON: false | string = CORE_PYTHON_PRESENT
  ? false
  : "core/.venv/bin/python absent";

export const SKIP_NO_GATEWAY_KEY: false | string = GATEWAY_KEY_PRESENT
  ? false
  : "CLEMSON_LLM_API_KEY unset";

export function skipNoSnapshot(term?: string): false | string {
  if (SNAPSHOT_PRESENT(term)) return false;
  return term === undefined
    ? "no Banner snapshot in state/clemson"
    : `state/clemson/${term}.db absent`;
}

/** First reason among several, or false when all of them are satisfied. */
export function skipAny(...reasons: Array<false | string>): false | string {
  return reasons.find((r) => r !== false) ?? false;
}

/**
 * The working-machine gate. Under REQUIRE_ARTIFACTS=1 (set by `npm run
 * test:gate`) a missing artifact is a hard error, so the gate can never pass
 * on a suite that quietly skipped its live-data coverage. Outside the gate this
 * is a no-op and the `{ skip }` guards take over.
 *
 * @param terms snapshot term codes this file needs; none means "any snapshot".
 */
export function requireArtifacts(...terms: string[]): void {
  // A term code is six digits (e.g. "202608"). Anything else is a caller
  // mistake, and silently resolving it to state/clemson/<junk>.db produced a
  // gate that had been RED since 2026-08-27 while every commit reported a green
  // `npm test` — three files passed "core-db"/"core-python" here as if they
  // were terms. Refuse loudly rather than misinterpret: the same lesson the
  // data_classes parser had to learn the same day.
  for (const t of terms) {
    if (!/^\d{6}$/.test(t)) {
      throw new Error(
        `requireArtifacts() takes six-digit Banner term codes, got ${JSON.stringify(t)}. ` +
          `For core-database tests use requireCoreArtifacts().`,
      );
    }
  }
  if (process.env.REQUIRE_ARTIFACTS !== "1") return;
  const missing: string[] = [];
  if (!CORE_DB_PRESENT) missing.push(`GC_ADVISOR_DB=${GC_ADVISOR_DB}`);
  if (!CORE_PYTHON_PRESENT) missing.push(`GC_ADVISOR_PYTHON=${GC_ADVISOR_PYTHON}`);
  if (!GATEWAY_KEY_PRESENT) missing.push("CLEMSON_LLM_API_KEY");
  if (terms.length === 0) {
    if (!SNAPSHOT_PRESENT()) missing.push(`${STATE_DIR}/clemson/<term>.db`);
  } else {
    for (const term of terms) {
      if (!SNAPSHOT_PRESENT(term))
        missing.push(`${STATE_DIR}/clemson/${term}.db`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `REQUIRE_ARTIFACTS=1 but these are missing, so artifact-dependent tests ` +
        `would silently skip: ${missing.join(", ")}`,
    );
  }
}

/**
 * Gate for tests that need the CATALOG artifacts and nothing else — the built
 * core DB, and optionally the Python venv for differential tests.
 *
 * Distinct from requireArtifacts() because those tests need no Banner snapshot
 * and no gateway key; demanding them would fail on a machine that legitimately
 * has the catalog but not the schedule. Takes no strings, so the term-code
 * confusion that silently disabled the gate cannot recur here.
 */
export function requireCoreArtifacts(opts: { python?: boolean } = {}): void {
  if (process.env.REQUIRE_ARTIFACTS !== "1") return;
  const missing: string[] = [];
  if (!CORE_DB_PRESENT) missing.push(`GC_ADVISOR_DB=${GC_ADVISOR_DB}`);
  if (opts.python && !CORE_PYTHON_PRESENT)
    missing.push(`GC_ADVISOR_PYTHON=${GC_ADVISOR_PYTHON}`);
  if (missing.length > 0) {
    throw new Error(
      `REQUIRE_ARTIFACTS=1 but these are missing, so catalog tests would ` +
        `silently skip: ${missing.join(", ")}`,
    );
  }
}
