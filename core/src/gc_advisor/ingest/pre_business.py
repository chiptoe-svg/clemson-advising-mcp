"""Ingest the shared Pre-Business freshman curriculum as a standalone
`Pre-Business` program.

There is no standalone Pre-Business program page in the catalog — the curriculum
is the common freshman block embedded in every business major's page, before the
`Additional Curriculum` boundary (identical across Accounting, Economics,
Financial Management, Management, Marketing). We parse that prefix so pre-business
freshmen can be advised without first picking a major. The policy (freshman-core
list, MATH sequences, change-of-major GPA thresholds) lives on the College of
Business entity page and is captured in the description below."""
from gc_advisor.ingest.parse_program import parse_program

MAJOR_BOUNDARY = "Additional Curriculum"
PROGRAM_NAME = "Pre-Business"

# From the College of Business entity page (preview_entity.php?ent_oid=4534),
# transcribed. Stable across recent catalog years.
DESCRIPTION = (
    "The Pre-Business program is the common freshman year for the Bachelor of "
    "Science degrees in Accounting, Economics, Financial Management, Management, "
    "and Marketing. All new business students are admitted as Pre-Business until "
    "the freshman core is completed and the GPA requirement is met: BUS 1010, "
    "ECON 2110, ECON 2120, an acceptable MATH sequence, ENGL 1030, and a natural "
    "science with laboratory requirement. Admission to the major requires a "
    "Clemson cumulative GPA of 2.0 for Accounting, Economics, Financial "
    "Management, or Management, and 3.0 for Marketing. Change of major into "
    "Pre-Business requires 12 credit hours, the approved MATH sequence, "
    "ECON 2110 or 2120, and a 2.5 GPA. Requests are filed through iROAR."
)


def parse_pre_business(major_page_text: str):
    """Parse the pre-business freshman portion out of a business major's page
    (the text before `Additional Curriculum`) into a `Pre-Business` program."""
    pre = major_page_text.split(MAJOR_BOUNDARY)[0]
    prog = parse_program(pre, kind="pre_business", degree=None)
    prog.name = PROGRAM_NAME
    prog.description = DESCRIPTION
    return prog
