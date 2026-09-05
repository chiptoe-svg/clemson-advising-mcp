CREATE TABLE IF NOT EXISTS catalog_year (
  id          INTEGER PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,
  catoid      INTEGER NOT NULL UNIQUE,
  level       TEXT NOT NULL DEFAULT 'undergraduate',
  source_urls TEXT,
  ingested_at TEXT
);

CREATE TABLE IF NOT EXISTS program (
  id              INTEGER PRIMARY KEY,
  catalog_year_id INTEGER NOT NULL REFERENCES catalog_year(id),
  poid            INTEGER NOT NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  degree          TEXT,
  total_credits   INTEGER,
  description     TEXT,
  source_url      TEXT,
  source_hash     TEXT,
  UNIQUE(catalog_year_id, poid, kind)
);

CREATE TABLE IF NOT EXISTS requirement_group (
  id              INTEGER PRIMARY KEY,
  program_id      INTEGER NOT NULL REFERENCES program(id),
  parent_group_id INTEGER REFERENCES requirement_group(id),
  label           TEXT,
  kind            TEXT NOT NULL,
  credit_total    INTEGER,
  ordering        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plan_item (
  id           INTEGER PRIMARY KEY,
  group_id     INTEGER NOT NULL REFERENCES requirement_group(id),
  kind         TEXT NOT NULL,
  course_code  TEXT,
  one_of       TEXT,
  slot_type    TEXT,
  credits      INTEGER,
  footnote_refs TEXT,
  ordering     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requirement_rule (
  id         INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES program(id),
  slot_type  TEXT NOT NULL,
  rule       TEXT NOT NULL,
  -- Materialized verdict of audit.rule_semantics.is_bogus_rule, refreshed by
  -- every writer (backfill_requirements, apply_pack, manage_advisor_list).
  -- Exists so DIRECT SQL readers (CUassistant ATTACHes this DB) agree with
  -- CatalogAccess; never computed in SQL — the Python function is the truth.
  bogus      INTEGER NOT NULL DEFAULT 0
);

-- The contract surface for direct readers: rules an audit actually enforces.
-- CONSUMERS COPY THIS DDL INTO THEIR FIXTURES (CUassistant does): any change
-- to this view's column list or semantics is a consumer contract change —
-- announce it (keep-cuassistant-apprised) and expect their fixture update.
CREATE VIEW IF NOT EXISTS requirement_rule_effective AS
  SELECT id, program_id, slot_type, rule FROM requirement_rule WHERE bogus = 0;

CREATE TABLE IF NOT EXISTS gen_ed_category (
  id              INTEGER PRIMARY KEY,
  catalog_year_id INTEGER NOT NULL REFERENCES catalog_year(id),
  name            TEXT NOT NULL,
  min_credits     INTEGER,
  rules           TEXT,
  allowed_courses TEXT,
  learning_outcome TEXT,
  subcategories   TEXT  -- JSON list of published sub-lists; NULL = no split shown
);

CREATE TABLE IF NOT EXISTS academic_regulation (
  id              INTEGER PRIMARY KEY,
  catalog_year_id INTEGER NOT NULL REFERENCES catalog_year(id),
  section         TEXT NOT NULL,
  text            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS footnote (
  id          INTEGER PRIMARY KEY,
  program_id  INTEGER NOT NULL REFERENCES program(id),
  number      INTEGER NOT NULL,
  text        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS course (
  code           TEXT PRIMARY KEY,
  subject        TEXT NOT NULL,
  number         TEXT NOT NULL,
  title          TEXT,
  credits        TEXT,
  description    TEXT,
  prereq_text    TEXT,
  prereq_parsed  TEXT,
  coreq_text     TEXT,
  coreq_parsed   TEXT,
  terms_offered  TEXT,
  restrictions   TEXT,
  cross_listed_as TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  first_seen     TEXT,
  last_synced    TEXT,
  source_url     TEXT
);

CREATE TABLE IF NOT EXISTS source_snapshot (
  id           INTEGER PRIMARY KEY,
  url          TEXT NOT NULL,
  catoid       INTEGER,
  poid         INTEGER,
  fetched_at   TEXT,
  raw_path     TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS advisor_course (
  id           INTEGER PRIMARY KEY,
  program      TEXT NOT NULL DEFAULT 'Graphic Communications, BS',
  slot_type    TEXT NOT NULL,
  catalog_year TEXT,                         -- NULL = applies to all years
  code         TEXT NOT NULL,
  action       TEXT NOT NULL DEFAULT 'allow' CHECK (action IN ('allow','deny')),
  note         TEXT,
  added_on     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_advisor_course_slot
  ON advisor_course(program, slot_type, catalog_year);
-- One advisor stance per (program, slot, year, course): a double `add` is a
-- no-op via INSERT OR IGNORE. IFNULL collapses NULL (all-years) so those dedupe
-- too — SQLite otherwise treats NULLs as distinct in a UNIQUE index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_course_unique
  ON advisor_course(program, slot_type, IFNULL(catalog_year, ''), code);
