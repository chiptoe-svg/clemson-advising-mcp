import urllib.error
import pytest
from gc_advisor.ingest import health

def test_is_oom_error_detects_507_and_ceiling():
    assert health.is_oom_error(Exception("HTTP Error 507: Insufficient Storage"))
    assert health.is_oom_error(Exception("projected memory ... exceed the memory ceiling"))
    assert not health.is_oom_error(Exception("connection refused"))

def test_free_memory_gb_parses_vm_stat(monkeypatch):
    sample = (
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
        "Pages free:                          65536.\n"
        "Pages inactive:                     131072.\n"
    )
    monkeypatch.setattr(health, "_vm_stat", lambda: sample)
    # (65536 + 131072) pages * 16384 bytes / 1e9 ~= 3.22 GB
    assert 3.0 < health.free_memory_gb() < 3.5

def test_free_memory_gb_returns_inf_when_unavailable(monkeypatch):
    monkeypatch.setattr(health, "_vm_stat", lambda: None)
    assert health.free_memory_gb() == float("inf")

def test_preflight_passes_when_probe_succeeds(monkeypatch):
    monkeypatch.setattr(health, "free_memory_gb", lambda: 100.0)
    monkeypatch.setattr(health.llm, "extract_json", lambda *a, **k: {"ok": True})
    health.preflight()  # must not raise

def test_preflight_raises_on_oom_probe(monkeypatch):
    monkeypatch.setattr(health, "free_memory_gb", lambda: 2.0)
    monkeypatch.setattr(health, "try_purge", lambda: False)
    def boom(*a, **k):
        raise urllib.error.HTTPError("u", 507, "Insufficient Storage", {}, None)
    monkeypatch.setattr(health.llm, "extract_json", boom)
    with pytest.raises(health.PreflightError):
        health.preflight()
