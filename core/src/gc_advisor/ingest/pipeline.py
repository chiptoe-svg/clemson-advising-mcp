from pathlib import Path
from gc_advisor.db.connection import get_connection
from gc_advisor.ingest.render import render_text, render_html
from gc_advisor.ingest.snapshots import freeze
from gc_advisor.ingest.discover import parse_index, select_poid, parse_cob_navoid
from gc_advisor.ingest.parse_program import parse_program
from gc_advisor.ingest.load import ensure_catalog_year, load_program, load_prose_program
from gc_advisor.ingest.parse_prose_program import extract_prose_program
from gc_advisor.ingest.validate import validate_program

BASE = "https://catalog.clemson.edu"

def _program_url(catoid: int, poid: int) -> str:
    return f"{BASE}/preview_program.php?catoid={catoid}&poid={poid}"

def find_cob_navoid(catoid: int) -> int:
    """Discover the College of Business programs-index navoid for a catoid.
    The navoid changes per catalog year, so it must not be hardcoded."""
    html = render_html(f"{BASE}/index.php?catoid={catoid}", selector="body")
    return parse_cob_navoid(html)


def find_program_poid(catoid: int, programs_navoid: int, name_contains: str) -> int:
    html = render_html(f"{BASE}/content.php?catoid={catoid}&navoid={programs_navoid}")
    try:
        return select_poid(parse_index(html), name_contains)
    except LookupError as e:
        raise LookupError(f"{e} (catoid {catoid})") from None

def ingest_program(con, raw_root: Path, year: str, catoid: int, cy_id: int,
                   poid: int, kind: str, degree: str | None = None) -> dict:
    url = _program_url(catoid, poid)
    text = render_text(url)
    meta = freeze(raw_root, year, poid, text)
    prog = parse_program(text, kind=kind, degree=degree)
    pid = load_program(con, cy_id, prog, poid=poid, source_url=url,
                       source_hash=meta.content_hash)
    return {"program_id": pid, "issues": validate_program(con, pid)}

def ingest_year(db_path, raw_root: Path, year: str, catoid: int,
                gc_poid: int, programs_navoid: int) -> dict:
    con = get_connection(db_path)
    try:
        cy = ensure_catalog_year(con, label=year, catoid=catoid)
        return ingest_program(con, raw_root, year, catoid, cy, gc_poid,
                              kind="major", degree="BS")
    finally:
        con.close()

def ingest_prose_program(con, raw_root, year: str, catoid: int, cy_id: int,
                         poid: int, name: str, kind: str) -> int:
    url = _program_url(catoid, poid)
    text = render_text(url)
    meta = freeze(raw_root, year, poid, text)
    prog = extract_prose_program(raw_root, year, poid, name=name, kind=kind)
    return load_prose_program(con, cy_id, prog, poid=poid, source_url=url,
                              source_hash=meta.content_hash)

def ingest_prose_index(con, raw_root, year: str, catoid: int, cy_id: int,
                       navoid: int, kind: str) -> list[int]:
    html = render_html(f"{BASE}/content.php?catoid={catoid}&navoid={navoid}")
    pids = []
    for e in parse_index(html):
        pids.append(ingest_prose_program(con, raw_root, year, catoid, cy_id,
                                         e.poid, name=e.name, kind=kind))
    return pids
