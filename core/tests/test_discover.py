from gc_advisor.ingest.discover import parse_index


def test_parse_certificates_index(fixtures_dir):
    html = (fixtures_dir / "certificates_2026.html").read_text()
    entries = parse_index(html)
    names = {e.name for e in entries}
    assert "Sales Certificate" in names
    sales = next(e for e in entries if e.name == "Sales Certificate")
    assert sales.poid == 16831
    assert all(e.poid > 0 for e in entries)
    assert len({e.poid for e in entries}) == len(entries)
