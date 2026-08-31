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

| Artifact             | What it is                                 | Where it comes from                                                               |
| -------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| `core/db/catalog.db` | Curriculum catalog, ~5.7 MB                | Built here by `core/scripts/rebuild_db.sh`, or copied from a machine that has one |
| `state/clemson/*.db` | Banner class-schedule snapshots, ~21 MB    | The refresh job (§4)                                                              |
| `.env`               | Per-server bearer tokens and bind settings | Written at deploy time (§2)                                                       |

**The catalog database is built here, from this repository** — or copied from a
machine that already built one, which is faster when one exists. Those are the
only two ways to get it, and both are supported; nothing else in this repository
should suggest otherwise. The scraper, its parsers, and its cached corpus all
travel with the code: `core/data/raw` holds 6,057 scraped catalog pages across
nine catalog years plus 326 content-addressed cached model extractions. That cache is what makes a rebuild minutes
rather than hours — without it, every minor and certificate page would go back
through a language model.

```bash
python3 -m venv core/.venv && core/.venv/bin/pip install -e "core[dev]"
core/.venv/bin/python -m playwright install chromium
core/scripts/rebuild_db.sh
```

`core/README.md` is the map of that package: what runs at build time, what the
page corpus holds, and why the LLM cache does not remove the LLM requirement.

Three things a rebuild needs, and it will refuse to start without them:

|                                                       | Why                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Network to `catalog.clemson.edu`                      | Program pages are re-rendered live. A rebuild is a data refresh, not a byte-identical reproduction |
| Playwright + Chromium                                 | The catalog is a JavaScript application; the pages do not exist as static HTML                     |
| An LLM endpoint (`GC_LLM_API_KEY`, `GC_LLM_BASE_URL`) | Minor and certificate requirements are extracted by a model                                        |

**The LLM requirement does not go away because the cache is warm, and this is
worth understanding before planning around it.** The cache is keyed on page
CONTENT, so a page Clemson has edited misses — and a changed page is precisely
what you are rebuilding for. Most pages hit; the interesting ones do not. Point
`GC_LLM_BASE_URL` at whichever Clemson-hosted model this deployment is entitled
to use.

The catalog changes annually, so this runs about once a year. Copying a built
`.db` from another machine that already has one remains perfectly valid and is
the faster path when one exists.

The serving host needs no Python: one runtime in production and a smaller
review surface. Every tool is TypeScript reading SQLite. `core/.venv` is needed
only to rebuild the database or to run the differential test that checks the
Node reads against the Python they replaced.

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
MCP_SCHEDULE_HTTP_HOST=127.0.0.1     # keep loopback; TLS terminates in the proxy
MCP_SCHEDULE_HTTP_PORT=8766
MCP_CATALOG_HTTP_HOST=127.0.0.1
MCP_CATALOG_HTTP_PORT=8767
```

`MCP_TRUSTED_PROXIES` defaults to loopback, which is correct when the reverse
proxy runs on the same host. Set it only for a proxy on a different address, and
set it to the **proxy's** address, never to a client range.

### Every variable the servers read

`deploy/env.example` carries the ones a deployment sets. This is the complete
list, so "what else could be configured here?" has an answer that is not a grep.

| Variable                                             | Default                        | What it does                                                                                            |
| ---------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `MCP_TRANSPORT`                                      | `stdio`                        | `http` to serve over the network. launchd sets it via `.env`                                            |
| `MCP_SCHEDULE_HTTP_HOST` / `_PORT`                   | `127.0.0.1` / `8766`           | Schedule server bind                                                                                    |
| `MCP_CATALOG_HTTP_HOST` / `_PORT`                    | `127.0.0.1` / `8767`           | Catalog server bind                                                                                     |
| `MCP_SCHEDULE_AUTH_TOKEN` / `MCP_CATALOG_AUTH_TOKEN` | unset                          | Optional shared fallback token per server (§2, Tokens)                                                  |
| `MCP_TRUSTED_PROXIES`                                | loopback                       | Whose `X-Forwarded-For` is believed                                                                     |
| **Rarely set**                                       |                                |                                                                                                         |
| `MCP_CONSUMER_RATE_LIMIT`                            | `600`                          | Per-credential requests/minute. Garbage falls back to the default rather than disabling the limit       |
| `MCP_USAGE_ANALYTICS`                                | on                             | `off` disables the usage ledger. The test suite sets it                                                 |
| `MCP_ANALYTICS_DIR`                                  | `$STATE_DIR/analytics`         | Where the ledger is written                                                                             |
| `STATE_DIR`                                          | `./state`                      | Snapshots, registries, ledger                                                                           |
| `POLICY_DIR`                                         | `./policy`                     | Where `action-policy.yaml` is read from. A bad path now refuses to start rather than serving zero tools |
| `CATALOG_DB`                                         | `core/db/catalog.db`           | The catalog database                                                                                    |
| `GC_ADVISOR_SKILLS`                                  | `core/skills`                  | The catalog server's skill documents                                                                    |
| `LOG_FILE`, `LOG_LEVEL`, `LOG_MAX_BYTES`, `LOG_KEEP` | see `src/log.ts`               | Application log destination and rotation                                                                |
| `MCP_LOG_PATTERN`                                    | `advising-mcp.{which}.err.log` | Where `mcp:health` looks for startup lines                                                              |

### Tokens

```bash
npm run mcp:pair -- --server schedule  --id <agent>
npm run mcp:pair -- --server catalog --id <agent>
npm run mcp:pair -- --server schedule  --list
npm run mcp:pair -- --server schedule  --revoke <agent>
```

The raw token prints **once**. Each server has its own registry, so pair an
agent that needs both against both. A mint or revoke takes effect on the next
request — no restart. One token per consumer, always: sharing one is what makes
the usage ledger meaningless.

**Rotation.** There is no in-place rotation, deliberately — a token is a hash on
disk and the raw value is unrecoverable, so rotating is revoke-then-mint:

```bash
npm run mcp:pair -- --server schedule --revoke <agent>   # effective immediately
npm run mcp:pair -- --server schedule --id <agent>       # new token, printed once
```

Rotating the **shared** token instead means editing `.env` and restarting both
servers, which is one reason to prefer per-consumer tokens. Back `.env` up
before editing it; it is not in git and holds the only copy.

**Scopes.** A consumer may be minted with a `scopes` list, which narrows both
`tools/list` and `tools/call` — a scoped consumer does not see tools outside
its grant at all:

```bash
# student-facing: official schedule + published catalog, nothing departmental
npm run mcp:pair -- --server catalog --id student-agent --scopes clemson.catalog
# advisor-facing: everything, including the departmental layer
npm run mcp:pair -- --server catalog --id advisor-agent   # unscoped = full
```

Vocabulary: `clemson.schedule`, `clemson.catalog`, `clemson.department`,
`host`, and the legacy broad `clemson` (which deliberately does NOT include
the departmental layer). No `--scopes` = full access.

**Departmental decisions** live in `departments/<id>/` — `rules.yaml` for slot
decisions, `SKILL.md` for policy prose. The files are the store: an edit
serves on the next request, no build step and no restart. Onboarding a
department = filling in its files.

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
tail -2 ~/Library/Logs/advising-mcp.schedule.log   # source must be the client, not 127.0.0.1
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

`deploy/install.sh` installs this as a launchd job at 05:00 daily
(`edu.clemson.advising-mcp.refresh`). Every tool that reads schedule data
reports a `data as of` timestamp, so a client can see staleness — but only a
client that looks.

What it does to Banner, since it is someone else's production system: one sweep
per live term (currently seven), pages of 500 sections capped at 40 pages,
200–400 ms between requests, 1 s between terms, at most three attempts per term,
and `Connection: close` on every request. A scan that does not complete is
discarded rather than written, and the refresh reports `FAILED` for that term
rather than reporting success over an unchanged snapshot. See `security.md`,
"What leaves this machine".

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
cp deploy/env.example .env              # then fill it in (§2)
# provide core/db/catalog.db: build it (§1) or copy one across (§1)
npm run clemson:refresh                 # first schedule snapshot
npm run test:gate                       # 0 fail, 0 skipped
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

### The current deployment, as of 2026-08-28

Stated so a reviewer is not guessing. Both servers run under **launchd as a
per-user GUI agent** (`~/Library/LaunchAgents/edu.clemson.advising-mcp.*`) on a
macOS machine, bound to loopback, behind a Caddy reverse proxy that terminates
TLS on `gcworkflow.clemson.edu:8443` and maps two path prefixes to the two
servers. The certificate is a manually renewed campus InCommon certificate.

Two consequences of a per-user agent worth knowing: it starts at login, not at
boot, so an unattended reboot leaves the service down until someone logs in; and
it runs as that user, with that user's file permissions. A machine that will be
rebooted unattended should use a system daemon (`/Library/LaunchDaemons`) or a
managed VM instead — `capacity.md` §3 covers the hosting options.

## 4c. Taking over from a co-located installation

Record of the first real cutover, 2026-08-28, when these servers moved from
running inside the advisor's checkout to running from this repository on the
same box. Written down because three things were non-obvious and cost time.

**Sequence that worked, with no downtime for the advisor:**

1. Bring this repo's servers up on **spare ports** as plain processes
   (`MCP_PUBLIC_HTTP_PORT=8776 npx tsx src/mcp-public.ts`, same for catalog on
   8777), with the production ports left in `.env`. Check the startup lines.
2. Point the advisor at the spare ports, restart it, and verify from the
   **usage ledger** (`state/analytics/mcp-calls.jsonl` gaining lines while the
   old installation's ledger goes quiet) — a green health check only proves
   that something answered.
3. Unload the old installation's launchd jobs. Only now are the production
   ports free on loopback.
4. `bash deploy/install.sh`. Read the startup lines from
   `~/Library/Logs/advising-mcp.*.err.log`, not from a re-probe: confirm the
   bind is `127.0.0.1`, the consumer count, and the tool list.
5. Point the advisor back at the defaults, verify from the ledger again, then
   verify the proxy path with a real MCP client over TLS.
6. Kill the spare-port processes. Unload the old installation's **refresh
   job** too — otherwise Banner is crawled twice at 05:00 by two jobs writing
   two snapshot directories, only one of which is served.

Steps 3 and 4 must stay in that order. Both installations' plists carry
`KeepAlive`, and two of them fighting over one port is a restart loop that
looks like a code fault.

**The three non-obvious things:**

- **Paired credentials survive the move without re-minting.** The consumer
  registries (`state/mcp-consumers-<server>.json`) hold sha256 hashes, not
  tokens. Copying them from the old installation moves no secret and lets every
  paired consumer keep the token it already has. The **shared** env tokens
  (`MCP_*_AUTH_TOKEN`) are secrets and must be placed in `.env` by hand before
  the new servers take the production ports, or every caller on that path 401s.
- **`lsof` can show a listener on the port while `curl 127.0.0.1:<port>`
  returns nothing.** The container bridge (`com.cuassistant.mcp-public-bridge`)
  listens on the bridge-gateway address on the same port numbers and forwards
  into loopback. It is not a conflict, it is shared with other services, and it
  starts forwarding to the new servers the moment they bind. Leave it alone.
  The preflight is scoped to `127.0.0.1` for exactly this reason.
- **A count from the ledger is evidence, not a verdict.** A 5,000-call burst
  on the shared-token path turned out to be a one-off verification sweep from
  the night before, not live traffic; it briefly drove false urgency. Break a
  number down by hour before acting on it.

The refresh job installed here had never fired at the time of the cutover.
Confirm the first 05:00 run wrote a fresh `state/clemson/<term>.db` — alert on
snapshot **age**, not on the job's exit status.

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
launchctl kickstart -k gui/$(id -u)/edu.clemson.advising-mcp.schedule
launchctl kickstart -k gui/$(id -u)/edu.clemson.advising-mcp.catalog
```

Then read the startup line, which is the single most informative log this system
produces — it names the bind, the consumer count, and every tool being served:

```bash
tail -1 ~/Library/Logs/advising-mcp.schedule.err.log
tail -1 ~/Library/Logs/advising-mcp.catalog.err.log
```

If the tool you just added is not in that line, the restart did not pick up your
change. Restarting the reverse proxy is not required for tool or policy changes.

---

The `server` field in ledger rows tracks the server's name at the time:
`cuassistant-public` before 2026-08-29, `advising-mcp-schedule` for a day, and
`advising-mcp-schedule` from 2026-08-30. Same server throughout. The schedule
server's registry file moved from `mcp-consumers-public.json` to
`mcp-consumers-schedule.json` in the same rename; consumer hashes carried over.

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
