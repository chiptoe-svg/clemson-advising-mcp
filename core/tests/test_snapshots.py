from gc_advisor.ingest.snapshots import freeze, read_snapshot, content_hash

def test_freeze_writes_file_and_returns_hash(tmp_path):
    meta = freeze(tmp_path, year="2026-2027", poid=16765, text="hello world")
    assert meta.raw_path.exists()
    assert meta.raw_path.read_text() == "hello world"
    assert meta.content_hash == content_hash("hello world")

def test_read_snapshot_roundtrip(tmp_path):
    freeze(tmp_path, year="2026-2027", poid=16765, text="abc")
    assert read_snapshot(tmp_path, "2026-2027", 16765) == "abc"

def test_hash_is_stable():
    assert content_hash("x") == content_hash("x")
    assert content_hash("x") != content_hash("y")
