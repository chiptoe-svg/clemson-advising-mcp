# Clemson Advising MCP Servers — background, architecture, and operations

**Status:** current as of 2026-08-27 · **Audience:** a maintainer or reviewer with
no prior exposure to this system, including Clemson IT security.

This document explains what these two servers are, why they exist, how they are
built, how to diagnose them when they misbehave, and what hardware they need to
serve a campus population. It is written to be read start to finish by someone
who has never seen the code.

---

## 1. Purpose — what problem this solves

Clemson publishes two bodies of information that academic advisors need
constantly and that are painful to use:

1. **The class schedule** — which sections of which courses run in a given term,
   when they meet, who teaches them, how many seats remain. Published through
   Banner, usable only through a search UI built for one lookup at a time.
2. **The degree catalog** — what each program requires: the semester-by-semester
   plan, named requirement slots, General Education rules, prerequisites.
   Published as a web catalog, navigable only by reading it.

Answering an ordinary advising question — *"my student needs a 3-credit
afternoon elective that fits around ENGL 3040 and counts toward their specialty
area"* — means cross-referencing both by hand, repeatedly, per student.

These servers expose both bodies as **structured, machine-callable tools over
MCP (Model Context Protocol)**, so an AI assistant can answer such questions
directly and deterministically instead of guessing. They are the retrieval layer.
They contain no reasoning and no student data.

**Design stance:** every answer must be traceable to published Clemson data. The
tools return catalog and Banner facts with a `_source` line, never a model's
recollection. A tool that cannot find something says so explicitly rather than
returning an empty result the caller might read as "nothing exists".

---

## 2. What the two servers are

| | **Public server** | **Catalog server** |
|---|---|---|
| Port | 8766 | 8767 |
| Serves | Clemson class schedule | Degree catalog and curriculum |
| Data source | Banner snapshots (SQLite, refreshed daily 05:00) | Built catalog DB (SQLite) + Python query/audit CLI |
| Tools | 9 | 9 (10 as of 2026-08-27) |
| Holds student data | No | No |
| Holds credentials | No | No |

They are deliberately **two servers, not one**. They have different data
lifecycles (the schedule changes daily during registration; the catalog changes
once a year), different failure modes, and different credentials — so one can be
restarted, revoked, or taken down without touching the other.

### Tool inventory

**Public (8766)** — `list-clemson-terms`, `search-classes`, `get-course-details`,
`check-conflicts`, `find-conflict-free-schedule`, `find-alternatives`,
`get-schedule-freshness`, `list-skills`, `get-skill-docs`

**Catalog (8767)** — `list-gc-catalog-years`, `get-gc-program-plan`,
`get-gc-requirement-rules`, `get-gc-gen-ed`, `get-program-requirements`,
`find-requirement-sections`, `find-course-in-program`, `audit-gc-progress`,
`list-gc-skills`, `get-gc-skill-docs`

---

## 3. Architecture

### Request path

```
client (AI agent / advisor chat)
  │  HTTPS + Authorization: Bearer <token>
  ▼
[reverse proxy — TLS termination]
  │  HTTP, loopback
  ▼
createHttpHandler            src/mcp-tools/server.ts
  ├── authenticate()         → Principal { id, scopes, provider } or null
  │     ├── registry lookup  src/mcp-tools/consumers.ts  (sha256 token match)
  │     └── policy check     src/policy.ts  (is this backend authorized?)
  ├── 401 + throttle on failure  (>30/min/source → 429)
  ├── body size guard        (1 MiB)
  ▼
buildServer()  — a FRESH MCP Server + transport per request (stateless)
  ├── ListTools  → only tools within the principal's scopes
  └── CallTool
        ├── scope check
        ├── recordMcpCall()  src/mcp-tools/usage.ts   → analytics line
        └── tool.handler(args)
              ├── SQLite read (better-sqlite3, readonly)      ─ most tools
              └── execFile → core/scripts/query.py            ─ catalog tools
```

### Why stateless-per-request

`StreamableHTTPServerTransport` is instantiated per request rather than shared.
A shared stateless transport returns 500 on the post-initialize
`notifications/initialized` POST — found by integration test, documented in
`server.ts`. The cost is a small per-request allocation; the benefit is that no
request can corrupt another's transport state.

### Module map (32 TypeScript files, the full closure)

```
entry points        mcp-public.ts, mcp-catalog.ts
  transport/auth    mcp-tools/server.ts        HTTP handler, auth, scopes, stateless MCP
                    mcp-tools/consumers.ts     per-agent token registry (sha256; per-server file)
                    mcp-tools/permissions.ts   operation → policy action; scope expansion
                    policy.ts                  reads policy/action-policy.yaml; fail-closed
  tool barrels      mcp-tools/index-public.ts  side-effect imports that register public tools
                    mcp-tools/index-catalog.ts  … and catalog tools
  schedule tools    mcp-tools/clemson-classes.ts, clemson-schedule.ts, section-query.ts
                    clemson-schedule-db.ts     snapshot queries, conflict detection
                    clemson-classes.ts         Banner shapes
                    clemson-room-capacity.ts, term-resolve.ts, eastern-time.ts
  catalog tools     mcp-tools/catalog.ts       program plan, rules, gen-ed, audit, find-course
                    mcp-tools/clemson-advising.ts  requirement sections, program requirements
                    mcp-tools/gc-coreqs.ts, program-args.ts, gc-skill-renames.ts
                    gc-curriculum.ts           the Python CLI bridge (execFile, 15 s timeout)
                    advisor-catalog.ts         listPrograms() over the catalog DB
  cross-cutting     config.ts (all env), log.ts (rotating), state.ts, types.ts
                    mcp-tools/usage.ts   per-call usage ledger
                    mcp-tools/audit.ts   write-intent audit rows (unused by these read-only servers)
                    mcp-tools/skills.ts  skill-document tools
```

Plus **`core/`** — a Python package (the former `gc_advisor` project) providing
`query.py` (catalog lookups) and `audit.py` (degree audits), and the built
SQLite catalog database. The catalog server shells into it; the public server
does not depend on it at all.

### Data artifacts

| Artifact | Size | Origin | In git? |
|---|---|---|---|
| `core/db/gc_advisor.db` | 5.7 MB | built by `core/scripts/rebuild_db.sh` from the published catalog | no |
| `state/clemson/<term>.db` | ~3 MB × 7 terms = 21 MB | daily Banner refresh, 05:00 | no |

Total working set **~27 MB** — small enough that the OS page cache holds all of
it after the first read. This matters for the capacity section below.

---

## 4. Security model

**These servers hold no student data and no credentials.** They serve published
catalog and schedule information. That is the primary control, and it is
structural rather than procedural.

- **Authentication** — every request needs `Authorization: Bearer <token>`. Tokens
  are matched by constant-time comparison against a sha256 hash; the raw token is
  never stored. Each server has its **own registry file**, so a token minted for
  one is rejected by the other, and revoking one does not touch the other.
- **Fail-closed startup** — with zero configured consumers the server refuses to
  start rather than serving open (`resolveCredentialedAuth` throws).
- **Backend attestation** — each consumer declares the AI backend it runs on
  (`anthropic`, `openai_api`, `chatgpt_edu`). Policy declares which backends are
  authorized and **for which data classes**; these servers declare `dataClass:
  "public"`. A backend restricted to public data cannot authenticate against a
  student-data surface, and a server that fails to declare its class is refused
  outright.
- **Scopes** — a consumer may carry a scope list; `ListTools` and `CallTool` both
  filter by it, so a narrowly-scoped agent cannot even see tools outside its grant.
- **Abuse limits** — unauthenticated requests are logged (first, then every 100th
  per source per minute) and throttled to 429 above 30/min/source. Bodies over
  1 MiB are rejected.
- **Usage ledger** — every call appends one line to
  `state/analytics/mcp-calls.jsonl`: timestamp, server, consumer id, provider,
  tool. **No arguments, no results.**

**Known limitation, stated plainly:** `StreamableHTTPServerTransport` performs no
Host/Origin validation, so off-loopback the bearer token is the only gate. There
is no DNS-rebinding protection to enable. Any deployment beyond loopback must
treat token issuance and rotation as the primary control, which is why
per-consumer tokens (not one shared token) are mandatory in a multi-user
deployment.

---

## 5. Diagnosing problems

### First: is it the environment or the service?

Check broadly before narrowly. In order:

```bash
# 1. Is the process alive and did it start clean?
launchctl list | grep mcp
tail -5 ~/Library/Logs/cuassistant.mcp-{public,catalog}.err.log

# 2. Does it answer at all? (401 proves routing + listener are fine)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8766/    # expect 401

# 3. Does it answer authenticated?
curl -s -X POST http://127.0.0.1:8767/ \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Read the error code literally.** `ECONNREFUSED` means routing works and nothing
is listening — the process died. `EHOSTUNREACH` means the network path is broken
— do not debug the service. A `401` means the service is healthy and your token
is wrong. A `429` means you are being throttled, not broken.

### The startup line is the single most informative log

```
cuassistant-catalog http on 127.0.0.1:8767 — auth: registry (1 authorized consumer); tools: list-gc-catalog-years, …
```

It states the bind address, the auth mode, the consumer count, and **the exact
tool list**. If a tool you expect is missing from that line, the process is
running old code — see "silent staleness" below.

### Silent staleness — the most common failure

**The servers load their tool registry and policy ONCE at startup.** Editing
source or `action-policy.yaml` does *not* affect a running daemon; it keeps
serving the old build and the new tool simply never appears in `tools/list`.
There is no error. Any change to tools, permissions, or policy requires a
restart, and the restart is not optional:

```bash
launchctl kickstart -k gui/$(id -u)/com.cuassistant.mcp-public-http
launchctl kickstart -k gui/$(id -u)/com.cuassistant.mcp-catalog-http
```

Then verify against the startup line. Registry changes (minting/revoking tokens)
are the exception — the registry is re-read per request, so those take effect on
the next call.

### Symptom → cause table

| Symptom | Likely cause | Check |
|---|---|---|
| New tool absent from `tools/list` | daemon not restarted | startup line in `*.err.log` |
| All requests 401 | token mismatch, or consumer's provider not authorized in policy | `auth: rejecting "<id>" — provider …` in err.log |
| Server won't start, "no authorized consumers" | no token configured and empty registry — fail-closed working as designed | env token + registry file |
| Schedule answers are stale/empty | daily refresh failed; snapshot old | `get-schedule-freshness`, snapshot mtime |
| `totalCount=0` from Banner | keep-alive dropped the stickiness cookie | fixed 2026-08-12 (`Connection: close`); recheck if it returns |
| Catalog tool times out at 15 s | Python CLI hung or venv missing | run `core/scripts/query.py` by hand |
| Catalog tools fail, schedule tools fine | `core/` venv or DB missing | `ls core/db/gc_advisor.db core/.venv/bin/python` |
| Answers are wrong but confident | wrong store queried — see below | `find-course-in-program` |

### The "wrong store" class of bug (worth understanding)

A program's obligations live in **two** places: `requirement_rule` (named slots)
and `plan_item` (the semester plan). On 2026-08-27 an advisor asked "what is the
PCID requirement for GC students" and got "no such requirement exists" — the
model had queried only the rules store, received a *successful* response that
did not mention PCID, and inferred absence. `find-course-in-program` exists to
make this class of question answerable in one call across both stores, and the
other two tools' descriptions now state explicitly that a not-found from them
alone is not evidence of absence.

The general lesson for anyone extending these tools: **an empty successful result
is indistinguishable from "I asked the wrong question" unless the tool says which
ground it covered.** New tools should say what they searched.

### Observability

- `~/Library/Logs/cuassistant.mcp-{public,catalog}.log` — app log, rotates at
  10 MB × 5. `.err.log` holds startup/registration lines and crash output.
- `state/analytics/mcp-calls.jsonl` — per-call usage: who called what, when.
  Answer volume/attribution questions from here, not from logs.

---

## 6. Capacity planning

### Measured performance (2026-08-27, 16-core Apple Silicon, 64 GB)

Measured with an in-process Node load generator against the live servers. An
earlier `curl`-per-request harness reported far worse numbers — it was measuring
process spawn in the *test client*, not the server. These figures are the server.

**SQLite-backed tools** (most tools; in-process, no subprocess):

| Concurrency | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|
| 1 | 333 req/s | 2 ms | 5 ms | 7 ms |
| 10 | 1,063 req/s | 6 ms | 15 ms | 35 ms |
| 50 | 1,171 req/s | 34 ms | 58 ms | 136 ms |

**Python-shell-out tools** (`get-gc-program-plan`, `audit-gc-progress`, etc. —
each call spawns `query.py`):

| Concurrency | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|
| 1 | 31 req/s | 31 ms | 35 ms | 102 ms |
| 10 | 216 req/s | 42 ms | 55 ms | 78 ms |
| 25 | 267 req/s | 79 ms | 143 ms | 153 ms |

**The Python path is the binding constraint — roughly 4× slower than the SQLite
path — and the cost is process spawn, not query work.**

### Translating users into requests

From 138 real advising turns: **2.65 MCP tool calls per turn** (median 1, max 19).
Human advising is slow — an advisor reads a 7–33 s answer, thinks, then asks
again. One turn per user per 45–60 s is a realistic sustained rate.

```
200 concurrent users ÷ 50 s per turn × 2.65 calls  ≈  10.6 req/s
```

Against a measured ceiling of 267 req/s on the *slowest* path, that is **~4% of
capacity — a 25× margin.** For the 64-student class: ~3.4 req/s, about 1%.

**Conclusion: for human-driven use, these servers are not the bottleneck and
will not be.** Turn latency is dominated by LLM inference (median 7.1 s), of
which MCP calls are ~16 ms — roughly 0.2%. If the advising experience feels slow
with 200 users, the constraint is GPU inference capacity, not this service.

**The caveat that matters:** *agent* traffic is not human traffic. An autonomous
agent can fire 20–50 calls in a burst with no think time. 200 concurrent agents
behaving that way would reach the Python ceiling. Size for the workload you
actually expect, and watch `mcp-calls.jsonl` for the real shape.

### Recommended machine

| | Minimum | Recommended |
|---|---|---|
| vCPU | 4 | **8** |
| RAM | 8 GB | **16 GB** |
| Disk | 50 GB SSD | **100 GB NVMe** |
| OS | any Linux with Node 22 + Python 3.12+ | same |

Reasoning, dimension by dimension:

- **CPU is the only dimension that scales with load**, and only because of Python
  process spawn. Throughput on that path is roughly linear in cores; 8 vCPU
  should land near 130–270 req/s depending on clock — still >10× the projected
  200-user load.
- **RAM is nearly irrelevant.** The daemons use 31 MB and 49 MB resident; the
  entire data set is 27 MB and lives in page cache. 8 GB is generous; 16 GB is
  for the OS, the daily refresh job, and headroom, not for the servers.
- **Disk is for logs, backups, and snapshot growth** (~3 MB per term), not data.
  50 GB is already generous.
- **No GPU.** These servers do no inference.

### Hardware — what to actually buy or repurpose (2026-08-27)

These figures assume the planned port of the catalog reads to SQL-in-Node
(see the extraction spec, Decision 2). After it, every serving request is an
in-process SQLite read from a 27 MB page-cached dataset: no inference, no
subprocess spawn, negligible CPU.

**Spec floor: 2 cores, 4 GB RAM, 50 GB SSD.** (The earlier 8 vCPU / 16 GB
recommendation was sized against the Python-spawn ceiling; removing Python from
the serving path collapses the CPU requirement.)

Options, best first:

1. **A small VM from Clemson IT** — 2 vCPU / 4 GB / 50 GB. Usually free or
   near-free to a department, and it hands off patching, backup, uptime, static
   DNS, and the TLS certificate: the parts that actually make departmental
   infrastructure hard. Ask during the security review conversation.
2. **An old Mac mini (2018 Intel or any M-series).** Every plist, log path, and
   runbook already targets macOS/launchd, so there is no porting. **Requirement:
   it must run a currently-supported macOS** — an unsupported version is an
   IT-review finding, not a saving.
3. **Raspberry Pi 5, 8 GB (~$100).** ARM64 Node 22 and better-sqlite3 prebuilds
   both work; it would idle at single-digit CPU.
4. **Any x86 box, 2015+, 8 GB, SSD**, running Ubuntu LTS. Costs a port of the
   launchd plists to systemd units.

What matters more than the specs: an SSD (any), a static IP + DNS name for the
certificate, remote reboot, a UPS if it sits under a desk, and a supported OS.

**Why cheap hardware is defensible here:** the service is almost entirely
rebuildable. The catalog DB rebuilds from the published catalog; snapshots
re-fetch from Banner; code is in git. The only irreplaceable state is the
consumer token registry and `mcp-calls.jsonl` — both a few KB and both in the
nightly backup. Total hardware failure costs a restore and a rebuild measured in
hours, not data loss. Buy cheap, keep a spare.

**What would change this:** storing per-student state (saved plans, advisor
notes) raises reliability requirements *and* is the trigger to revisit Postgres.
Both arrive together; neither is on the roadmap.

### The single highest-leverage optimization

Replace the per-call Python spawn with either a **persistent worker process** or
**SQL-in-Node** (which is what `find-course-in-program` already does — hence its
2 ms p50 versus 31 ms). That alone would raise the binding ceiling roughly 4×
and remove the only real scaling risk in the system. It is not needed for 200
human users; it becomes worth doing if agent traffic grows or the audit engine
sees heavy use.

---

## 7. Deployment checklist

1. Node 22+, Python 3.12+, a provisioned `core/.venv`, a built
   `core/db/gc_advisor.db`, and at least one Banner snapshot.
2. Mint a token per consumer (`npm run mcp:pair -- --server <public|catalog>
   --id <agent> --provider <backend>`). Never share one token between consumers —
   that is what makes the usage ledger meaningless.
3. Bind both servers to loopback; terminate TLS in a reverse proxy in front.
4. Confirm each server's startup line shows the expected bind, consumer count,
   and tool list.
5. Schedule the daily schedule refresh and a health check.
6. Confirm `state/analytics/mcp-calls.jsonl` is being written and is included in
   backups — it is the only record of who used what.
