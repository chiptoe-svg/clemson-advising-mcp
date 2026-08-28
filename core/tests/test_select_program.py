"""Name -> poid resolution for ingesting a named program.

pipeline.find_program_poid matched by substring and returned the FIRST hit,
so an ambiguous name silently picked a winner. Harmless while only one program
was ever ingested; a trap the moment a second department is added, because
"Marketing" matches both the BS and any Marketing minor in the same index.
"""
import pytest
from gc_advisor.models import IndexEntry
from gc_advisor.ingest.discover import select_poid

ENTRIES = [
    IndexEntry(name="Marketing, BS", poid=16767),
    IndexEntry(name="Marketing Minor", poid=16999),
    IndexEntry(name="Graphic Communications, BS", poid=16765),
]


def test_exact_name_match_wins_over_substring():
    assert select_poid(ENTRIES, "Marketing, BS") == 16767


def test_unambiguous_substring_resolves():
    assert select_poid(ENTRIES, "Graphic Communications") == 16765


def test_ambiguous_substring_raises_and_names_the_candidates():
    with pytest.raises(LookupError) as e:
        select_poid(ENTRIES, "Marketing")
    msg = str(e.value)
    assert "Marketing, BS" in msg and "Marketing Minor" in msg


def test_no_match_raises():
    with pytest.raises(LookupError):
        select_poid(ENTRIES, "Nursing, BS")
