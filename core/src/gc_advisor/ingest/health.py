import subprocess
from gc_advisor.ingest import llm


class PreflightError(RuntimeError):
    """Raised when the LLM server isn't healthy enough to start a long run."""


def is_oom_error(exc: Exception) -> bool:
    s = str(exc)
    return ("507" in s) or ("Insufficient Storage" in s) or ("memory ceiling" in s)


def _vm_stat() -> str | None:
    try:
        return subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None


def free_memory_gb() -> float:
    """Best-effort reclaimable system memory (free + inactive) in GB, via macOS
    vm_stat. Returns +inf if it can't measure (so callers never block on it)."""
    out = _vm_stat()
    if not out:
        return float("inf")
    page = 4096
    free = inactive = 0
    for line in out.splitlines():
        if "page size of" in line:
            try:
                page = int(line.split()[-2])
            except Exception:
                pass
        elif line.startswith("Pages free:"):
            free = int(line.split()[-1].rstrip("."))
        elif line.startswith("Pages inactive:"):
            inactive = int(line.split()[-1].rstrip("."))
    return (free + inactive) * page / 1e9


def try_purge() -> bool:
    """Best-effort macOS purge to reclaim inactive memory. Non-interactive
    (`sudo -n`): if passwordless sudo for purge isn't configured it just fails
    quietly. Returns True only if purge actually ran."""
    try:
        r = subprocess.run(["sudo", "-n", "purge"], capture_output=True, text=True, timeout=60)
        return r.returncode == 0
    except Exception:
        return False


def preflight(min_free_gb: float = 25.0, *, model: str | None = None) -> None:
    """Verify the LLM server can actually serve a model before a long run.
    If reclaimable memory is low, best-effort purge first. Then do a tiny
    warm-load probe; raise PreflightError on a hard failure so the caller aborts
    instead of grinding through 507s."""
    if free_memory_gb() < min_free_gb:
        try_purge()
    try:
        llm.extract_json("Reply with JSON only.", 'Return {"ok": true}', model=model)
    except Exception as e:
        if is_oom_error(e):
            raise PreflightError(
                "LLM server is out of memory (HTTP 507). Free memory "
                "(restart omlx or `sudo purge`) and rerun — the backfill resumes "
                "from the frozen cache."
            ) from e
        raise PreflightError(f"LLM warm-load probe failed: {e}") from e
