// GC curriculum data layer — in-process reads over the built catalog database
// (core/db/catalog.db) through catalog-read.ts. Read-only; public catalog
// data. Nothing here spawns a process: the Python under core/ BUILDS the
// database and serves as the oracle for test/catalog-read-differential.test.ts,
// but never runs on a request path.
import { CATALOG_DB } from "./config-mcp.js";
import {
  getCourse as getCourseRow,
  getGenEd as getGenEdRows,
  getProgramPlan as getProgramPlanRow,
  getRequirementRules as getRequirementRulesRows,
  knownPrograms,
  listCatalogYears,
  openCatalog,
} from "./catalog-read.js";

/**
 * A catalog lookup that named a program the catalog year does not have. Carries
 * the valid names so a caller can disambiguate ("Economics" → "Economics, BS").
 */
export class GcCatalogError extends Error {
  constructor(
    message: string,
    public readonly knownPrograms: string[] = [],
  ) {
    super(message);
    this.name = "GcCatalogError";
  }
}

function withCatalog<T>(fn: (db: ReturnType<typeof openCatalog>) => T): T {
  const db = openCatalog(CATALOG_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Turn a reader's "No program …" error into a GcCatalogError whose MESSAGE
 * carries the known-program list. The MCP tool handlers surface `e.message`
 * and nothing else, so a list only on the property would never reach the
 * model — and the disambiguation an advisor asking about "Economics" gets is
 * the whole point.
 */
function asCatalogError(err: unknown, year: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/^No program /.test(msg)) {
    const known = withCatalog((db) => knownPrograms(db, year));
    throw new GcCatalogError(
      known.length ? `${msg}. Known programs: ${known.join("; ")}` : msg,
      known,
    );
  }
  throw err;
}

export async function listGcCatalogYears(): Promise<string[]> {
  return withCatalog((db) => listCatalogYears(db));
}

export async function getGcProgramPlan(
  year: string,
  name: string,
): Promise<unknown> {
  try {
    return withCatalog((db) => getProgramPlanRow(db, year, name));
  } catch (e) {
    return asCatalogError(e, year);
  }
}

export async function getGcRequirementRules(
  year: string,
  name: string,
): Promise<unknown> {
  try {
    return withCatalog((db) => getRequirementRulesRows(db, year, name));
  } catch (e) {
    return asCatalogError(e, year);
  }
}

export async function getGcGenEd(year: string): Promise<unknown> {
  return withCatalog((db) => getGenEdRows(db, year));
}

export async function getGcCourse(code: string): Promise<unknown> {
  return withCatalog((db) => getCourseRow(db, code));
}
