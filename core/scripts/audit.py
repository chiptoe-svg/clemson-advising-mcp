import argparse, json, sys
from pathlib import Path
from gc_advisor.audit.models import Progress
from gc_advisor.audit.engine import run_audit

DEFAULT_DB = Path(__file__).parent.parent / "db" / "catalog.db"

def main():
    ap = argparse.ArgumentParser(description="Audit gc-progress-v1 JSON (stdin or --progress file) -> audit JSON")
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--progress", default="-", help="path to progress JSON, or '-' for stdin")
    args = ap.parse_args()
    raw = sys.stdin.read() if args.progress == "-" else Path(args.progress).read_text()
    try:
        progress = Progress.from_dict(json.loads(raw))
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        print(json.dumps({"error": f"invalid progress payload: {e}"}))
        sys.exit(2)  # exit 2 = structured JSON error envelope, same as query.py (P5)
    print(json.dumps(run_audit(args.db, progress), indent=2))

if __name__ == "__main__":
    main()
