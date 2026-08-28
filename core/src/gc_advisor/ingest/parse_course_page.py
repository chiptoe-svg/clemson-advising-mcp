import re
from gc_advisor.models import ParsedCourse

HEAD_RE = re.compile(r"^([A-Z]{2,5})\s+(\d{4})\s*-\s*(.+)$")
CREDITS_RE = re.compile(r"^([\d.]+(?:\s*(?:-|–|to|TO)\s*[\d.]+)?)\s+Credits?\b")
CODE_RE = re.compile(r"\b([A-Z]{2,5})\s+(\d{4})\b")
BOILER = (
    "opens a new window",
    "Add to My Favorites",
    "Add to Portfolio",
    "Print (",
    "Help (",
    "[ARCHIVED CATALOG]",
)


def _clean_lines(text: str) -> list[str]:
    out = []
    for raw in text.splitlines():
        s = raw.strip()
        if not s or any(b in s for b in BOILER):
            continue
        out.append(s)
    return out


def parse_course_page(text: str) -> ParsedCourse:
    text = text.replace("\xa0", " ")
    lines = _clean_lines(text)
    head_i = next((i for i, l in enumerate(lines) if HEAD_RE.match(l)), None)
    if head_i is None:
        raise ValueError("no course heading line found")
    h = HEAD_RE.match(lines[head_i])
    subject, number, title = h.group(1), h.group(2), h.group(3).strip()
    course = ParsedCourse(
        code=f"{subject} {number}",
        subject=subject,
        number=number,
        title=title,
    )
    rest = lines[head_i + 1:]
    # The ajax course fragment (ajax/preview_course.php) repeats the title —
    # once as the link, once as the table heading — so skip any duplicated
    # heading line before reading credits. The full page has it once, so this
    # is a no-op there.
    while rest and HEAD_RE.match(rest[0]):
        rest = rest[1:]
    desc_start = 0
    if rest:
        cm = CREDITS_RE.match(rest[0])
        if cm:
            course.credits = cm.group(1).replace(" ", "")
            desc_start = 1
    para = " ".join(rest[desc_start:]).strip()
    preq = None
    m = re.search(r"Preq:\s*(.*?)(?:\s*Coreq:|\s*This \d+-level course has|$)", para, re.DOTALL)
    if m:
        raw_preq = m.group(1).strip().rstrip(".")
        preq = raw_preq if raw_preq else None
    desc = re.split(r"\s*(?:Preq:|Coreq:)", para)[0].strip()
    course.description = desc
    course.prereq_text = preq
    if preq:
        course.prereq_codes = [f"{s} {n}" for s, n in CODE_RE.findall(preq)]
    return course
