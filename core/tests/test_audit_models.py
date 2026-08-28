import json
import pytest
from gc_advisor.audit.models import Progress

def test_parses_valid_progress(fixtures_dir):
    d = json.loads((fixtures_dir / "progress_partial.json").read_text())
    p = Progress.from_dict(d)
    assert p.catalog_year == "2026-2027"
    assert len(p.passed) == 7
    assert p.passed[0].code == "GC 1010" and p.passed[0].credits == 1
    assert "GC 2400" in p.in_progress
    assert p.minor is None
    assert "GC 1010" in p.grade_checks["c_or_better"]

def test_rejects_wrong_version():
    with pytest.raises(ValueError, match="version"):
        Progress.from_dict({"version": "v0", "catalog_year": "2026-2027"})

def test_rejects_missing_catalog_year():
    with pytest.raises((ValueError, KeyError)):
        Progress.from_dict({"version": "gc-progress-v1"})

def test_minor_field_preserved():
    p = Progress.from_dict({
        "version": "gc-progress-v1", "catalog_year": "2026-2027",
        "passed": [], "minor": {"name": "Business Administration", "complete": False},
    })
    assert p.minor["name"] == "Business Administration"
    assert p.minor["complete"] is False
