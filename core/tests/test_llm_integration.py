import pytest
import gc_advisor.ingest.llm as llm

@pytest.mark.integration
def test_llm_extracts_minor_requirements_live():
    system = ("Extract structured academic requirements as JSON with keys "
              "total_credits (int|null) and required_courses (array of course codes).")
    user = ("Accounting Minor (18 credits minimum). A minor in Accounting requires "
            "ACCT 2010, ACCT 3110 and ACCT 3120 and nine additional credits.")
    out = llm.extract_json(system, user)
    assert out.get("total_credits") == 18
    assert "ACCT 2010" in out.get("required_courses", [])
