import json
from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.coreqs import derive_lab_pairs, backfill_coreqs


def _course(con, code, description="", coreq_parsed=None):
    subj, num = code.split(" ")
    con.execute(
        "INSERT INTO course (code, subject, number, description, coreq_parsed) "
        "VALUES (?,?,?,?,?)", (code, subj, num, description, coreq_parsed))
    con.commit()


def _db(tmp_path):
    p = tmp_path / "t.db"
    init_db(p)
    return get_connection(p)


def test_derive_lab_pairs(tmp_path):
    con = _db(tmp_path)
    _course(con, "GC 4061", "Non-credit laboratory to accompany GC 4060.")
    _course(con, "GC 4060", "Lecture course.")
    assert derive_lab_pairs(con) == {"GC 4061": ["GC 4060"]}


def test_multi_code_accompany(tmp_path):
    # "accompany BIOL 1220 or BIOL 1230" -> the lab pairs with BOTH lectures.
    con = _db(tmp_path)
    _course(con, "BIOL 1200", "Laboratory to accompany BIOL 1220 or BIOL 1230 for non-majors.")
    _course(con, "BIOL 1220", "Lecture.")
    _course(con, "BIOL 1230", "Lecture.")
    backfill_coreqs(con)
    lab = con.execute("SELECT coreq_parsed FROM course WHERE code='BIOL 1200'").fetchone()
    assert set(json.loads(lab["coreq_parsed"])) == {"BIOL 1220", "BIOL 1230"}
    # bidirectional: each lecture points back to the shared lab
    for lec in ("BIOL 1220", "BIOL 1230"):
        row = con.execute("SELECT coreq_parsed FROM course WHERE code=?", (lec,)).fetchone()
        assert json.loads(row["coreq_parsed"]) == ["BIOL 1200"]


def test_accompany_without_code_is_excluded(tmp_path):
    # Prose "accompany" with no course code must not create a coreq.
    con = _db(tmp_path)
    _course(con, "ASL 3100", "Study of the gestures that accompany speech.")
    backfill_coreqs(con)
    row = con.execute("SELECT coreq_parsed FROM course WHERE code='ASL 3100'").fetchone()
    assert row["coreq_parsed"] in (None, "", "[]")


def test_backfill_is_bidirectional(tmp_path):
    con = _db(tmp_path)
    _course(con, "GC 4061", "Non-credit laboratory to accompany GC 4060.")
    _course(con, "GC 4060", "Lecture course.")
    assert backfill_coreqs(con) == 2
    lab = con.execute("SELECT coreq_parsed, coreq_text FROM course WHERE code='GC 4061'").fetchone()
    lec = con.execute("SELECT coreq_parsed, coreq_text FROM course WHERE code='GC 4060'").fetchone()
    assert json.loads(lab["coreq_parsed"]) == ["GC 4060"] and lab["coreq_text"] == "GC 4060"
    assert json.loads(lec["coreq_parsed"]) == ["GC 4061"] and lec["coreq_text"] == "GC 4061"


def test_no_false_pairs(tmp_path):
    con = _db(tmp_path)
    _course(con, "GC 3010", "A course with no accompanying lab.")
    backfill_coreqs(con)
    row = con.execute("SELECT coreq_parsed FROM course WHERE code='GC 3010'").fetchone()
    assert row["coreq_parsed"] in (None, "", "[]")


def test_idempotent(tmp_path):
    con = _db(tmp_path)
    _course(con, "GC 4061", "Non-credit laboratory to accompany GC 4060.")
    _course(con, "GC 4060", "Lecture course.")
    assert backfill_coreqs(con) == 2
    assert backfill_coreqs(con) == 0  # second run changes nothing
    lab = con.execute("SELECT coreq_parsed FROM course WHERE code='GC 4061'").fetchone()
    assert json.loads(lab["coreq_parsed"]) == ["GC 4060"]


def test_does_not_clobber_existing_coreq(tmp_path):
    con = _db(tmp_path)
    # A real catalog coreq already present on the lecture.
    _course(con, "GC 4061", "Non-credit laboratory to accompany GC 4060.")
    _course(con, "GC 4060", "Lecture course.", coreq_parsed='["GC 9999"]')
    backfill_coreqs(con)
    lec = con.execute("SELECT coreq_parsed FROM course WHERE code='GC 4060'").fetchone()
    assert json.loads(lec["coreq_parsed"]) == ["GC 9999"]  # untouched
