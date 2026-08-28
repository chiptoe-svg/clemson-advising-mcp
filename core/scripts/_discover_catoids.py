"""Discover catoid -> year label mapping from the Clemson catalog archive dropdown.

Run: PYTHONPATH=src .venv/bin/python scripts/_discover_catoids.py
"""
from gc_advisor.ingest.render import render_html
import re

html = render_html("https://catalog.clemson.edu/index.php?catoid=49", selector="body")

print("=== Undergraduate Catalog catoid mapping ===")
# Find option tags; filter to Undergraduate only
for m in re.finditer(r'<option\s+value="(\d+)"[^>]*>([^<]+Undergraduate[^<]*)</option>', html, re.I):
    catoid = m.group(1)
    label_raw = m.group(2).strip()
    # Extract year range from label like "2026-2027 Undergraduate Catalog"
    year_m = re.search(r'(\d{4}-\d{4})', label_raw)
    year = year_m.group(1) if year_m else label_raw
    print(f"catoid={catoid:>3}  year={year}")
