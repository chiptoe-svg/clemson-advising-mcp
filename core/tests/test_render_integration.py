import pytest
from gc_advisor.ingest.render import render_text

@pytest.mark.integration
def test_render_gc_program_live():
    url = "https://catalog.clemson.edu/preview_program.php?catoid=49&poid=16765&returnto=1996"
    text = render_text(url)
    assert "Graphic Communications, BS" in text
    assert "Total Credits: 120" in text

@pytest.mark.integration
def test_render_raises_on_empty(monkeypatch):
    with pytest.raises(RuntimeError):
        render_text("https://catalog.clemson.edu/preview_program.php?catoid=49&poid=999999")
