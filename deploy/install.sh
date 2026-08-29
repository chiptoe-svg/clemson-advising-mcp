#!/bin/bash
# Install the two MCP servers and the daily refresh job as launchd services.
#
#   bash deploy/install.sh            # install (or re-install) and verify
#   bash deploy/install.sh --check    # verify only, change nothing
#   bash deploy/install.sh --uninstall
#
# Idempotent: re-running replaces the installed plists and restarts the
# services. Safe on a box that already has them.
#
# WHAT IT DOES NOT DO: it never writes .env, never mints a token, and never
# touches the reverse proxy. Those are decisions, not steps.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
AGENTS="$HOME/Library/LaunchAgents"
LABELS=(edu.clemson.advising-mcp.public edu.clemson.advising-mcp.catalog edu.clemson.advising-mcp.refresh)
MODE="${1:-install}"
case "$MODE" in
  install|--check|--uninstall) ;;
  *) echo "usage: $0 [--check | --uninstall]   (no argument installs)" >&2; exit 2 ;;
esac

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILED=1; }
FAILED=0

# --- uninstall --------------------------------------------------------------
if [ "$MODE" = "--uninstall" ]; then
  echo "==> removing services"
  for l in "${LABELS[@]}"; do
    launchctl bootout "gui/$(id -u)/$l" 2>/dev/null && ok "unloaded $l" || warn "$l was not loaded"
    rm -f "$AGENTS/$l.plist"
  done
  echo "Data, .env, and the consumer registries were left in place."
  exit 0
fi

# --- preflight --------------------------------------------------------------
# Everything here is a thing that has actually gone wrong somewhere, not a
# checklist for its own sake.
echo "==> preflight"

NPM="$(command -v npm)"
[ -n "$NPM" ] && ok "npm at $NPM" || bad "npm not found in PATH"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null \
  && ok "node $(node -v)" \
  || bad "node 22+ required, found ${NODE_MAJOR:-none}"

# A symlinked node_modules is how the repo is built and tested from a sibling
# checkout. It is fine there and wrong here: launchd services must not depend on
# another directory that may be moved, unmounted, or deleted.
if [ -L "$REPO/node_modules" ]; then
  bad "node_modules is a SYMLINK — run 'rm node_modules && npm ci' before installing"
elif [ -d "$REPO/node_modules" ]; then
  ok "node_modules present"
else
  bad "node_modules missing — run 'npm ci'"
fi

if [ -f "$REPO/.env" ]; then
  ok ".env present"
  # Loopback is the whole transport story (docs/security.md §5); a hand-edited
  # .env that binds elsewhere would put an MCP server with no Host/Origin check
  # on a campus-reachable interface. Existence alone proves nothing.
  for v in MCP_PUBLIC_HTTP_HOST MCP_CATALOG_HTTP_HOST; do
    h="$(grep -E "^$v=" "$REPO/.env" | tail -1 | cut -d= -f2- | tr -d '[:space:]')"
    case "${h:-127.0.0.1}" in
      127.0.0.1|::1|localhost) ok "$v is loopback" ;;
      *) bad "$v=$h — the servers must bind loopback; TLS terminates at the proxy" ;;
    esac
  done
  grep -qE '^MCP_TRANSPORT=http\s*$' "$REPO/.env" \
    && ok "MCP_TRANSPORT=http" \
    || bad "MCP_TRANSPORT=http is not set in .env — launchd would start a stdio server"
else
  bad ".env missing — copy deploy/env.example to .env and fill it in"
fi

# The catalog DB is built by core/ (needs network, Playwright, and an LLM
# endpoint — docs/operations.md §1) or copied from a machine that has one. A
# missing DB does not crash the catalog server; its tools report the catalog
# as unreadable, so check for the file rather than for a running process.
if [ -f "$REPO/core/db/gc_advisor.db" ]; then
  ok "catalog DB present ($(du -h "$REPO/core/db/gc_advisor.db" | cut -f1))"
else
  bad "core/db/gc_advisor.db missing — copy it from the build box (docs/operations.md)"
fi

SNAPS="$(ls "$REPO"/state/clemson/*.db 2>/dev/null | wc -l | tr -d ' ')"
if [ "$SNAPS" -gt 0 ]; then
  ok "$SNAPS schedule snapshot(s)"
else
  warn "no schedule snapshots — run 'npm run clemson:refresh' after install"
fi

# Ports must be free, or launchd will restart-loop a server that cannot bind.
#
# SCOPED TO LOOPBACK, and that is not a detail. The servers bind 127.0.0.1, but
# `lsof -iTCP:8766` matches that port on EVERY address — so a forwarder or any
# other service listening on a different interface reads as "in use" and this
# preflight refuses to install against a port that is genuinely free. Observed
# 2026-08-28 during the first real cutover: a container-bridge TCP forwarder on
# the bridge gateway address blocked an install onto free loopback ports.
for p in 8766 8767; do
  if lsof -nP -iTCP@127.0.0.1:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    # `launchctl list | grep -q` is wrong here: grep -q exits on the first
    # match, launchctl takes SIGPIPE, and under pipefail the pipeline is 141 —
    # so a RUNNING install of this very service read as "something else" and
    # a re-install refused. Ask launchd about the specific labels instead.
    if launchctl print "gui/$(id -u)/edu.clemson.advising-mcp.public" >/dev/null 2>&1 \
      || launchctl print "gui/$(id -u)/edu.clemson.advising-mcp.catalog" >/dev/null 2>&1; then
      warn "port $p in use (likely this service — it will be restarted)"
    else
      bad "port $p is in use by something else"
    fi
  else
    ok "port $p free"
  fi
done

if [ "$MODE" = "--check" ]; then
  [ "$FAILED" = 0 ] && echo "==> preflight PASSED" || echo "==> preflight FAILED"
  exit "$FAILED"
fi

if [ "$FAILED" != 0 ]; then
  echo "==> preflight FAILED — nothing installed. Fix the items above and re-run." >&2
  exit 1
fi

# --- install ----------------------------------------------------------------
echo "==> installing services"
mkdir -p "$AGENTS" "$HOME/Library/Logs"
for l in "${LABELS[@]}"; do
  src="$REPO/deploy/launchd/$l.plist"
  [ -f "$src" ] || { bad "template missing: $src"; continue; }
  # Substitute with | as the delimiter: paths contain / and $HOME may not.
  sed -e "s|REPO_PATH|$REPO|g" -e "s|NPM_PATH|$NPM|g" -e "s|HOME_PATH|$HOME|g" \
      "$src" > "$AGENTS/$l.plist"
  plutil -lint "$AGENTS/$l.plist" >/dev/null 2>&1 || { bad "$l.plist is not valid after substitution"; continue; }
  launchctl bootout "gui/$(id -u)/$l" 2>/dev/null   # ignore "not loaded"
  if launchctl bootstrap "gui/$(id -u)" "$AGENTS/$l.plist" 2>/dev/null; then
    ok "installed $l"
  else
    bad "could not bootstrap $l"
  fi
done

# --- verify -----------------------------------------------------------------
# A launchd job that is "loaded" has not necessarily started, and one that
# started has not necessarily bound its port or loaded its tools. Check the
# thing itself.
echo "==> verifying (giving the servers a moment to bind)"
sleep 4
for pair in "8766:public" "8767:catalog"; do
  port="${pair%%:*}"; which="${pair##*:}"
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST "http://127.0.0.1:$port/" 2>/dev/null)"
  case "$code" in
    401) ok "$which server answering on $port (401 = listening and authenticating)" ;;
    200) bad "$which server on $port answered 200 UNAUTHENTICATED — it is serving open" ;;
    "")  bad "$which server not answering on $port — see ~/Library/Logs/advising-mcp.$which.err.log" ;;
    *)   bad "$which server on $port returned $code, expected 401" ;;
  esac
  line="$(tail -1 "$HOME/Library/Logs/advising-mcp.$which.err.log" 2>/dev/null)"
  case "$line" in
    *"tools:"*) ok "  ${line#*— }" ;;
    *)          warn "  no startup line yet in advising-mcp.$which.err.log" ;;
  esac
done

echo
if [ "$FAILED" = 0 ]; then
  cat <<'NEXT'
==> installed.

Remaining, in order — none of these are automated on purpose:
  1. Pair each consumer:  npm run mcp:pair -- --server public  --id <agent>
                          npm run mcp:pair -- --server catalog --id <agent>
  2. Put the reverse proxy in front:  deploy/Caddyfile.example
  3. Verify over TLS with a REAL MCP client — a curl 200 proves routing and
     nothing else:  docs/operations.md, "Verifying the TLS path"
  4. Confirm the daily refresh ran tomorrow, and alert on snapshot AGE rather
     than on the job's exit status.
NEXT
else
  echo "==> installed WITH FAILURES — see above." >&2
  exit 1
fi
