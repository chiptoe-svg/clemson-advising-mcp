from pathlib import Path
from gc_advisor.ingest.render import render_html, render_text

FIX = Path(__file__).parent.parent / "tests" / "fixtures"
BASE = "https://catalog.clemson.edu"
LIST = (f"{BASE}/content.php?catoid=49&navoid=1988&filter%5Bitem_type%5D=3"
        "&filter%5Bonly_active%5D=1&filter%5B3%5D=1&filter%5Bcpage%5D=1")
(FIX / "courses_listing_2026.html").write_text(render_html(LIST))
(FIX / "course_acct2010.txt").write_text(
    render_text(f"{BASE}/preview_course_nopop.php?catoid=49&coid=283320"))
(FIX / "course_acct3110.txt").write_text(
    render_text(f"{BASE}/preview_course_nopop.php?catoid=49&coid=283323"))
print("captured course fixtures")
