from pathlib import Path
from gc_advisor.db.connection import get_connection
from gc_advisor.ingest.render import render_text, render_html
from gc_advisor.ingest.discover import parse_course_index, course_list_url
from gc_advisor.ingest.parse_course_page import parse_course_page
from gc_advisor.ingest.load import sync_courses
from gc_advisor.models import CourseRef

BASE = "https://catalog.clemson.edu"


def _fetch_page(catoid: int, navoid: int, cpage: int) -> list[CourseRef]:
    return parse_course_index(render_html(course_list_url(catoid, navoid, cpage)))


def discover_all_coids(catoid: int, navoid: int, fetch_page=_fetch_page,
                       max_pages: int = 200) -> list[CourseRef]:
    """Walk cpage=1.. until a page yields no NEW coids. De-dupes across pages."""
    seen, out = set(), []
    for cpage in range(1, max_pages + 1):
        refs = fetch_page(catoid, navoid, cpage)
        fresh = [r for r in refs if r.coid not in seen]
        if not fresh:
            break
        for r in fresh:
            seen.add(r.coid)
            out.append(r)
    return out


def _course_scrape_url(catoid: int, coid: int) -> str:
    # The ajax fragment: just the course block (~2 KB), far lighter to render
    # than the full page. parse_course_page handles its duplicated heading.
    return f"{BASE}/ajax/preview_course.php?catoid={catoid}&coid={coid}&show"


def _course_page_url(catoid: int, coid: int) -> str:
    # The shareable, human-facing standalone page — stored as course.source_url
    # for citation (analogous to program.source_url's preview_program.php form).
    return f"{BASE}/preview_course_nopop.php?catoid={catoid}&coid={coid}"


def crawl_courses(db_path, raw_root, *, catoid: int, navoid: int = 1988,
                  discover=discover_all_coids, render=render_text,
                  synced_at: str, on_progress=None) -> dict:
    """Discover all course coids, render+freeze+parse each (skipping coids already
    frozen at <raw_root>/courses/<coid>.txt), then sync into the course table.
    Returns {discovered, parsed, failed}."""
    raw_dir = Path(raw_root) / "courses"
    raw_dir.mkdir(parents=True, exist_ok=True)
    refs = discover(catoid=catoid, navoid=navoid)
    parsed, failed = [], []
    for i, ref in enumerate(refs):
        snap = raw_dir / f"{ref.coid}.txt"
        try:
            if snap.exists():
                text = snap.read_text()
            else:
                text = render(_course_scrape_url(catoid, ref.coid))
                snap.write_text(text)
            pc = parse_course_page(text)
            pc.source_url = _course_page_url(catoid, ref.coid)
            parsed.append(pc)
        except Exception as e:
            failed.append({"coid": ref.coid, "code": ref.code, "error": str(e)})
        if on_progress and (i + 1) % 100 == 0:
            on_progress(i + 1, len(refs))
    con = get_connection(db_path)
    sync_courses(con, parsed, synced_at=synced_at)
    con.close()
    return {"discovered": len(refs), "parsed": len(parsed), "failed": failed}
