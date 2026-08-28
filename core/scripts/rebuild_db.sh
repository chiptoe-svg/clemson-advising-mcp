#!/bin/bash
# Rebuild core/db/gc_advisor.db from scratch — the operator's one-command path.
#
# WHAT THIS IS: a full re-ingest of the college-wide catalog. Program pages are
# re-rendered from the LIVE Clemson catalog (network required); the two
# expensive corpora are cache-backed and near-instant on a warm tree:
#   - course detail pages   -> data/raw/courses/   (4,085 frozen snapshots)
#   - minor/cert extraction -> data/raw/_llm-cache/ (content-addressed LLM JSON)
# So a rebuild on this machine is minutes, not the hours the first build took.
# NOTE: because program pages re-render live, a rebuild AFTER Clemson edits the
# catalog is a legitimate data refresh, not a byte-identical reproduction.
# This applies even with GC_INGEST_DB set: raw snapshots (data/raw/) and the
# LLM cache refresh IN THE WORKING TREE on every run — a scratch-DB acceptance
# run can still dirty tracked data files. Review the diff and commit it as a
# data refresh (or discard it) after any run; the DB target only redirects
# where the database is written.
#
# USAGE:
#   scripts/rebuild_db.sh                # rebuild the real DB (core/db/gc_advisor.db)
#   GC_INGEST_DB=/tmp/x.db scripts/rebuild_db.sh   # scratch build (acceptance runs)
#
# GC_INGEST_DB is deliberately NOT GC_ADVISOR_DB: the service config reads the
# latter, and an exported override must never repoint the live daemons.
#
# Idempotent: every step is safe to re-run; a crashed run resumes from caches.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin/python
DB="${GC_INGEST_DB:-db/gc_advisor.db}"
export GC_INGEST_DB="$DB"
export PYTHONPATH=src

step() { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'PREFLIGHT FAIL: %s\n' "$*" >&2; exit 1; }

step "Preflight"
[ -x "$PY" ] || fail ".venv missing — run: python3.14 -m venv .venv && .venv/bin/pip install -e '.[dev]'"
"$PY" -c "import playwright" 2>/dev/null || fail "playwright not installed in .venv (pip install -e .)"
"$PY" -c "from playwright.sync_api import sync_playwright
with sync_playwright() as p: p.chromium.launch().close()" 2>/dev/null \
  || fail "Playwright browser missing — run: .venv/bin/python -m playwright install chromium"
[ -n "${GC_LLM_API_KEY:-}" ] || fail "GC_LLM_API_KEY not set (bearer for the local LLM; no default)"
LLM_BASE="${GC_LLM_BASE_URL:-http://localhost:8000}"
curl -sf -m 5 -H "Authorization: Bearer $GC_LLM_API_KEY" "$LLM_BASE/v1/models" >/dev/null \
  || fail "LLM server not answering at $LLM_BASE (start omlx; model ${GC_LLM_MODEL:-Qwen3.6-27B-UD-MLX-4bit})"
curl -sf -m 10 -o /dev/null https://catalog.clemson.edu/ \
  || fail "catalog.clemson.edu unreachable — program-page ingest needs the network"
echo "preflight OK — target DB: $DB"

step "1/8 GC BS, 8 catalog years (backfill.py: navoid discovery + ingest_year)"
"$PY" scripts/backfill.py

step "2/8 Six COB majors x 4 years (24 ingests; exact registrar name strings)"
for prog in "Accounting, BS" "Economics, BA" "Economics, BS" \
            "Financial Management, BS" "Management, BS" "Marketing, BS"; do
  for y in 2023-2024 2024-2025 2025-2026 2026-2027; do
    "$PY" scripts/ingest_year.py "$y" --program "$prog"
  done
done

step "3/8 Pre-Business (4 years, extracted from the Marketing page)"
"$PY" scripts/ingest_pre_business.py

step "4/8 Course catalog (4,085 courses; snapshot-cached)"
"$PY" scripts/crawl_courses.py

step "5/8 Minors + certificates (LLM prose extraction; cache-addressed)"
"$PY" scripts/backfill_prose.py

step "6/8 Requirement rules + gen-ed + academic regulations (all years)"
"$PY" scripts/backfill_requirements.py

step "7/8 Coreqs + course source URLs"
"$PY" scripts/backfill_coreqs.py
"$PY" scripts/backfill_course_urls.py --db "$DB"

step "8/8 Department packs (order-free, idempotent; refreshes bogus flags)"
for pack in packs/gc packs/marketing packs/accounting packs/economics \
            packs/management packs/reach-act packs/social-science; do
  "$PY" scripts/apply_pack.py "$pack" --db "$DB"
done

step "Census"
sqlite3 "file:$DB?mode=ro" "SELECT
  'programs='||(SELECT count(*) FROM program),
  'minors='||(SELECT count(*) FROM program WHERE kind='minor'),
  'certificates='||(SELECT count(*) FROM program WHERE kind='certificate'),
  'courses='||(SELECT count(*) FROM course),
  'effective_rules='||(SELECT count(*) FROM requirement_rule_effective);"
echo "Reference census (verified rebuild, 2026-08-26): programs=997 minors=879 certificates=82 courses=4085 effective_rules=1057"
echo "  (live DB of 2026-08-26 showed 994/876/.../1054 — it is missing 3 minors in 2021-2022"
echo "   that the original ingest silently dropped; a fresh rebuild recovers them, so 997 is correct.)"
echo "Counts drift legitimately when Clemson edits the catalog — compare against"
echo "the reference and investigate deltas; do not expect byte-identity."
echo
echo "Acceptance: run the suite against this DB:"
echo "  GC_INGEST_DB=$DB $PY -m pytest tests -q -m 'not integration'   # tests read db/gc_advisor.db — for a scratch DB, swap it into place or symlink"
