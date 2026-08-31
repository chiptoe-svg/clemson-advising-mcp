import re
from pathlib import Path

SKILL = Path(__file__).parent.parent / "skills" / "gc-advisor" / "SKILL.md"

def test_frontmatter_and_advising_sections_present():
    text = SKILL.read_text()
    assert re.match(r"^---\r?\n[\s\S]*?\r?\n---", text)          # valid frontmatter
    assert "name: gc-advisor" in text                            # unchanged skill name
    for anchor in ["Lab co-requisite", "Internship", "Transfer Credit",
                   "GC 4060", "Specialty-area approval", "CourseLineup"]:
        assert anchor in text, f"missing advising section: {anchor}"

def test_skill_is_self_contained():
    """The doc is served over MCP by get-gc-skill-docs, which reads ONLY
    SKILL.md — a companion file it references is a dangling pointer for every
    fetching client. The former includes/ were inlined 2026-08-31 for exactly
    that reason; this pins both halves: no references out, content in."""
    text = SKILL.read_text()
    assert "includes/" not in text, "SKILL.md references files a fetching client cannot get"
    assert not (SKILL.parent / "includes").exists(), "unservable companion files reappeared"
    for anchor in [
        "transfer-exemption-waiver",       # transfer rules, formerly an include
        "GC 3500 + COOP 1010",             # internship sequencing, formerly an include
        "Intern Employer Day",
        "GC 3600 double-dip",              # specialty approval, formerly an include
    ]:
        assert anchor in text, f"inlined content lost: {anchor}"
