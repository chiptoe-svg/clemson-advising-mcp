"""Offline backfill of course.source_url from frozen course snapshots.

Each frozen snapshot is named by its Acalog coid (<coid>.txt), and parsing it
yields the course code — so we can populate course.source_url with the shareable
catalog page (preview_course_nopop.php) without any network crawl. Idempotent:
only fills rows whose source_url is empty (never clobbers an existing value)."""
from pathlib import Path

from gc_advisor.ingest.parse_course_page import parse_course_page

BASE = "https://catalog.clemson.edu"


def course_page_url(catoid: int, coid: int) -> str:
    return f"{BASE}/preview_course_nopop.php?catoid={catoid}&coid={coid}"


def backfill_course_source_urls(con, raw_dir, catoid: int) -> int:
    """Fill course.source_url from <raw_dir>/<coid>.txt snapshots. Returns the
    number of course rows updated."""
    updated = 0
    for f in sorted(Path(raw_dir).glob("*.txt")):
        try:
            coid = int(f.stem)
        except ValueError:
            continue
        try:
            code = parse_course_page(f.read_text()).code
        except Exception:
            continue  # unparseable snapshot — skip, don't guess
        cur = con.execute(
            "UPDATE course SET source_url=? "
            "WHERE code=? AND (source_url IS NULL OR source_url='')",
            (course_page_url(catoid, coid), code))
        updated += cur.rowcount
    con.commit()
    return updated
