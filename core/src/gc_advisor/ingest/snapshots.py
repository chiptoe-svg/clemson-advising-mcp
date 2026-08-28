import hashlib
from dataclasses import dataclass
from pathlib import Path

@dataclass
class SnapshotMeta:
    raw_path: Path
    content_hash: str

def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def _path(root: Path, year: str, poid: int) -> Path:
    return Path(root) / year / f"{poid}.txt"

def freeze(root: Path, year: str, poid: int, text: str) -> SnapshotMeta:
    path = _path(root, year, poid)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return SnapshotMeta(raw_path=path, content_hash=content_hash(text))

def read_snapshot(root: Path, year: str, poid: int) -> str:
    return _path(root, year, poid).read_text()
