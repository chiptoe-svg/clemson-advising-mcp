// test/_catalog-fixture-ddl.ts
//
// The hand-written catalog.db fixture schema, in ONE place.
//
// Two test files build a hermetic catalog DB rather than reading the live
// core/db/catalog.db, so they do not drift when that project's DATA changes.
// The cost is that they can drift from its SCHEMA instead — silently, because a
// fixture that is merely out of date still answers every query the test asks.
// test/fixture-schema-drift.test.ts pins these DDLs against
// core/src/gc_advisor/db/schema.sql; keeping one copy means that guard has one
// thing to check rather than two.
//
// Constraints here are deliberately LOOSER than the real schema (poid nullable,
// `kind` defaulted, no UNIQUE(catalog_year_id, poid, kind)) so a fixture row can
// be written with three columns instead of ten. The drift test therefore
// compares COLUMN NAMES, not constraints — plus the view's SQL verbatim, because
// requirement_rule_effective is the contract surface direct readers depend on
// and its column list and WHERE clause ARE the contract.
//
// Tables are opt-in per file: requirement_group and plan_item exist only in the
// fixture that needs them, because the difference between "table missing" and
// "table empty" is a thrown error vs. an empty result, and at least one code
// path (clemson-advising.ts's program lookup) can tell them apart.

/** One CREATE statement per object, keyed by the name it creates. */
export const CATALOG_FIXTURE_DDL: Record<string, string> = {
  catalog_year: `
    CREATE TABLE catalog_year (
      id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE, catoid INTEGER,
      level TEXT NOT NULL DEFAULT 'undergraduate', source_urls TEXT, ingested_at TEXT
    );`,

  program: `
    CREATE TABLE program (
      id INTEGER PRIMARY KEY, catalog_year_id INTEGER NOT NULL REFERENCES catalog_year(id),
      poid INTEGER, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'major',
      degree TEXT, total_credits INTEGER, description TEXT, source_url TEXT, source_hash TEXT
    );`,

  requirement_rule: `
    CREATE TABLE requirement_rule (
      id INTEGER PRIMARY KEY, program_id INTEGER NOT NULL REFERENCES program(id),
      slot_type TEXT NOT NULL, rule TEXT NOT NULL, bogus INTEGER NOT NULL DEFAULT 0
    );`,

  // Copied from core/src/gc_advisor/db/schema.sql, which says so in its own
  // comment: "CONSUMERS COPY THIS DDL INTO THEIR FIXTURES (CUassistant does)".
  // The bogus flag is materialised by core's writers from
  // rule_semantics.is_bogus_rule; the view hides exactly what CatalogAccess hides.
  requirement_rule_effective: `
    CREATE VIEW requirement_rule_effective AS
      SELECT id, program_id, slot_type, rule FROM requirement_rule WHERE bogus = 0;`,

  requirement_group: `
    CREATE TABLE requirement_group (
      id INTEGER PRIMARY KEY, program_id INTEGER NOT NULL REFERENCES program(id),
      parent_group_id INTEGER REFERENCES requirement_group(id),
      label TEXT, kind TEXT, credit_total INTEGER, ordering INTEGER
    );`,

  plan_item: `
    CREATE TABLE plan_item (
      id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES requirement_group(id),
      kind TEXT, course_code TEXT, one_of TEXT, slot_type TEXT,
      credits INTEGER, footnote_refs TEXT, ordering INTEGER
    );`,

  course: `
    CREATE TABLE course (
      code TEXT PRIMARY KEY, subject TEXT NOT NULL, number TEXT NOT NULL,
      title TEXT, credits TEXT, description TEXT, prereq_text TEXT, prereq_parsed TEXT,
      coreq_text TEXT, coreq_parsed TEXT, terms_offered TEXT, restrictions TEXT,
      cross_listed_as TEXT, status TEXT NOT NULL DEFAULT 'active',
      first_seen TEXT, last_synced TEXT, source_url TEXT
    );`,
};

/** Every object this fixture schema knows how to create. */
export const CATALOG_FIXTURE_OBJECTS = Object.keys(CATALOG_FIXTURE_DDL);

/**
 * The DDL for the named objects, in the order given, ready for `db.exec`.
 * Order matters: requirement_rule_effective needs requirement_rule, and
 * plan_item needs requirement_group.
 */
export function catalogFixtureDdl(...names: string[]): string {
  return names
    .map((name) => {
      const ddl = CATALOG_FIXTURE_DDL[name];
      if (!ddl) throw new Error(`no fixture DDL for "${name}"`);
      return ddl;
    })
    .join("\n");
}
