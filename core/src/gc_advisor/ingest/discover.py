import re
from html.parser import HTMLParser
from gc_advisor.models import IndexEntry, CourseRef

POID_RE = re.compile(r"preview_program\.php\?[^\"']*poid=(\d+)")


class _LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.entries: list[IndexEntry] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href", "") or ""
            m = POID_RE.search(href)
            self._href = m.group(1) if m else None
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            name = "".join(self._text).strip()
            if name:
                self.entries.append(IndexEntry(name=name, poid=int(self._href)))
            self._href = None


def parse_index(html: str) -> list[IndexEntry]:
    p = _LinkParser()
    p.feed(html)
    seen, out = set(), []
    for e in p.entries:
        if e.poid not in seen:
            seen.add(e.poid)
            out.append(e)
    return out


COID_RE = re.compile(r"preview_course_nopop\.php\?[^\"']*coid=(\d+)")
COURSE_LINK_TEXT_RE = re.compile(r"^([A-Z]{2,5}\s+\d{4})\s*-\s*(.+)$")


def course_list_url(catoid: int, navoid: int, cpage: int) -> str:
    return (
        f"https://catalog.clemson.edu/content.php?catoid={catoid}&navoid={navoid}"
        f"&filter%5Bitem_type%5D=3&filter%5Bonly_active%5D=1&filter%5B3%5D=1"
        f"&filter%5Bcpage%5D={cpage}"
    )


class _CourseLinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs: list[CourseRef] = []
        self._coid: int | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href", "") or ""
            m = COID_RE.search(href)
            self._coid = int(m.group(1)) if m else None
            self._text = []

    def handle_data(self, data):
        if self._coid is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._coid is not None:
            text = "".join(self._text).strip()
            m = COURSE_LINK_TEXT_RE.match(text)
            if m:
                self.refs.append(CourseRef(coid=self._coid,
                                           code=" ".join(m.group(1).split()),
                                           title=m.group(2).strip()))
            self._coid = None


def parse_course_index(html: str) -> list[CourseRef]:
    p = _CourseLinkParser()
    p.feed(html)
    seen, out = set(), []
    for r in p.refs:
        if r.coid not in seen:
            seen.add(r.coid)
            out.append(r)
    return out


def select_poid(entries: list[IndexEntry], name: str) -> int:
    """Resolve a program name to its poid within a catalog index.

    An exact (case-insensitive) name match wins outright, so "Marketing, BS"
    resolves even when "Marketing Minor" is in the same index. Otherwise a
    substring match must be unambiguous — matching several programs raises
    rather than silently returning whichever came first, which is what the
    original substring-and-return-first lookup did.
    """
    norm = name.strip().lower()
    exact = [e for e in entries if e.name.strip().lower() == norm]
    if len(exact) == 1:
        return exact[0].poid
    subs = [e for e in entries if norm in e.name.lower()]
    if len(subs) == 1:
        return subs[0].poid
    if not subs:
        raise LookupError(f"No program matching {name!r}")
    candidates = ", ".join(sorted(e.name for e in subs))
    raise LookupError(f"Ambiguous program name {name!r} — candidates: {candidates}")


_COB_NAV_RE = re.compile(
    r'navoid=(\d+)\"[^>]*>[^<]*<[^>]*>[^<]*(?:College of Business|Business College)',
    re.I)
_COB_NAV_LOOSE_RE = re.compile(r'navoid=(\d+)[^\n]*Business', re.I)


def parse_cob_navoid(html: str) -> int:
    """College of Business programs-index navoid from a catalog index page.

    The navoid changes every catalog year, so it cannot be hardcoded — see
    tests/test_cob_navoid.py. Extracted from scripts/ingest_pre_business.py so
    both ingest entry points can share it.
    """
    for pattern in (_COB_NAV_RE, _COB_NAV_LOOSE_RE):
        m = pattern.search(html)
        if m:
            return int(m.group(1))
    raise LookupError("No College of Business nav link found in index page")
