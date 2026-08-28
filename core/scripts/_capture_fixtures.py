from pathlib import Path
from gc_advisor.ingest.render import render_text, render_html

FIXTURES = Path(__file__).parent.parent / "tests" / "fixtures"
TARGETS = {
    "gc_program_2026.txt": "https://catalog.clemson.edu/preview_program.php?catoid=49&poid=16765&returnto=1996",
    "certificates_2026.txt": "https://catalog.clemson.edu/content.php?catoid=49&navoid=2008",
}
HTML_TARGETS = {
    "certificates_2026.html": "https://catalog.clemson.edu/content.php?catoid=49&navoid=2008",
}

if __name__ == "__main__":
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for name, url in TARGETS.items():
        text = render_text(url)
        (FIXTURES / name).write_text(text)
        print(f"wrote {name}: {len(text)} chars")
    for name, url in HTML_TARGETS.items():
        html = render_html(url)
        (FIXTURES / name).write_text(html)
        print(f"wrote {name}: {len(html)} chars")
