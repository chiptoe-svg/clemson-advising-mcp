import sqlite3
import pytest
from gc_advisor.db.connection import init_db, get_connection, _migrate_program_kind_unique

# The pre-migration schema for the tables under test, verbatim from HEAD before
# this change (git show 5d9e7eb:src/gc_advisor/db/schema.sql). Building a DB
# from this text simulates an existing, un-migrated on-disk database.
OLD_SCHEMA = """
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
  UNIQUE(catalog_year_id, poid)
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
  rule       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS footnote (
  id          INTEGER PRIMARY KEY,
  program_id  INTEGER NOT NULL REFERENCES program(id),
  number      INTEGER NOT NULL,
  text        TEXT NOT NULL
);
"""


def _build_old_db(path):
    con = sqlite3.connect(str(path))
    con.executescript(OLD_SCHEMA)
    con.execute("INSERT INTO catalog_year(id, label, catoid) VALUES (1, '2026-2027', 49)")
    # program 100: a major at poid 16767 (this is the row that, pre-fix, wiped
    # out any pre_business program sharing its poid)
    con.execute(
        "INSERT INTO program(id, catalog_year_id, poid, name, kind, degree, "
        "total_credits, description, source_url, source_hash) VALUES "
        "(100, 1, 16767, 'Marketing, BS', 'major', 'BS', 120, 'd', 'u', 'h')")
    con.execute(
        "INSERT INTO requirement_group(id, program_id, label, kind, credit_total, ordering) "
        "VALUES (200, 100, 'Year 1', 'term', 15, 0)")
    con.execute(
        "INSERT INTO plan_item(id, group_id, kind, course_code, ordering) "
        "VALUES (300, 200, 'fixed_course', 'MKT 3010', 0)")
    con.execute(
        "INSERT INTO footnote(id, program_id, number, text) VALUES (400, 100, 1, 'note')")
    # program 101: a minor loaded via load_prose_program, exercising requirement_rule
    con.execute(
        "INSERT INTO program(id, catalog_year_id, poid, name, kind, degree, "
        "total_credits, description, source_url, source_hash) VALUES "
        "(101, 1, 16611, 'Accounting Minor', 'minor', NULL, 18, 'd', 'u', 'h')")
    con.execute(
        "INSERT INTO requirement_rule(id, program_id, slot_type, rule) "
        "VALUES (500, 101, 'program_requirement', '{}')")
    con.commit()
    con.close()


def _counts(con):
    return {
        "program": con.execute("SELECT COUNT(*) FROM program").fetchone()[0],
        "requirement_group": con.execute("SELECT COUNT(*) FROM requirement_group").fetchone()[0],
        "plan_item": con.execute("SELECT COUNT(*) FROM plan_item").fetchone()[0],
        "footnote": con.execute("SELECT COUNT(*) FROM footnote").fetchone()[0],
        "requirement_rule": con.execute("SELECT COUNT(*) FROM requirement_rule").fetchone()[0],
    }


def test_migration_preserves_ids_and_children_and_relaxes_constraint(tmp_path):
    db = tmp_path / "old.db"
    _build_old_db(db)
    con = sqlite3.connect(str(db))
    before = _counts(con)
    before_ids = {r[0] for r in con.execute("SELECT id FROM program")}
    con.close()

    init_db(db)  # must run the self-migration

    con = get_connection(db)
    after = _counts(con)
    after_ids = {r[0] for r in con.execute("SELECT id FROM program")}
    assert before == after
    assert before_ids == after_ids == {100, 101}

    # children still point at the same program ids -- nothing orphaned
    assert con.execute("SELECT program_id FROM requirement_group WHERE id=200").fetchone()[0] == 100
    assert con.execute("SELECT group_id FROM plan_item WHERE id=300").fetchone()[0] == 200
    assert con.execute("SELECT program_id FROM footnote WHERE id=400").fetchone()[0] == 100
    assert con.execute("SELECT program_id FROM requirement_rule WHERE id=500").fetchone()[0] == 101

    # the new constraint is (catalog_year_id, poid, kind): a different kind at
    # the same poid must now be insertable...
    con.execute(
        "INSERT INTO program(catalog_year_id, poid, name, kind, total_credits, description) "
        "VALUES (1, 16767, 'Pre-Business', 'pre_business', 21, 'd')")
    con.commit()
    # ...but a duplicate of the same (catalog_year_id, poid, kind) must still be rejected
    try:
        con.execute(
            "INSERT INTO program(catalog_year_id, poid, name, kind, total_credits, description) "
            "VALUES (1, 16767, 'Marketing, BS dup', 'major', 120, 'd')")
        con.commit()
        assert False, "expected UNIQUE constraint violation"
    except sqlite3.IntegrityError:
        pass
    con.close()


def _has_3col_unique_constraint(con):
    """True iff `program` has a table-defined (origin 'u') UNIQUE index on
    exactly (catalog_year_id, poid, kind)."""
    for idx in con.execute("PRAGMA index_list(program)").fetchall():
        if not idx[2] or idx[3] != "u":
            continue
        cols = [r[2] for r in con.execute(f"PRAGMA index_info({idx[1]})").fetchall()]
        if cols == ["catalog_year_id", "poid", "kind"]:
            return True
    return False


def _different_kind_insert_succeeds(con):
    """Insert a 2nd program at the same (catalog_year_id, poid) as program 100
    (poid 16767) but a different kind. Under the new 3-col constraint this
    must succeed; under the old 2-col constraint it would raise IntegrityError."""
    try:
        con.execute(
            "INSERT INTO program(catalog_year_id, poid, name, kind, total_credits, description) "
            "VALUES (1, 16767, 'Pre-Business', 'pre_business', 21, 'd')")
        con.commit()
        return True
    except sqlite3.IntegrityError:
        con.rollback()
        return False


def test_migration_is_idempotent(tmp_path):
    """Asserts the thing that actually matters: the 3-column unique
    constraint exists after the first init_db, still exists after a second
    init_db (idempotent, no raise), and a different-`kind` insert at an
    already-used (catalog_year_id, poid) succeeds after both runs -- not
    just that row counts/ids are unchanged across two no-op-shaped calls."""
    db = tmp_path / "old.db"
    _build_old_db(db)

    init_db(db)  # first run must perform the migration
    con = get_connection(db)
    assert _has_3col_unique_constraint(con), "3-col unique constraint missing after 1st init_db"
    con.close()

    init_db(db)  # second run must be a no-op, not raise
    con = get_connection(db)
    assert _has_3col_unique_constraint(con), "3-col unique constraint missing after 2nd init_db"
    assert _different_kind_insert_succeeds(con), \
        "different-kind insert at existing (catalog_year_id, poid) rejected after two init_db runs"
    con.close()


def test_migration_is_idempotent_is_red_proof(tmp_path, monkeypatch):
    """Companion to test_migration_is_idempotent: proves that test can
    actually fail. With the migration function stubbed out to a no-op (as
    it would be if deleted entirely), the old 2-col constraint survives
    init_db and the assertions above must fail."""
    import gc_advisor.db.connection as connection_mod
    monkeypatch.setattr(connection_mod, "_migrate_program_kind_unique", lambda con: None)

    db = tmp_path / "old.db"
    _build_old_db(db)
    init_db(db)
    con = get_connection(db)
    with pytest.raises(AssertionError):
        assert _has_3col_unique_constraint(con)
    con.close()


def test_fresh_db_already_has_new_constraint(tmp_path):
    db = tmp_path / "fresh.db"
    init_db(db)
    con = get_connection(db)
    con.execute(
        "INSERT INTO catalog_year(label, catoid) VALUES ('2026-2027', 49)")
    cy = con.execute("SELECT id FROM catalog_year").fetchone()[0]
    con.execute(
        "INSERT INTO program(catalog_year_id, poid, name, kind, total_credits, description) "
        "VALUES (?, 16767, 'Marketing, BS', 'major', 120, 'd')", (cy,))
    con.execute(
        "INSERT INTO program(catalog_year_id, poid, name, kind, total_credits, description) "
        "VALUES (?, 16767, 'Pre-Business', 'pre_business', 21, 'd')", (cy,))
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM program WHERE poid=16767").fetchone()[0]
    assert n == 2
    con.close()


# --- Fix 2: hardcoded column list must not silently drop an unknown column ---

def test_migration_raises_and_preserves_data_when_program_has_extra_column(tmp_path):
    """An old-constraint DB whose `program` table carries an extra, populated
    column that the migration's hardcoded rebuild DDL doesn't know about must
    make the migration RAISE (not silently drop the column) and must leave
    the pre-migration data completely intact -- the transaction rolls back."""
    db = tmp_path / "old.db"
    _build_old_db(db)
    con = sqlite3.connect(str(db))
    con.execute("ALTER TABLE program ADD COLUMN campus TEXT")
    con.execute("UPDATE program SET campus='Clemson Main' WHERE id=100")
    con.execute("UPDATE program SET campus='Online' WHERE id=101")
    con.commit()
    con.close()

    with pytest.raises(RuntimeError, match="campus"):
        init_db(db)

    # data must be untouched: still the old table, still 2 rows, extra
    # column and its values intact, old 2-col constraint still in force
    con = sqlite3.connect(str(db))
    rows = con.execute("SELECT id, campus FROM program ORDER BY id").fetchall()
    assert rows == [(100, "Clemson Main"), (101, "Online")]
    assert not _has_3col_unique_constraint(con)  # rollback means still unmigrated
    con.close()


# --- Fix 3: a later-added 3-col unique INDEX must not shadow the real 2-col constraint ---

def test_migration_not_shadowed_by_decoy_3col_unique_index(tmp_path):
    """A standalone `CREATE UNIQUE INDEX` covering (catalog_year_id, poid,
    kind) -- unrelated to this migration, e.g. added by some other feature
    -- is newer than the table's own old 2-col constraint and so is listed
    FIRST by `PRAGMA index_list` (newest-first). It must not be mistaken for
    evidence the table itself was already rebuilt: the migration must still
    run, driven off the table's real (origin='u') constraint."""
    db = tmp_path / "old.db"
    _build_old_db(db)
    con = sqlite3.connect(str(db))
    con.execute("CREATE UNIQUE INDEX ix_decoy ON program(catalog_year_id, poid, kind)")
    con.commit()
    # sanity: the decoy is listed before the real old constraint (newest-first)
    idx_names = [r[1] for r in con.execute("PRAGMA index_list(program)").fetchall()]
    assert idx_names[0] == "ix_decoy"
    con.close()

    init_db(db)  # must still migrate, not be fooled by the decoy

    con = get_connection(db)
    assert _has_3col_unique_constraint(con)
    assert _different_kind_insert_succeeds(con)
    con.close()


# --- Fix 4: a leftover program_new must not wedge init_db forever ---

def test_init_db_drops_leftover_program_new(tmp_path):
    """A `program_new` table left behind by e.g. a human's aborted manual
    migration attempt must not make init_db raise
    'table program_new already exists' forever."""
    db = tmp_path / "old.db"
    _build_old_db(db)
    con = sqlite3.connect(str(db))
    con.execute("CREATE TABLE program_new (id INTEGER PRIMARY KEY, junk TEXT)")
    con.execute("INSERT INTO program_new(junk) VALUES ('leftover from aborted attempt')")
    con.commit()
    con.close()

    init_db(db)  # must not raise "table program_new already exists"

    con = get_connection(db)
    assert _has_3col_unique_constraint(con)
    # the leftover table is gone, replaced by the real rebuilt `program`
    tables = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "program_new" not in tables
    con.close()


# --- Fix 5: PRAGMA foreign_key_check must run before commit ---

class _FKCheckFailingConnection(sqlite3.Connection):
    """A Connection whose PRAGMA foreign_key_check always reports one
    (synthetic) violation, everything else passed through unchanged."""

    def execute(self, sql, *args, **kwargs):
        if sql.strip() == "PRAGMA foreign_key_check":
            return super().execute("SELECT 'requirement_group', 1, 'program', 0")
        return super().execute(sql, *args, **kwargs)


def test_migration_runs_foreign_key_check_before_commit(tmp_path):
    """Step 10 of SQLite's table-rebuild procedure: PRAGMA foreign_key_check
    must run after the rename and before COMMIT. Exercised by forcing that
    pragma to report a (synthetic) violation via a Connection subclass, and
    confirming the migration raises and rolls back rather than committing.

    A cheap, real (non-synthetic) foreign_key_check violation could not be
    constructed here: `program.id` values are copied through unchanged by
    the rebuild's own INSERT...SELECT, and every existing child row already
    satisfies its foreign key against the pre-migration `program` table, so
    there is no way to make the rebuilt table legitimately orphan a child
    without the rebuild logic itself being buggy (sqlite3.Connection is a
    built-in type and cannot be monkeypatched directly, hence the
    subclass-via-factory approach). Forcing the pragma's result is the
    cheapest faithful way to prove the check-and-raise wiring actually runs
    and actually blocks the commit."""
    db = tmp_path / "old.db"
    _build_old_db(db)

    con = sqlite3.connect(str(db), factory=_FKCheckFailingConnection)
    con.execute("PRAGMA foreign_keys = ON")

    with pytest.raises(RuntimeError, match="foreign_key_check"):
        _migrate_program_kind_unique(con)

    # rolled back: still the old table with the old constraint, program row intact
    assert not _has_3col_unique_constraint(con)
    assert con.execute("SELECT id FROM program ORDER BY id").fetchall() == [(100,), (101,)]
    con.close()
