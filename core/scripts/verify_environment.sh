#!/bin/zsh
# Environment health check for the cob-advisor repo (core/ + TypeScript service).
# Run any time (e.g. after a reboot):  zsh scripts/verify_environment.sh
# Prints OK/FAIL per check; safe to run repeatedly.

GC="$(cd "$(dirname "$0")/.." && pwd -P)"     # core/  (the Python catalog + audit core)
CU="$(cd "$GC/.." && pwd -P)"                # repo root (the TypeScript service; owns .git)
pass=0; fail=0
ok()   { echo "OK   $1"; pass=$((pass+1)); }
bad()  { echo "FAIL $1"; fail=$((fail+1)); }

# 1. One repo: core/ is a subtree of the service repo
[ -d "$CU/.git" ] && ok "repo present ($CU)" || bad "repo missing at $CU"
[ -f "$GC/pyproject.toml" ] && ok "core/ present" || bad "core/pyproject.toml missing — core/ is not a subtree of $CU"
br=$(git -C "$CU" branch --show-current)
echo "     branch: $br (expect: main)"
dirty=$(git -C "$CU" status --porcelain -- core | grep -v '^??' | wc -l | tr -d ' ')
[ "$dirty" = "0" ] && ok "core/ working tree clean" || bad "core/ has $dirty modified files"
git -C "$CU" rev-parse -q --verify gc-advisor-premerge >/dev/null \
  && ok "gc-advisor-premerge tag present (pre-merge history anchor)" || bad "gc-advisor-premerge tag missing"

# 2. Python env + catalog DB
[ -x "$GC/.venv/bin/python" ] && ok "venv python present" || bad "venv missing — python3 -m venv .venv && pip install -e ."
[ -f "$GC/db/gc_advisor.db" ] && ok "catalog DB present" || bad "db/gc_advisor.db missing"

# 3. Audit pipeline smoke (engine + CLI) — the entry point CUassistant shells out to
cd "$GC" || exit 1
out=$(PYTHONPATH=src .venv/bin/python scripts/audit.py --progress tests/fixtures/progress_partial.json 2>/dev/null \
      | python3 -c "import json,sys; a=json.load(sys.stdin); print(a['credits_earned'])" 2>/dev/null)
[ "$out" = "20.0" ] && ok "audit CLI smoke (earned=20.0)" || bad "audit CLI smoke (got: '$out', expect 20.0)"

# 4. Unit tests (fast subset)
if "$GC/.venv/bin/pytest" -q -m "not integration" >/tmp/gc_pytest.log 2>&1; then
  ok "pytest non-integration suite ($(tail -1 /tmp/gc_pytest.log | tr -d '\n'))"
else
  bad "pytest failing — see /tmp/gc_pytest.log"
fi

# 5. Services (informational — start manually if needed)
curl -s -m 2 http://localhost:8000/v1/models >/dev/null 2>&1 \
  && ok "omlx LLM server up (localhost:8000)" || echo "INFO omlx not running (only needed for prose/minor ingestion — not for audit work)"
curl -s -m 2 http://127.0.0.1:8767/ >/dev/null 2>&1 \
  && ok "CUassistant curriculum MCP HTTP up (8767)" || echo "INFO curriculum MCP HTTP (8767) not up — check: launchctl list | grep cuassistant"

echo ""
echo "== $pass OK, $fail FAIL =="
[ $fail -eq 0 ] && echo "Environment ready."
