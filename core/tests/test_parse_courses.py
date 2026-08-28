from gc_advisor.ingest.parse_courses import parse_courses

def test_parse_three_courses(fixtures_dir):
    text = (fixtures_dir / "courses_sample.txt").read_text()
    courses = parse_courses(text)
    by_code = {c.code: c for c in courses}
    assert set(by_code) == {"GC 1020", "GC 3460", "GC 4400"}
    assert by_code["GC 1020"].subject == "GC"
    assert by_code["GC 1020"].number == "1020"
    assert by_code["GC 1020"].title == "Introduction to Digital Graphics"
    assert by_code["GC 3460"].credits == "3"
    assert "GC 2070" in by_code["GC 3460"].prereq_text
    assert by_code["GC 4400"].prereq_text.startswith("GC 3460 and GC 3400")
