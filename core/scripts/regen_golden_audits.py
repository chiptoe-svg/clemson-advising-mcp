"""Regenerate the golden audit snapshots in tests/fixtures/golden/.

The goldens freeze run_audit's output for every tests/fixtures/progress_*.json
payload so a refactor that must not change GC behavior is proven not to.

Run this ONLY when a change to the output is intended and reviewed — a diff
here is the whole signal the golden test exists to produce. Note that the
goldens depend on db/catalog.db, so a catalog re-ingest can also move them;
inspect the diff before committing to tell data drift from a code regression.
"""
import argparse, json
from pathlib import Path
from gc_advisor.audit.models import Progress
from gc_advisor.audit.engine import run_audit

ROOT = Path(__file__).parent.parent
DEFAULT_DB = ROOT / "db" / "catalog.db"
FIXTURES = ROOT / "tests" / "fixtures"
GOLDEN = FIXTURES / "golden"


def cases() -> list[Path]:
    return sorted(FIXTURES.glob("progress_*.json"))


def regen(db: Path) -> list[str]:
    GOLDEN.mkdir(exist_ok=True)
    written = []
    for src in cases():
        progress = Progress.from_dict(json.loads(src.read_text()))
        out = run_audit(str(db), progress)
        dst = GOLDEN / f"{src.stem}.audit.json"
        dst.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")
        written.append(dst.name)
    return written


def main():
    ap = argparse.ArgumentParser(description="Regenerate golden audit snapshots")
    ap.add_argument("--db", default=str(DEFAULT_DB))
    args = ap.parse_args()
    for name in regen(Path(args.db)):
        print(f"wrote {name}")


if __name__ == "__main__":
    main()
