import os
import json
import urllib.request

DEFAULT_BASE = os.environ.get("GC_LLM_BASE_URL", "http://localhost:8000")
DEFAULT_MODEL = os.environ.get("GC_LLM_MODEL", "Qwen3.6-27B-UD-MLX-4bit")
# Env-only, no literal default (Phase E3 review): operators set GC_LLM_API_KEY.
DEFAULT_KEY = os.environ.get("GC_LLM_API_KEY")

def extract_json(system: str, user: str, *, model: str | None = None,
                 base_url: str | None = None, api_key: str | None = None,
                 timeout: int = 180) -> dict:
    """Call an OpenAI-compatible chat endpoint forcing JSON output; return the
    parsed object. Raises ValueError if the model's content is not valid JSON."""
    model = model or DEFAULT_MODEL
    base_url = (base_url or DEFAULT_BASE).rstrip("/")
    api_key = api_key or DEFAULT_KEY
    if not api_key:
        raise RuntimeError(
            "GC_LLM_API_KEY is not set — required for the prose-extraction LLM "
            "(see core/scripts/rebuild_db.sh preflight)")
    payload = {
        "model": model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read())
    content = body["choices"][0]["message"]["content"]
    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        raise ValueError(f"LLM did not return valid JSON: {content[:200]!r}") from e
