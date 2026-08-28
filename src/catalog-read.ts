// Catalog reads in Node — the serving-path replacement for core/scripts/query.py.
//
// WHY (2026-08-27, owner decision "now is the time to do it right"): every
// catalog read used to spawn a Python process. Measured: ~31 ms p50 and a
// ~267 req/s ceiling on that path, against ~2 ms and ~1,171 req/s for the reads
// already done in Node. The gap is process spawn, not query work — and on the
// target hardware (a low-end M-class Mac mini, 4 performance cores) a fixed
// spawn cost is a LARGER share of available parallelism than on the 16-core
// machine those numbers came from.
//
// WHAT STAYS IN PYTHON, deliberately:
//   - the ingest pipeline (parse_program, packs, parse_gen_ed,
//     requirement_rules) — build time, never on a request path
//   - the audit engine (audit/engine.py, 439 lines behind golden tests) —
//     called 0 times in 366 real tool calls
// Only the five reads that serve requests move. After this, production is
// Node + SQLite + a prebuilt .db, with no Python runtime at all.
//
// THE BOGUS-RULE FILTER IS NOT REIMPLEMENTED. `rule_semantics.is_bogus_rule` is
// 128 lines of dense, hard-won semantics (and got it wrong once, dropping 958
// prose rules in 2026-08-25). It does not need porting: refresh_bogus_flags
// MATERIALISES its verdict into requirement_rule.bogus at write time, and the
// `requirement_rule_effective` view exposes the filtered set. Python's own
// docstring states direct readers of that view always agree with CatalogAccess,
// and that agreement was verified empirically across six program-years before
// this module was written. The semantics stay in Python, at build time, where
// they belong.
//
// FIDELITY: the Python remains the oracle. test/catalog-read-differential.test.ts
// diffs this module's output against query.py across every program x catalog
// year in the database. Any difference is a defect here until proven otherwise.

import Database from "better-sqlite3";

export interface PlanItem {
  kind: string;
  course_code: string | null;
  one_of: string[];
  slot_type: string | null;
  credits: number | null;
  footnote_refs: unknown[];
}

export interface PlanGroup {
  label: string;
  kind: string;
  credit_total: number | null;
  items: PlanItem[];
}

export interface ProgramPlan {
  name: string;
  total_credits: number | null;
  description: string | null;
  groups: PlanGroup[];
  footnotes: Array<{ number: number; text: string }>;
  source_url: string | null;
}

export interface RequirementRule {
  slot_type: string;
  rule: Record<string, unknown>;
}

export interface GenEdCategory {
  name: string;
  min_credits: number | null;
  rules: unknown;
  allowed_courses: unknown[];
}

type Db = InstanceType<typeof Database>;

/** Open the catalog database read-only. Callers own the handle and must close it. */
export function openCatalog(dbPath: string): Db {
  return new Database(dbPath, { readonly: true });
}

/** JSON.parse that degrades to a fallback rather than throwing on bad data. */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Mirrors CatalogAccess._year_id: an unknown year is an error, not an empty result. */
function yearId(db: Db, year: string): number {
  const row = db.prepare("SELECT id FROM catalog_year WHERE label=?").get(year) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`Unknown catalog year: ${year}`);
  return row.id;
}

function programId(db: Db, cyId: number, name: string, year: string): number {
  const row = db
    .prepare("SELECT id FROM program WHERE catalog_year_id=? AND name=?")
    .get(cyId, name) as { id: number } | undefined;
  if (!row) throw new Error(`No program '${name}' in ${year}`);
  return row.id;
}

/** Every catalog year label, newest first. */
export function listCatalogYears(db: Db): string[] {
  return (
    db.prepare("SELECT label FROM catalog_year ORDER BY label DESC").all() as Array<{
      label: string;
    }>
  ).map((r) => r.label);
}

/** The semester-by-semester plan: groups, items, footnotes. */
export function getProgramPlan(db: Db, year: string, name: string): ProgramPlan {
  const cy = yearId(db, year);
  const prog = db
    .prepare("SELECT * FROM program WHERE catalog_year_id=? AND name=?")
    .get(cy, name) as
    | { id: number; name: string; total_credits: number | null; description: string | null; source_url: string | null }
    | undefined;
  if (!prog) throw new Error(`No program '${name}' in ${year}`);

  const groupRows = db
    .prepare("SELECT * FROM requirement_group WHERE program_id=? ORDER BY ordering")
    .all(prog.id) as Array<{ id: number; label: string; kind: string; credit_total: number | null }>;

  const itemStmt = db.prepare(
    "SELECT * FROM plan_item WHERE group_id=? ORDER BY ordering",
  );

  const groups: PlanGroup[] = groupRows.map((g) => ({
    label: g.label,
    kind: g.kind,
    credit_total: g.credit_total,
    items: (
      itemStmt.all(g.id) as Array<{
        kind: string;
        course_code: string | null;
        one_of: string | null;
        slot_type: string | null;
        credits: number | null;
        footnote_refs: string | null;
      }>
    ).map((it) => ({
      kind: it.kind,
      course_code: it.course_code,
      // Python: `json.loads(it["one_of"]) if it["one_of"] else []`
      one_of: parseJson<string[]>(it.one_of, []),
      slot_type: it.slot_type,
      credits: it.credits,
      footnote_refs: parseJson<unknown[]>(it.footnote_refs, []),
    })),
  }));

  const footnotes = db
    .prepare("SELECT * FROM footnote WHERE program_id=? ORDER BY number")
    .all(prog.id) as Array<{ number: number; text: string }>;

  return {
    name: prog.name,
    total_credits: prog.total_credits,
    description: prog.description,
    groups,
    footnotes: footnotes.map((f) => ({ number: f.number, text: f.text })),
    source_url: prog.source_url,
  };
}

/**
 * Advisor-curated allow/deny code sets for a slot. Rows with a NULL
 * catalog_year apply to every year (mirrors db/advisor.py advisor_sets).
 */
function advisorSets(
  db: Db,
  slotType: string,
  catalogYear: string | null,
  program: string,
): { allow: string[]; deny: string[] } {
  const rows = db
    .prepare(
      "SELECT code, action FROM advisor_course WHERE program=? AND slot_type=? " +
        "AND (catalog_year IS NULL OR catalog_year=?)",
    )
    .all(program, slotType, catalogYear) as Array<{ code: string; action: string }>;
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const r of rows) (r.action === "deny" ? deny : allow).add(r.code);
  // Python returns sorted(...) into the rule; match exactly.
  return { allow: [...allow].sort(), deny: [...deny].sort() };
}

/**
 * Named requirement rules with advisor sets merged and bogus rules dropped.
 *
 * Reads `requirement_rule_effective` — NEVER the raw table. The view is the
 * materialised form of is_bogus_rule; reading the raw table here would report
 * requirements the audit engine itself refuses to honour, which is the exact
 * two-entry-points-disagreeing bug the Python docstring warns about.
 */
export function getRequirementRules(
  db: Db,
  year: string,
  name: string,
): RequirementRule[] {
  const cy = yearId(db, year);
  const pid = programId(db, cy, name, year);
  const rows = db
    .prepare("SELECT slot_type, rule FROM requirement_rule_effective WHERE program_id=?")
    .all(pid) as Array<{ slot_type: string; rule: string }>;

  return rows.map((r) => {
    const rule = parseJson<Record<string, unknown>>(r.rule, {});
    const { allow, deny } = advisorSets(db, r.slot_type, year, name);
    rule.advisor_courses = allow;
    rule.advisor_denies = deny;
    return { slot_type: r.slot_type, rule };
  });
}

/** University-wide General Education categories for a catalog year. */
export function getGenEd(db: Db, year: string): GenEdCategory[] {
  const cy = yearId(db, year);
  return (
    db
      .prepare(
        "SELECT name, min_credits, rules, allowed_courses FROM gen_ed_category WHERE catalog_year_id=?",
      )
      .all(cy) as Array<{
      name: string;
      min_credits: number | null;
      rules: unknown;
      allowed_courses: string | null;
    }>
  ).map((r) => ({
    name: r.name,
    min_credits: r.min_credits,
    rules: r.rules,
    allowed_courses: parseJson<unknown[]>(r.allowed_courses, []),
  }));
}

/**
 * Programs the given year actually has — the `known_programs` list Python puts
 * in its error envelope so a caller who named a program wrong is told what the
 * valid choices are. Same query and same ordering as query.py's _known_programs.
 */
export function knownPrograms(db: Db, year: string): string[] {
  return (
    db
      .prepare(
        `SELECT p.name AS name FROM program p
           JOIN catalog_year cy ON p.catalog_year_id = cy.id
          WHERE cy.label = ? AND p.kind IN ('major','pre_business')
          ORDER BY p.name`,
      )
      .all(year) as Array<{ name: string }>
  ).map((r) => r.name);
}

/** One course row by code, or null. Mirrors `dict(row) if row else None`. */
export function getCourse(db: Db, code: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT * FROM course WHERE code=?").get(code) as
    | Record<string, unknown>
    | undefined;
  return row ?? null;
}

/**
 * A stale-flag tripwire for `requirement_rule.bogus`.
 *
 * WHY (adversarial review, 2026-08-27): Python recomputes `is_bogus_rule` at
 * READ time; this module reads the flag MATERIALISED at write time via
 * `requirement_rule_effective`. They agree today — verified across all 1,083
 * rules — but only because every writer calls `refresh_bogus_flags`. Two ways
 * that breaks, both reproduced by the reviewer on a copy of the database:
 *
 *   1. an advisor_course row added without a refresh — Node then HIDES a real
 *      requirement the advisor curated;
 *   2. rules inserted by `ingest_year.py`, which never calls refresh, left at
 *      the column DEFAULT 0 — Node then ASSERTS a requirement the registrar
 *      never stated (the exact false-requirement class the filter exists to
 *      suppress).
 *
 * The second is the dangerous one, and it is detectable in pure SQL without
 * reimplementing the 128-line predicate: a credit_set rule that names no
 * courses, has no wildcards, and has no advisor entries can never be satisfied
 * by anything, so it must be flagged bogus. Any such rule with `bogus = 0` means
 * the flags are stale.
 *
 * Deliberately a HEURISTIC, and narrower than `is_bogus_rule` (it does not
 * attempt the gen-ed-shadow tier). It exists to fail loudly on the common stale
 * state, not to re-derive the semantics — those stay in Python, at build time.
 * Cheap enough for a health probe: one indexed-free scan of ~1k rows.
 */
export function findStaleBogusFlags(db: Db): Array<{
  program: string;
  catalog_year: string;
  slot_type: string;
}> {
  const rows = db
    .prepare(
      `SELECT p.name AS program, cy.label AS catalog_year,
              rr.slot_type AS slot_type, rr.rule AS rule
         FROM requirement_rule rr
         JOIN program p ON p.id = rr.program_id
         JOIN catalog_year cy ON cy.id = p.catalog_year_id
        WHERE rr.bogus = 0`,
    )
    .all() as Array<{ program: string; catalog_year: string; slot_type: string; rule: string }>;

  const stale: Array<{ program: string; catalog_year: string; slot_type: string }> = [];
  for (const r of rows) {
    const rule = parseJson<Record<string, unknown>>(r.rule, {});
    // Prose-schema rules (minors/certificates) are a different contract the
    // predicate does not judge — same carve-out Python makes first.
    if ("required_courses" in rule || !("raw_text" in rule)) continue;
    // A rule with its own `evaluator` is satisfied by a MECHANISM, not a course
    // list — "minor_or_course_set" means completing any minor qualifies — so an
    // empty explicit_courses is correct there, not vacuous. Omitting this check
    // made the first version of this tripwire report 8 false positives that
    // Python's is_bogus_rule returns False for; validated against that oracle
    // before shipping, which is the only reason it is not crying wolf now.
    if (typeof rule.evaluator === "string" && rule.evaluator.length > 0) continue;
    const explicit = Array.isArray(rule.explicit_courses) ? rule.explicit_courses : [];
    const wildcards = Array.isArray(rule.wildcards) ? rule.wildcards : [];
    if (explicit.length > 0 || wildcards.length > 0) continue;
    // Nothing explicit and no wildcards: only a curated advisor entry can save it.
    const { allow } = advisorSets(db, r.slot_type, r.catalog_year, r.program);
    if (allow.length > 0) continue;
    stale.push({ program: r.program, catalog_year: r.catalog_year, slot_type: r.slot_type });
  }
  return stale;
}
