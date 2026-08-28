# Operations

How to install, deploy, verify, and keep this running. Companions:
`architecture.md` (how it works, and how to diagnose it), `security.md` (the
controls), `capacity.md` (sizing).

---

## 1. Install

Requirements: **Node 22+**, and **Python 3.12+** only if you intend to rebuild
the catalog database on this machine. A serving host does not need Python at
all — every request path is TypeScript reading SQLite.

```bash
npm ci
npm run typecheck
```

Three data artifacts are not in git and must be provided:

| Artifact                | What it is                                 | Where it comes from                                                 |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `core/db/gc_advisor.db` | Curriculum catalog, ~5.7 MB                | Built by the Python pipeline, or copied from a machine that has one |
| `state/clemson/*.db`    | Banner class-schedule snapshots, ~21 MB    | The refresh job (§4)                                                |
| `.env`                  | Per-server bearer tokens and bind settings | Written at deploy time (§2)                                         |

**The catalog database cannot be built on a serving host, and this is not a
matter of convenience.** `core/scripts/rebuild_db.sh` needs Playwright, a live
crawl of the Clemson catalog, an LLM for minor and certificate extraction, and
roughly 4,000 cached page snapshots that are deliberately not in this
repository. A cold build is hours; a warm one on the build box is minutes.

The intended shape is therefore a **build box** that owns the Python pipeline
and its caches and produces a `.db`, and a **serving box** that receives that
file. The catalog changes annually, so this is one file copy a year — not an
ongoing coupling.

On the build box:

```bash
python3 -m venv core/.venv && core/.venv/bin/pip install -e "core[dev]"
core/scripts/rebuild_db.sh
```

Keeping the serving host Python-free is deliberate: one runtime in production
and a smaller review surface. One tool still shells out to Python —
`audit-gc-progress`, which was called 0 times in 366 real calls. A serving box
with no Python serves every other tool correctly and fails that one; if you
need it, provision `core/.venv` there as well.

Verify the install before going further:

```bash
npm test            # expect: 0 fail, 0 skipped
npm run core:test   # only if Python is installed here; expect 0 skipped
```

> The suites must report **0 skipped**, not merely 0 failed. A missing catalog
> DB shows up as a large skip count and a green-looking run — the count, not the
> colour, is the gate.

---

## 2. Configure

Set per server, in `.env`:

```
MCP_TRANSPORT=http
MCP_PUBLIC_HTTP_HOST=127.0.0.1     # keep loopback; TLS terminates in the proxy
MCP_PUBLIC_HTTP_PORT=8766
MCP_CATALOG_HTTP_HOST=127.0.0.1
MCP_CATALOG_HTTP_PORT=8767
MCP_PUBLIC_AUTH_TOKEN_PROVIDER=clemson_hosted
MCP_CATALOG_AUTH_TOKEN_PROVIDER=clemson_hosted
```

**Set the two `_PROVIDER` values explicitly.** Unset, they attest `openai_api`,
and the usage ledger will then name a destination the deployment does not use.
The value must be a backend that `policy/action-policy.yaml` authorizes for this
server's data class; anything else is refused at startup.

`MCP_TRUSTED_PROXIES` defaults to loopback, which is correct when the reverse
proxy runs on the same host. Set it only for a proxy on a different address, and
set it to the **proxy's** address, never to a client range.

### Tokens

```bash
npm run mcp:pair -- --server public  --id <agent> --provider <backend>
npm run mcp:pair -- --server catalog --id <agent> --provider <backend>
npm run mcp:pair -- --server public  --list
npm run mcp:pair -- --server public  --revoke <agent>
```

The raw token prints **once**. Each server has its own registry, so pair an
agent that needs both against both. A mint or revoke takes effect on the next
request — no restart. One token per consumer, always: sharing one is what makes
the usage ledger meaningless.

---

## 3. Serve over TLS

The servers stay on loopback and speak plain HTTP. A reverse proxy in front
terminates TLS. `deploy/Caddyfile.example` is a working starting point; copy it
and fill in the four marked values.

Four things in it are load-bearing:

1. **Path prefixes on one hostname.** Campus OV certificates commonly carry a
   single subject-alternative name, which rules out a hostname per server
   without a second certificate request.
2. **`flush_interval -1`.** MCP replies are `text/event-stream`. Today each
   carries a content-length and closes immediately, so buffering costs only
   latency — but a future SDK that streams progress notifications would have
   them held until the stream ended.
3. **An explicit 404 for unmapped paths.** Without it, a misspelled MCP path
   falls through to whatever else the proxy serves. Observed 2026-08-28: such a
   request reached a different local application, which replied "Authentication
   required." — an auth error from the wrong service, indistinguishable from the
   right one.
4. **The certificate's expiry date.** A campus OV certificate is issued manually
   and does not auto-renew. Put its expiry in a calendar with a month of warning.
   An expired certificate takes every client down simultaneously.

### Verifying the TLS path

A 200 from `curl` proves routing and nothing else. It does not prove
`initialize` negotiated, that the server's instructions arrived, or that
`tools/call` round-trips. Verify with a **real MCP client**:

```bash
npx -y @modelcontextprotocol/inspector --cli \
  https://<host>:8443/schedule/ \
  --transport http --header "Authorization: Bearer $TOKEN" --method tools/list
```

Then confirm four things, in this order:

```bash
# 1. Unauthenticated requests are refused at each path.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<host>:8443/schedule/   # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<host>:8443/catalog/    # 401

# 2. An unmapped path 404s rather than reaching another application.
curl -s -o /dev/null -w '%{http_code}\n' https://<host>:8443/nonesuch/           # 404

# 3. A token minted for one server is REJECTED by the other.
#    (Post an initialize with the schedule token to /catalog/ — expect 401.)

# 4. The server now attributes the real caller, not the proxy.
tail -2 ~/Library/Logs/*.mcp-public.log   # source must be the client, not 127.0.0.1
```

Step 4 catches a genuinely silent misconfiguration: if `MCP_TRUSTED_PROXIES`
does not include the proxy's address, every caller is logged as the proxy and
the per-source throttle collapses into one shared bucket.

---

## 4. Keep the data fresh

**Silent staleness is this system's most common failure.** Nothing breaks; the
servers keep answering, confidently, from an old snapshot. See
`architecture.md` §5.

```bash
npm run clemson:refresh
```

Schedule it daily. Every tool that reads schedule data reports a `data as of`
timestamp, so a client can see staleness — but only a client that looks.

The curriculum catalog changes annually, not daily. Rebuild it when Clemson
publishes a new catalog year, on a build machine, then copy the `.db` across and
restart the catalog server.

---

## 4b. Deploying to a new box

The end state is a machine that runs these two servers and nothing else, whose
data other systems reach **only** through MCP. Nothing on it imports this code,
opens its database, or shells into `core/`.

```bash
git clone <repo> && cd clemson-advising-mcp
npm ci                                  # NOT a symlinked node_modules — see below
cp deploy/env.example .env              # then fill it in (s2)
# copy core/db/gc_advisor.db from the build box (s1)
npm run clemson:refresh                 # first schedule snapshot
npm test                                # 0 fail, 0 skipped
bash deploy/install.sh
```

`deploy/install.sh` preflights, installs three launchd services (both servers
plus the daily refresh), and verifies that each server answers 401 and loaded
its tools. It refuses to install if the preflight fails, and it never writes
`.env`, mints a token, or touches the proxy — those are decisions, not steps.
`--check` preflights without changing anything; `--uninstall` removes the
services and leaves the data.

Two preflight failures are worth knowing in advance, because both look harmless:

- **A symlinked `node_modules`.** Convenient when the repo is built beside a
  sibling checkout, wrong for a service: launchd would depend on a directory
  that can be moved, unmounted, or deleted out from under it.
- **A missing catalog database.** The catalog server does not crash without it.
  It answers, and its answers are empty — which a model reports as "there is no
  such program."

Then, in order: pair each consumer (§2), put the proxy in front (§3), verify
over TLS with a real MCP client (§3), and confirm the refresh ran tomorrow.

Ongoing monitoring:

```bash
npm run mcp:health          # exit 0 healthy, 1 degraded, 2 down
npm run mcp:health -- --json
```

It needs no bearer token — everything it checks is observable without one, and
a health check that holds a credential is a health check that can leak one.
Alert on its exit code, and specifically on `schedule:freshness`: the refresh
job failing is silent, and it is the failure this system actually has.

---

## 5. Restart

**Both servers load their tool registry and `policy/action-policy.yaml` once, at
process start.** Editing the source does not update a running server: it keeps
serving the old build and fails silently — the new tool simply never appears in
`tools/list`. Any change that adds, removes, renames, or reshapes a tool, or
edits the policy, is not done until the affected server is restarted **and its
tool list is verified**.

On macOS/launchd:

```bash
launchctl kickstart -k gui/$(id -u)/com.<label>.mcp-public-http
launchctl kickstart -k gui/$(id -u)/com.<label>.mcp-catalog-http
```

Then read the startup line, which is the single most informative log this system
produces — it names the bind, the consumer count, and every tool being served:

```bash
tail -1 ~/Library/Logs/*.mcp-public.err.log
tail -1 ~/Library/Logs/*.mcp-catalog.err.log
```

If the tool you just added is not in that line, the restart did not pick up your
change. Restarting the reverse proxy is not required for tool or policy changes.

---

## 6. Health

```bash
npm run mcp:health          # exit 0 healthy, 1 degraded, 2 down
npm run mcp:health -- --json
```

Four things, and each is there because the obvious check would have missed it:

| Check                                  | Why not something simpler                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 401 on each port                     | Proves routing, the listener, and the auth path in one. A **200** without a token is reported as DOWN, not healthy — serving open is worse than being down |
| Tools loaded, from the startup line    | The only place the loaded tool list appears. A server restarted before a change was saved serves the old build, silently                                   |
| Snapshot age                           | The failure this system actually has. Nothing else here would notice                                                                                       |
| Catalog DB present and plausibly sized | Present-but-truncated makes the server answer "no such program" rather than fail                                                                           |

There is no health _endpoint_, deliberately: an unauthenticated one is a
surface, and an authenticated one needs a credential — so the check would have
to hold a token, which is a thing that can leak. Everything above is observable
from outside without one.

Set `MCP_LOG_PATTERN` if your log names differ from
`advising-mcp.{which}.err.log`.

---

## 7. Back up

Almost everything here is rebuildable, which is what makes cheap hardware
defensible. Two things are not:

|                                   | Size | Consequence if lost                          |
| --------------------------------- | ---- | -------------------------------------------- |
| `state/mcp-consumers-*.json`      | KB   | Every paired agent must be re-issued a token |
| `state/analytics/mcp-calls.jsonl` | MB   | The only record of who used what             |

Both belong in a nightly off-box backup. `.env` holds unrecoverable secrets and
is not in git — back it up before **any** edit, and never truncate or redirect
into it.

Everything else restores from source: the catalog DB rebuilds from the published
catalog, snapshots re-fetch from Banner, the code is in git.

---

## 8. How this repository was extracted

This repo was split out of a larger private one by a scripted, idempotent build
that recomputes the server dependency closure on each run, preserves the
TypeScript history for those paths, and imports the Python catalog package fresh
without its former project's lineage.

A **blocking audit** runs on every build and stops publication on any hit: files
belonging to the private half, built databases, LLM caches, bulk scraped data,
student-record derivatives, `.env` in history, C-IDs, SSNs, and any email
address outside a named allowlist — checked across **all history**, not just the
current tree.

That audit failed four times before it passed, each time on something reading
the tree would not have caught: fixture data naming a real person, a colleague's
address surviving in commits after being removed from the file, another
project's planning documents carrying a placeholder identifier, and an
unanchored copy rule that silently produced a Python package which installed but
could not import. **Treat an audit failure as a real finding**, not as the
script being fussy.
