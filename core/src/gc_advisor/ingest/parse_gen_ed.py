import re
from gc_advisor.models import GenEdCategory

# Keywords that identify the six gen-ed areas (in requirement headings and SLO headings)
CATEGORY_KEYWORDS = [
    "Communication",
    "Mathematics",
    "Natural Science",
    "Arts and Humanities",
    "Social Science",
    "Global Challenge",
]

# Matches heading lines like "A. Communication (minimum of 6 credit hours)"
# or "C. Natural Sciences with Lab (minimum of 4 credit hours)"
REQ_HEADING_RE = re.compile(
    r"^[A-F]\.\s+(.+?)\s*\(minimum of (\d+) credit hours?\)",
    re.IGNORECASE,
)

# Older catalog format (pre-2022): "A. Communication: at least 6 credits"
# or "E. Cross-Cultural Awareness: at least 3 credits, if not satisfied by ..."
REQ_HEADING_OLD_RE = re.compile(
    r"^[A-F]\.\s+(.+?):\s+at least (\d+) credit",
    re.IGNORECASE,
)

CREDIT_RE = re.compile(r"(?:minimum of\s+)?(\d+)\s+[Cc]redit", re.IGNORECASE)
CODE_RE = re.compile(r"\b([A-Z]{2,5})\s+(\d{4})\b")

# Constraint sentences: sentences containing key constraint phrases
CONSTRAINT_RE = re.compile(
    r"[^.]*\b(?:two different fields|different field|3000[- ]level|at the 3000|"
    r"transfer course may not|select one|may not be used|upper[- ]level|upper level)\b[^.]*\.",
    re.I,
)

BOILER = (
    "opens a new window",
    "Add to My Favorites",
    "Print (",
    "Help (",
    "[ARCHIVED CATALOG]",
)

# SLO section heading keywords (slightly different from requirement headings)
SLO_KEYWORDS = [
    "Communication",
    "Arts and Humanities",
    "Mathematics",
    "Natural Sciences",
    "Social Sciences",
    "Global Challenges",
]


def _is_boiler(line: str) -> bool:
    return any(b in line for b in BOILER)


def _slo_heading(line: str) -> str | None:
    """Return the SLO keyword if this line is a bare SLO heading (short line matching a keyword)."""
    s = line.strip()
    if not s or len(s) > 60:
        return None
    for kw in SLO_KEYWORDS:
        if s == kw or s.startswith(kw) and len(s) < len(kw) + 5:
            return kw
    return None


def _parse_slos(text: str) -> dict[str, str]:
    """Extract per-category Student Learning Outcome paragraphs.

    The SLO block lives between "General Education Student Learning Outcomes"
    and the first line of enrollment policy prose (starts with "An undergraduate").
    Within the block, each entry is:
        <bare category heading line>
        <one or more SLO sentence lines>
    """
    slos: dict[str, str] = {}
    marker = "General Education Student Learning Outcomes"
    if marker not in text:
        return slos

    block = text.split(marker, 1)[1]

    # End of SLO block: the policy prose starts with "An undergraduate"
    # or the requirements section starts with "Requirements ("
    for end_marker in ("An undergraduate student", "Requirements ("):
        if end_marker in block:
            block = block.split(end_marker, 1)[0]
            break

    cur_kw: str | None = None
    buf: list[str] = []

    def _flush_slo():
        nonlocal cur_kw, buf
        if cur_kw and buf:
            slos[cur_kw] = " ".join(buf).strip()
        cur_kw, buf = None, []

    for raw in block.splitlines():
        s = raw.strip()
        if not s or _is_boiler(s):
            continue
        kw = _slo_heading(s)
        if kw:
            _flush_slo()
            cur_kw = kw
        elif cur_kw:
            buf.append(s)

    _flush_slo()
    return slos


def _req_heading(line: str) -> tuple[str, int] | None:
    """Return (name, min_credits) if line is a requirement-section category heading.

    Handles two catalog formats:
      - Newer (2022+): "A. Communication (minimum of 6 credit hours)"
      - Older (pre-2022): "A. Communication: at least 6 credits"
    """
    s = line.strip()
    m = REQ_HEADING_RE.match(s)
    if m:
        return m.group(1).strip(), int(m.group(2))
    m = REQ_HEADING_OLD_RE.match(s)
    if m:
        return m.group(1).strip(), int(m.group(2))
    return None


def _category_key(name: str) -> str | None:
    """Return the SLO keyword that best matches a requirement-section category name."""
    for kw in SLO_KEYWORDS:
        if kw.rstrip("s") in name or name.startswith(kw.rstrip("s")):
            return kw
    # Try CATEGORY_KEYWORDS as fallback
    for kw in CATEGORY_KEYWORDS:
        if kw in name:
            return kw
    return None


def parse_gen_ed(text: str) -> list[GenEdCategory]:
    """Parse the Clemson General Education page text into GenEdCategory records."""
    slos = _parse_slos(text)

    lines = [l.strip() for l in text.splitlines() if l.strip() and not _is_boiler(l)]

    cats: list[GenEdCategory] = []
    cur: GenEdCategory | None = None
    buf: list[str] = []

    def flush():
        nonlocal cur, buf
        if cur:
            blob = " ".join(buf)
            cur.allowed_courses = sorted({f"{a} {b}" for a, b in CODE_RE.findall(blob)})
            cur.rules = " ".join(CONSTRAINT_RE.findall(blob)).strip()
            cats.append(cur)
        cur, buf = None, []

    for line in lines:
        result = _req_heading(line)
        if result:
            flush()
            name, credits = result
            cur = GenEdCategory(name=name, min_credits=credits)
        elif cur:
            buf.append(line)

    flush()

    # Attach SLOs by matching category name to SLO keyword
    for c in cats:
        kw = _category_key(c.name)
        if kw and kw in slos:
            c.learning_outcome = slos[kw]

    return cats
