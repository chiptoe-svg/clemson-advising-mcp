from pathlib import Path
from gc_advisor.ingest.render import render_text

FIX = Path(__file__).parent.parent / "tests" / "fixtures"
url = "https://catalog.clemson.edu/preview_program.php?catoid=49&poid=16611"  # Accounting Minor
(FIX / "accounting_minor_2026.txt").write_text(render_text(url))
print("wrote accounting_minor_2026.txt")
