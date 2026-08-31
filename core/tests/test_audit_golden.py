"""Golden (characterization) tests for run_audit.

These freeze today's audit output for every tests/fixtures/progress_*.json
payload. Their purpose is narrow and deliberate: the planned rules-as-data
refactor (declared `evaluator` in place of the "Specialty Area" string
dispatch, capped-department flag text interpolated from rule data) must not
change GC behavior at all, and these prove it independently of whoever writes
that refactor.

The payloads cover the three branches that refactor touches:
  progress_complete            -> specialty satisfied via an approved minor
  progress_specialty_courseset -> specialty via a 15cr wildcard course set
  progress_specialty_capped    -> BIOL/CH/PHYS aggregate cap + both flags
plus an empty and a partial payload as baselines, and progress_offcatalog,
which carries courses absent from the catalog so the "not in course catalog"
flag list is exercised — that list is built from a set, and before it was
sorted its order varied per process, which would have made every golden here
quietly unreproducible.

A failure here means output moved. Regenerate ONLY when that is intended:
    .venv/bin/python scripts/regen_golden_audits.py
The goldens also depend on db/catalog.db, so a catalog re-ingest can move
them too — read the diff to tell data drift from a code regression.
"""
import json
from pathlib import Path
import pytest
from gc_advisor.audit.models import Progress
from gc_advisor.audit.engine import run_audit

DB = Path(__file__).parent.parent / "db" / "catalog.db"
GOLDEN = Path(__file__).parent / "fixtures" / "golden"

pytestmark = pytest.mark.skipif(not DB.exists(), reason="catalog DB not present")

CASES = sorted(p.stem.replace(".audit", "") for p in GOLDEN.glob("*.audit.json"))


def _audit(name: str, fixtures_dir: Path) -> dict:
    payload = json.loads((fixtures_dir / f"{name}.json").read_text())
    return run_audit(str(DB), Progress.from_dict(payload))


def test_golden_cases_exist():
    """Guard against a vacuous suite: no goldens means every case below is
    silently skipped by parametrisation over an empty list."""
    assert CASES, "no golden snapshots found — run scripts/regen_golden_audits.py"


@pytest.mark.parametrize("name", CASES)
def test_audit_matches_golden(name, fixtures_dir):
    expected = json.loads((GOLDEN / f"{name}.audit.json").read_text())
    assert _audit(name, fixtures_dir) == expected


def test_audit_is_deterministic_across_processes(fixtures_dir):
    """A golden is only meaningful if output is stable ACROSS processes.

    Same-process repetition cannot catch this: PYTHONHASHSEED is fixed for a
    process, so set-iteration order is stable within one run and varies only
    between runs. This re-audits every case in a subprocess under a different
    seed and requires identical output.
    """
    import os, subprocess, sys
    script = (
        "import json,sys;"
        "sys.path.insert(0, %r);"
        "from gc_advisor.audit.models import Progress;"
        "from gc_advisor.audit.engine import run_audit;"
        "cases=json.loads(sys.argv[1]);"
        "print(json.dumps({n: run_audit(%r, Progress.from_dict("
        "json.loads(open(%r + '/' + n + '.json').read()))) for n in cases}))"
        % (str(Path(__file__).parent.parent / "src"), str(DB), str(fixtures_dir))
    )
    env = {**os.environ, "PYTHONHASHSEED": "12345"}
    out = subprocess.run([sys.executable, "-c", script, json.dumps(CASES)],
                         capture_output=True, text=True, env=env, check=True)
    other = json.loads(out.stdout)
    for name in CASES:
        assert _audit(name, fixtures_dir) == other[name], f"{name} varies by process"
