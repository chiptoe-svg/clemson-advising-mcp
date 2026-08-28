import hashlib
import json
import re
from pathlib import Path
from gc_advisor.ingest import llm
from gc_advisor.models import ParsedProseProgram

CODE_RE = re.compile(r"^[A-Z]{2,5} \d{4}$")

_HASH_SKIP_EXACT = {
    "", "a", "[ARCHIVED CATALOG]", "Program Description", "Minor Description",
    "Certificate Description", "Program Requirements",
}
_HASH_SKIP_PREFIX = (
    "Add to My Favorites", "Print (", "Help (", "Return to:", "Add to Portfolio",
)

def _normalize_for_hash(name: str, prose: str) -> str:
    """Stable text for content-addressing: name + prose with nav chrome, headings,
    and archived-catalog banners removed and whitespace collapsed, so the same
    requirements across catalog years (which differ only in that chrome) hash the
    same and reuse one LLM extraction."""
    lines = []
    for raw in prose.splitlines():
        s = raw.strip()
        if s in _HASH_SKIP_EXACT:
            continue
        if "opens a new window" in s:
            continue
        if any(s.startswith(p) for p in _HASH_SKIP_PREFIX):
            continue
        lines.append(s)
    return name.strip() + "\n" + " ".join(lines)

def _content_key(name: str, prose: str) -> str:
    return hashlib.sha256(_normalize_for_hash(name, prose).encode("utf-8")).hexdigest()

def _cache_dir(raw_root) -> Path:
    return Path(raw_root) / "_llm-cache"

SYSTEM = (
    "You extract structured academic requirements from a minor or certificate "
    "description. Output ONLY a JSON object with keys: total_credits (int or null), "
    "required_courses (array of explicitly-required course code strings like "
    "\"ACCT 2010\"), elective_rules (array of objects with keys credits:int and "
    "level_or_subject_pattern:string), not_open_to (array of strings). Use course "
    "codes exactly as written. Do not invent courses."
)

def build_prompt(name: str, prose: str) -> tuple[str, str]:
    return SYSTEM, f"{name}\n\n{prose}"

def _prose_path(raw_root: Path, year: str, poid: int) -> Path:
    return Path(raw_root) / year / f"{poid}.txt"

def _llm_path(raw_root: Path, year: str, poid: int) -> Path:
    return Path(raw_root) / year / f"{poid}.llm.json"

def _validate(rule: dict) -> dict:
    """Sanitize LLM output: drop ill-formed course codes, reject non-int (incl.
    bool) credits, and coerce list-typed fields to lists. Never raises on a
    malformed/non-dict object."""
    if not isinstance(rule, dict):
        rule = {}
    else:
        rule = dict(rule)
    rc = rule.get("required_courses")
    rc = rc if isinstance(rc, list) else []
    rule["required_courses"] = [c for c in rc if isinstance(c, str) and CODE_RE.match(c)]
    tc = rule.get("total_credits")
    rule["total_credits"] = tc if isinstance(tc, int) and not isinstance(tc, bool) else None
    er = rule.get("elective_rules")
    rule["elective_rules"] = er if isinstance(er, list) else []
    no = rule.get("not_open_to")
    rule["not_open_to"] = no if isinstance(no, list) else []
    return rule

def extract_prose_program(raw_root: Path, year: str, poid: int, *,
                          name: str, kind: str, refresh: bool = False) -> ParsedProseProgram:
    prose = _prose_path(raw_root, year, poid).read_text()
    llm_path = _llm_path(raw_root, year, poid)
    cache_dir = _cache_dir(raw_root)
    cache_path = cache_dir / f"{_content_key(name, prose)}.json"

    if not refresh and cache_path.exists():
        rule = json.loads(cache_path.read_text())            # cross-year reuse, no LLM
    elif not refresh and llm_path.exists():
        rule = json.loads(llm_path.read_text())              # legacy per-poid extraction
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(rule, indent=2))    # seed content cache from it
    else:
        system, user = build_prompt(name, prose)
        rule = llm.extract_json(system, user)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(rule, indent=2))
    # always (re)write the per-year provenance file from the resolved rule
    llm_path.write_text(json.dumps(rule, indent=2))
    rule = _validate(rule)
    body = []
    for line in prose.splitlines():
        s = line.strip()
        if not s or "opens a new window" in s or s in ("a",) \
           or s.startswith("Add to My Favorites") or s.startswith("Print (") \
           or s.startswith("Help ("):
            continue
        body.append(s)
    return ParsedProseProgram(name=name, kind=kind,
                              total_credits=rule.get("total_credits"),
                              description=" ".join(body), rule=rule)
