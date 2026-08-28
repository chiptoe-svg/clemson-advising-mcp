"""Parse the Clemson Academic Regulations page into AcademicRegulation records.

The page is structured as a sequence of named sections. Each section has:
  - A short heading line (typically 5-80 chars, title-case, no terminal period or colon)
  - One or more body paragraphs (much longer lines or multi-sentence prose)

The page opens with a boilerplate block (Add to My Favorites, Print, Help) and a
table-of-contents list of top-level headings before the actual content begins.
"""
from gc_advisor.models import AcademicRegulation

BOILER = (
    "opens a new window",
    "Add to My Favorites",
    "Print (",
    "Help (",
    "[ARCHIVED CATALOG]",
    "Return to:",
)

# Lines that look short but are NOT headings:
#   - end with ':'  (intro lines: "The grading system is as follows:")
#   - end with ','  (mid-sentence fragments)
#   - start with a number or bullet-like character
#   - are all-caps data rows like GPA tables (contain multiple whitespace-padded fields)
#   - are very short titles like 'A' or single words that are actually data


def _is_boiler(line: str) -> bool:
    return any(b in line for b in BOILER)


def _is_heading(line: str) -> bool:
    """Return True if the line looks like a section heading.

    Headings on the Academic Regulations page are:
      - 2-80 characters
      - Start with an uppercase letter (title-case or proper noun)
      - Do NOT end with a period, comma, or colon (those signal prose or intro lines)
      - Do NOT look like a GPA/table data row (contain tab-separated numbers)
    """
    s = line.strip()
    if not s:
        return False
    if len(s) < 2 or len(s) > 80:
        return False
    if not s[0].isupper():
        return False
    if s[-1] in (".", ",", ":"):
        return False
    # GPA table rows contain numeric data separated by lots of whitespace
    if "\xa0" in s and any(c.isdigit() for c in s):
        return False
    # Lines starting with a digit are data/list items, not headings
    if s[0].isdigit():
        return False
    return True


def parse_academic_regs(text: str) -> list[AcademicRegulation]:
    """Parse academic regulations text into a list of AcademicRegulation sections.

    Strategy:
    1. Strip boilerplate and blank lines.
    2. Skip the table-of-contents block at the top (the same headings repeat later
       with content after them, so the TOC-only entries produce empty buffers and
       are filtered out).
    3. Accumulate body lines between each detected heading.
    4. Only emit a section when the body has at least 20 characters of content.
    """
    lines = [line.strip() for line in text.splitlines()
             if line.strip() and not _is_boiler(line)]

    secs: list[AcademicRegulation] = []
    cur_head: str | None = None
    buf: list[str] = []

    def flush() -> None:
        nonlocal cur_head, buf
        if cur_head and buf:
            body = " ".join(buf).strip()
            if len(body) > 20:
                secs.append(AcademicRegulation(section=cur_head, text=body))
        buf = []

    for line in lines:
        if _is_heading(line):
            flush()
            cur_head = line
        else:
            if cur_head is not None:
                buf.append(line)
            # Lines before any heading are ignored (they're the TOC)

    flush()
    return secs
