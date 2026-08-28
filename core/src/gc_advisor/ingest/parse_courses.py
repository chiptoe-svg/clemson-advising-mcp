import re
from gc_advisor.models import ParsedCourse

HEAD_RE = re.compile(r"^([A-Z]{2,5})\s+(\d{4})\s+-\s+(.+)$")
CREDITS_RE = re.compile(r"^Credit Hours:\s*(.+)$")
PREQ_RE = re.compile(r"^Preq:\s*(.+)$")

def parse_courses(text: str) -> list[ParsedCourse]:
    blocks = re.split(r"\n\s*\n", text.strip())
    out: list[ParsedCourse] = []
    for block in blocks:
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        if not lines:
            continue
        head = HEAD_RE.match(lines[0])
        if not head:
            continue
        course = ParsedCourse(code=f"{head.group(1)} {head.group(2)}",
                              subject=head.group(1), number=head.group(2),
                              title=head.group(3).strip())
        desc_parts = []
        for l in lines[1:]:
            cm = CREDITS_RE.match(l)
            pm = PREQ_RE.match(l)
            if cm:
                course.credits = cm.group(1).strip()
            elif pm:
                course.prereq_text = None if pm.group(1).strip().lower() in ("none", "none.") \
                    else pm.group(1).strip().rstrip(".")
            else:
                desc_parts.append(l)
        course.description = " ".join(desc_parts)
        out.append(course)
    return out
