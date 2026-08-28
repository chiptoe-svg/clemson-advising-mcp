import json
import gc_advisor.ingest.llm as llm

class _FakeResp:
    def __init__(self, body): self._b = json.dumps(body).encode()
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False

def test_extract_json_parses_message_content(monkeypatch):
    captured = {}
    def fake_urlopen(req, timeout=0):
        captured["url"] = req.full_url
        captured["payload"] = json.loads(req.data.decode())
        captured["auth"] = req.headers.get("Authorization")
        return _FakeResp({"choices": [{"message": {"content": '{"total_credits": 18}'}}]})
    monkeypatch.setattr(llm.urllib.request, "urlopen", fake_urlopen)
    out = llm.extract_json("sys", "user", model="m", base_url="http://h:1", api_key="k")
    assert out == {"total_credits": 18}
    assert captured["url"] == "http://h:1/v1/chat/completions"
    assert captured["auth"] == "Bearer k"
    assert captured["payload"]["temperature"] == 0
    assert captured["payload"]["response_format"] == {"type": "json_object"}
    assert captured["payload"]["messages"][0] == {"role": "system", "content": "sys"}

def test_extract_json_raises_on_bad_json(monkeypatch):
    def fake_urlopen(req, timeout=0):
        return _FakeResp({"choices": [{"message": {"content": "not json"}}]})
    monkeypatch.setattr(llm.urllib.request, "urlopen", fake_urlopen)
    import pytest
    with pytest.raises(ValueError):
        llm.extract_json("s", "u", model="m", base_url="http://h:1", api_key="k")
