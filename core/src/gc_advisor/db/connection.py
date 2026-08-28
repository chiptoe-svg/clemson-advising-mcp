import sqlite3
from pathlib import Path

SCHEMA_PATH = Path(__file__).parent / "schema.sql"

def get_connection(db_path: str | Path) -> sqlite3.Connection:
    con = sqlite3.connect(str(db_path))
    con.execute("PRAGMA foreign_keys = ON")
    con.row_factory = sqlite3.Row
    return con

def init_db(db_path: str | Path) -> None:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    con = get_connection(db_path)
    try:
        con.executescript(SCHEMA_PATH.read_text())
        # self-migrate: add the bogus column on older DBs (the view above is
        # CREATE IF NOT EXISTS but references the column, so column first)
        cols = [r[1] for r in con.execute("PRAGMA table_info(requirement_rule)")]
        if "bogus" not in cols:
            con.execute("ALTER TABLE requirement_rule ADD COLUMN bogus INTEGER NOT NULL DEFAULT 0")
            con.execute("DROP VIEW IF EXISTS requirement_rule_effective")
            con.execute(
                "CREATE VIEW requirement_rule_effective AS "
                "SELECT id, program_id, slot_type, rule FROM requirement_rule WHERE bogus = 0")
        con.commit()
        _migrate_program_kind_unique(con)
    finally:
        con.close()


def _migrate_program_kind_unique(con: sqlite3.Connection) -> None:
    """Rebuild `program` so its uniqueness is (catalog_year_id, poid, kind)
    instead of the old (catalog_year_id, poid).

    One Clemson catalog page (one poid) can yield two logically distinct
    programs -- e.g. a business major's page also yields Pre-Business -- and
    the old 2-column constraint made the second insert collide with the
    first. `schema.sql` uses CREATE TABLE IF NOT EXISTS, so an existing
    on-disk database keeps its old `program` table untouched after the
    executescript above; this rebuilds it in place.

    Invariant held at every instant, including across an interrupted run:
    the on-disk `program` table is either the untouched pre-migration table
    (old 2-column constraint) or the fully-renamed post-migration table (new
    3-column constraint) -- never a dropped/half-built intermediate. The
    entire rebuild runs inside one explicit transaction, so a kill mid-way
    leaves nothing committed and the pre-migration table intact.

    `program.id` is referenced by requirement_group, requirement_rule and
    footnote, so every id is copied through unchanged.

    Idempotent: a no-op if the old 2-column constraint is not present
    (fresh DB, or already migrated).

    Detection scans every unique index on `program` (`PRAGMA index_list`
    returns newest-first, so it does NOT stop at the first 3-column unique
    index it sees -- an unrelated later 3-col unique index must not shadow
    the old 2-col one and silently skip the rebuild) and only rebuilds when
    the old 2-column constraint is present and the new 3-column one is not.
    Only indexes with origin 'u' (i.e. defined by the table's own inline
    UNIQUE(...) clause, not a standalone `CREATE UNIQUE INDEX`) count: an
    explicitly-created index that happens to cover the same 3 columns is a
    distinct artifact from the table's real constraint and must not be
    mistaken for evidence the table itself was rebuilt.

    Column-loss safety: the rebuilt table's column set (name/type/notnull/
    dflt_value/pk) is compared against the original's, captured via
    `PRAGMA table_info(program)` before the rebuild starts. Today's rebuild
    DDL is a hardcoded 10-column literal; if `program` ever gains a column
    this hardcoded list doesn't know about, that column would otherwise be
    silently dropped with no error. The comparison runs before COMMIT and
    raises (rolling back the transaction) on any mismatch, so a lossy
    rebuild fails loudly instead of committing.

    Before creating `program_new`, any leftover `program_new` table (e.g.
    from a human's aborted manual migration attempt -- our own code never
    leaves one, per the fuzz-tested crash-safety of this function) is
    dropped so `init_db` cannot wedge forever on "table already exists".

    `PRAGMA foreign_key_check` runs after the rename and before COMMIT
    (step 10 of SQLite's documented table-rebuild procedure); any row it
    returns means the rebuild would orphan a child, so the transaction is
    rolled back instead of committed.

    Known, accepted cost: `_delete_program` (see ingest/load.py) now
    matches on `kind` as well as `(catalog_year_id, poid)`. If a program's
    `kind` changes between crawls -- e.g. it moves from the minor index
    page to the certificate index page while keeping the same poid -- the
    old-kind row is no longer matched by `_delete_program` and is not
    replaced; a stale row is left behind at the same `(catalog_year_id,
    poid)` alongside the new-kind row. This migration does not detect or
    clean up such staleness -- it is a documented gap, not a bug, and zero
    such duplicates exist in the current dataset as of this writing.
    """
    has_old_2col = False
    has_new_3col = False
    for idx in con.execute("PRAGMA index_list(program)").fetchall():
        is_unique = idx[2]
        origin = idx[3]
        if not is_unique or origin != "u":
            continue  # skip non-unique indexes and standalone CREATE INDEX artifacts
        cols = [r[2] for r in con.execute(f"PRAGMA index_info({idx[1]})").fetchall()]
        if cols == ["catalog_year_id", "poid", "kind"]:
            has_new_3col = True
        elif cols == ["catalog_year_id", "poid"]:
            has_old_2col = True
    if not has_old_2col or has_new_3col:
        return  # already migrated, or nothing to migrate

    original_columns = [tuple(r[1:6]) for r in con.execute("PRAGMA table_info(program)").fetchall()]

    fk_was_on = con.execute("PRAGMA foreign_keys").fetchone()[0]
    con.execute("PRAGMA foreign_keys = OFF")
    try:
        con.execute("BEGIN IMMEDIATE")
        con.execute("DROP TABLE IF EXISTS program_new")
        con.execute("""
            CREATE TABLE program_new (
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
            )
        """)
        con.execute("""
            INSERT INTO program_new(id, catalog_year_id, poid, name, kind, degree,
                total_credits, description, source_url, source_hash)
            SELECT id, catalog_year_id, poid, name, kind, degree,
                total_credits, description, source_url, source_hash
            FROM program
        """)

        new_columns = [tuple(r[1:6]) for r in con.execute("PRAGMA table_info(program_new)").fetchall()]
        if original_columns != new_columns:
            original_by_name = {c[0]: c for c in original_columns}
            new_by_name = {c[0]: c for c in new_columns}
            missing = sorted(original_by_name.keys() - new_by_name.keys())
            added = sorted(new_by_name.keys() - original_by_name.keys())
            changed = sorted(
                name for name in (original_by_name.keys() & new_by_name.keys())
                if original_by_name[name] != new_by_name[name]
            )
            raise RuntimeError(
                "refusing to commit lossy program rebuild: column mismatch "
                f"between original and rebuilt table (missing={missing}, "
                f"added={added}, changed={changed})"
            )

        con.execute("DROP TABLE program")
        con.execute("ALTER TABLE program_new RENAME TO program")

        fk_violations = con.execute("PRAGMA foreign_key_check").fetchall()
        if fk_violations:
            raise RuntimeError(
                f"refusing to commit program rebuild: foreign_key_check found "
                f"{len(fk_violations)} violation(s): {fk_violations}"
            )

        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.execute(f"PRAGMA foreign_keys = {'ON' if fk_was_on else 'OFF'}")
