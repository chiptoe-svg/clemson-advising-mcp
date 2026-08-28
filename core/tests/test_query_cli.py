import json, os, subprocess, sys
from pathlib import Path
from gc_advisor.db.connection import init_db, get_connection
from gc_advisor.ingest.parse_program import parse_program
from gc_advisor.ingest.load import ensure_catalog_year, load_program

ROOT = Path(__file__).parent.parent

def test_query_cli_program_plan(tmp_path, fixtures_dir):
    db = tmp_path / "t.db"; init_db(db); con = get_connection(db)
    cy = ensure_catalog_year(con, "2026-2027", 49)
    prog = parse_program((fixtures_dir / "gc_program_2026.txt").read_text(),
                         kind="major", degree="BS")
    load_program(con, cy, prog, poid=16765, source_url="u", source_hash="h"); con.close()
    out = subprocess.check_output(
        [sys.executable, str(ROOT / "scripts" / "query.py"),
         "--db", str(db), "program-plan", "--year", "2026-2027",
         "--name", "Graphic Communications, BS"],
        env={**os.environ, "PYTHONPATH": str(ROOT / "src")})
    data = json.loads(out)
    assert data["total_credits"] == 120


def test_unknown_program_is_a_clean_json_error_not_a_traceback(tmp_path):
    """CUassistant relays our stderr verbatim to the advising model; a raw
    KeyError traceback there is contract garbage. Unknown program -> exit 2,
    one-line JSON error naming the known programs (handoff CLI-contract note,
    2026-08-25)."""
    import json as _json
    import subprocess, sys
    from pathlib import Path
    root = Path(__file__).parent.parent
    r = subprocess.run(
        [sys.executable, str(root / "scripts" / "query.py"),
         "req-rules", "--year", "2026-2027", "--name", "Economics"],
        capture_output=True, text=True, cwd=root,
        env={"PYTHONPATH": str(root / "src"), "PATH": "/usr/bin:/bin"})
    assert r.returncode == 2, (r.returncode, r.stderr[-300:])
    assert "Traceback" not in r.stderr
    err = _json.loads(r.stdout)
    assert "Economics" in err["error"]
    assert any("Economics, BS" in k for k in err["known_programs"])


def test_audit_error_envelope_exits_2_like_query(tmp_path):
    """P5 (2026-08-26 operational review): audit.py exited 1 on its error
    envelope while query.py exits 2, so the consumer's GcCliError path never
    fired for audits. The contract is exit 2 = structured JSON error."""
    import json as _json
    import subprocess, sys
    from pathlib import Path
    root = Path(__file__).parent.parent
    r = subprocess.run(
        [sys.executable, str(root / "scripts" / "audit.py")],
        input='{"version":"wrong-v9","catalog_year":"2026-2027"}',
        capture_output=True, text=True, cwd=root,
        env={"PYTHONPATH": str(root / "src"), "PATH": "/usr/bin:/bin"})
    assert r.returncode == 2, (r.returncode, r.stderr[-200:])
    assert "error" in _json.loads(r.stdout)
