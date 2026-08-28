import json, subprocess, sys
from pathlib import Path
from gc_advisor.db.connection import init_db

SCRIPT = Path(__file__).parent.parent / "scripts" / "manage_advisor_list.py"

def _run(db, *args):
    return subprocess.run([sys.executable, str(SCRIPT), "--db", str(db), *args],
                          capture_output=True, text=True,
                          env={"PYTHONPATH": "src"}, cwd=SCRIPT.parent.parent)

def test_add_list_remove_roundtrip(tmp_path):
    db = tmp_path / "t.db"; init_db(db)
    assert _run(db, "add", "--slot", "specialty", "--code", "MKT 4290",
                "--note", "vote 2026-03").returncode == 0
    out = _run(db, "list", "--slot", "specialty")
    assert "MKT 4290" in out.stdout
    assert _run(db, "remove", "--slot", "specialty", "--code", "MKT 4290").returncode == 0
    out2 = _run(db, "list", "--slot", "specialty")
    assert "MKT 4290" not in out2.stdout
