from gc_advisor.ingest.discover import parse_course_index, course_list_url

def test_course_list_url_has_cpage_and_filters():
    url = course_list_url(catoid=49, navoid=1988, cpage=3)
    assert "catoid=49" in url and "navoid=1988" in url
    assert "cpage%5D=3" in url or "cpage]=3" in url
    assert "item_type%5D=3" in url or "item_type]=3" in url

def test_parse_course_index_extracts_coids(fixtures_dir):
    html = (fixtures_dir / "courses_listing_2026.html").read_text()
    refs = parse_course_index(html)
    assert len(refs) >= 50
    acct = next(r for r in refs if r.code == "ACCT 2010")
    assert acct.coid > 0
    assert "Financial Accounting" in acct.title
    assert all(r.coid > 0 for r in refs)
    assert len({r.coid for r in refs}) == len(refs)
