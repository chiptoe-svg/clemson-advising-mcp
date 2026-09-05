from dataclasses import dataclass, field


@dataclass
class ParsedItem:
    kind: str                    # fixed_course | choice | slot
    credits: int | None = None
    course_code: str | None = None
    one_of: list[str] = field(default_factory=list)
    slot_type: str | None = None
    footnote_refs: list[int] = field(default_factory=list)


@dataclass
class ParsedGroup:
    label: str
    kind: str                    # term | emphasis | slot_group
    credit_total: int | None = None
    items: list[ParsedItem] = field(default_factory=list)


@dataclass
class Footnote:
    number: int
    text: str


@dataclass
class ParsedProgram:
    name: str
    kind: str                    # major | minor | certificate | gen_ed
    degree: str | None = None
    total_credits: int | None = None
    description: str = ""
    groups: list[ParsedGroup] = field(default_factory=list)
    footnotes: list[Footnote] = field(default_factory=list)


@dataclass
class ParsedCourse:
    code: str
    subject: str
    number: str
    title: str | None = None
    credits: str | None = None
    description: str = ""
    prereq_text: str | None = None
    prereq_codes: list[str] = field(default_factory=list)
    source_url: str | None = None


@dataclass
class IndexEntry:
    name: str
    poid: int


@dataclass
class ParsedProseProgram:
    name: str
    kind: str                       # minor | certificate
    total_credits: int | None = None
    description: str = ""            # the verbatim prose
    rule: dict = field(default_factory=dict)   # the LLM-extracted structured rule


@dataclass
class CourseRef:
    coid: int
    code: str
    title: str


@dataclass
class GenEdCategory:
    name: str
    min_credits: int | None = None
    allowed_courses: list[str] = field(default_factory=list)
    rules: str = ""              # constraint sentences only
    learning_outcome: str = ""   # the category's Student Learning Outcome statement
    # Published sub-lists inside a category (today: Arts and Humanities splits
    # into Literature / Non-Literature). None = the page shows no split for
    # this category — NOT the same as an empty split.
    subcategories: list[dict] | None = None


@dataclass
class AcademicRegulation:
    section: str
    text: str
