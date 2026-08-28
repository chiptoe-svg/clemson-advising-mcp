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

def test_includes_exist():
    inc = SKILL.parent / "includes"
    for f in ["internships.md", "transfer-and-substitutions.md", "specialty-approval.md"]:
        assert (inc / f).exists()
