from pathlib import Path
import sys
import pytest

FIXTURES = Path(__file__).parent / "fixtures"

ROOT = Path(__file__).parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES
