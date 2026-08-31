import re
from pathlib import Path

SKILLS = Path(__file__).parent.parent / "skills"

# Which anchors must live in which served document. This is the split contract
# (2026-08-31): method is department-neutral, gc-advisor is GC policy only.
ANCHORS = {
    "advising-method": [
        "Degree Audit", "counts once", "Prerequisite Check", "Transfer Credit",
        "transfer-exemption-waiver", "DegreeWorks",
    ],
    "gc-advisor": [
        "Specialty-area approval", "GC 3600 double-dip", "Lab co-requisite",
        "GC 4060", "GC 3500 + COOP 1010", "Intern Employer Day", "CourseLineup",
    ],
    "pre-business-advising": ["Pre-Business", "ECON 2110"],
    "accounting-advising": ["No department advising policy has been recorded"],
    "economics-advising": ["No department advising policy has been recorded"],
    "financial-management-advising": ["No department advising policy has been recorded"],
    "management-advising": ["No department advising policy has been recorded"],
    "marketing-advising": ["No department advising policy has been recorded"],
}


def _doc(name: str) -> str:
    return (SKILLS / name / "SKILL.md").read_text()


def test_every_skill_has_frontmatter_and_its_anchors():
    for name, anchors in ANCHORS.items():
        text = _doc(name)
        assert re.match(r"^---\r?\n[\s\S]*?\r?\n---", text), name
        assert f"name: {name}" in text, f"{name}: frontmatter name mismatch"
        for anchor in anchors:
            assert anchor in text, f"{name}: missing anchor {anchor!r}"


def test_department_policy_is_not_in_the_method_doc():
    # The split's point: a Marketing agent fetching the method must not receive
    # GC's internship rules as if they were its own.
    text = _doc("advising-method")
    for gc_only in ["GC 3500", "Intern Employer Day", "CourseLineup", "GC 3600"]:
        assert gc_only not in text, f"GC policy leaked into advising-method: {gc_only}"


def test_every_served_skill_is_self_contained():
    # get-gc-skill-docs serves only SKILL.md; a referenced companion file is a
    # dangling pointer for every fetching client (learned 2026-08-31).
    for d in SKILLS.iterdir():
        if not (d / "SKILL.md").exists():
            continue
        text = (d / "SKILL.md").read_text()
        assert "includes/" not in text, f"{d.name} references unservable files"
        assert not (d / "includes").exists(), f"{d.name} has unservable companions"
