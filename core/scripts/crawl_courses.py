import argparse
import os
from pathlib import Path
from gc_advisor.db.connection import init_db
from gc_advisor.ingest.crawl_courses import crawl_courses

ROOT = Path(__file__).parent.parent
# GC_INGEST_DB overrides the target DB (scratch rebuilds; deliberately NOT
# GC_ADVISOR_DB, which the service config reads — an exported override must
# never repoint the live daemons).
DB = Path(os.environ["GC_INGEST_DB"]) if os.environ.get("GC_INGEST_DB") else ROOT / "db" / "gc_advisor.db"
RAW = ROOT / "data" / "raw"

def main():
    ap = argparse.ArgumentParser(description="Crawl the full Clemson course catalog")
    ap.add_argument("--catoid", type=int, default=49)
    ap.add_argument("--navoid", type=int, default=1988)
    ap.add_argument("--synced-at", default="2026-06-23")
    args = ap.parse_args()
    init_db(DB)
    res = crawl_courses(DB, RAW, catoid=args.catoid, navoid=args.navoid,
                        synced_at=args.synced_at,
                        on_progress=lambda d, t: print(f"  ... {d}/{t} courses", flush=True))
    print(f"discovered={res['discovered']} parsed={res['parsed']} failed={len(res['failed'])}")
    for f in res["failed"][:20]:
        print(f"  ! {f['code']} (coid {f['coid']}): {f['error']}")

if __name__ == "__main__":
    main()
