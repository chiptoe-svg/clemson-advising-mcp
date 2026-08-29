# Clemson Advising MCP Servers — background, architecture, and operations

**Status:** current as of 2026-08-28 · **Audience:** a maintainer or reviewer with
no prior exposure to this system, including Clemson IT security.

This document explains what these two servers are, why they exist, how they are
built, and how to diagnose them when they misbehave. It is written to be read
start to finish by someone who has never seen the code.

Three companion documents carry the detail you consult rather than read:
**`security.md`** (threat model, controls, known limitations),
**`operations.md`** (install, TLS, refresh, restart, backup), and
**`capacity.md`** (measurements and sizing).

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
| Tools | 11 | 12 |
| Holds student data | No | No |
| Holds credentials | No | No |

They are deliberately **two servers, not one**. They have different data
lifecycles (the schedule changes daily during registration; the catalog changes
once a year), different failure modes, and different credentials — so one can be
restarted, revoked, or taken down without touching the other.

### Tool inventory

**Public (8766)** — `list-clemson-terms`, `search-classes`, `get-course-details`,
`check-conflicts`, `find-conflict-free-schedule`, `find-alternatives`,
`get-schedule-freshness`, `get-sections-by-crn`, `resolve-crns`, `list-skills`,
`get-skill-docs`

**Catalog (8767)** — `list-gc-catalog-years`, `get-gc-program-plan`,
`get-gc-requirement-rules`, `get-gc-gen-ed`, `get-program-requirements`,
`find-requirement-sections`, `find-course-in-program`, `list-gc-programs`,
`get-gc-course`, `audit-gc-progress`, `list-gc-skills`, `get-gc-skill-docs`

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
  ├── authenticate()         → Principal { id, scopes } or null
  │     └── registry lookup  src/mcp-tools/consumers.ts  (sha256 token match)
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

### Module map (34 TypeScript files, the full closure)

```
entry points        mcp-public.ts, mcp-catalog.ts
  transport/auth    mcp-tools/server.ts        HTTP handler, auth, scopes, stateless MCP
                    mcp-tools/consumers.ts     per-agent token registry (sha256; per-server file)
                    mcp-tools/permissions.ts   operation → policy action; scope expansion
                    policy.ts                  reads policy/action-policy.yaml; fail-closed
  tool barrels      mcp-tools/index-public.ts  side-effect imports that register public tools
                    mcp-tools/index-catalog.ts  … and catalog tools
  schedule tools    mcp-tools/clemson-classes.ts, clemson-schedule.ts, section-query.ts
                    clemson-schedule-db.ts     snapshot queries, CRN lookup, conflict detection
                    clemson-classes.ts         Banner shapes
                    clemson-room-capacity.ts, term-resolve.ts, eastern-time.ts
  catalog tools     mcp-tools/catalog.ts       program plan, rules, gen-ed, audit, find-course
                    mcp-tools/clemson-advising.ts  requirement sections, program requirements
                    mcp-tools/gc-coreqs.ts, program-args.ts, gc-skill-renames.ts
                    gc-curriculum.ts           the Python CLI bridge (execFile, 15 s timeout)
                    catalog-read.ts            direct SQLite reads: programs, course entries
  cross-cutting     config-mcp.ts (all env), log.ts (rotating)
                    mcp-tools/usage.ts   per-call usage ledger
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
it after the first read. This matters for the throughput figures in `capacity.md`.

---

## 4. Security model

Full treatment, including the threat model and the known limitations, is in
**`security.md`**. The shape of it:

- **The primary control is structural.** These servers hold no student data and
  no credentials. They serve published catalog and schedule information, so a
  full compromise yields data that is public by definition.
- **Every request needs a bearer token**, matched by constant-time comparison
  against a sha256 hash. Each server has its **own registry file**, so a token
  minted for one is rejected by the other.
- **Fail-closed throughout** — no configured consumers means the server refuses
  to start; an authenticator that throws returns 503; one that hangs is timed
  out and denies; a malformed expiry is rejected.
- **Bounded** — unauthenticated requests throttle per client address,
  authenticated ones per credential, bodies over 1 MiB are refused.
- **Audited** — one ledger line per call: who, which tool, what outcome. No
  arguments and no results.

The limitation to know before reading further: `StreamableHTTPServerTransport`
performs no Host/Origin validation, so off loopback the bearer token is the only
gate. Per-consumer tokens are therefore mandatory in a multi-user deployment.

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
| All requests 401 | token mismatch — wrong server, revoked, or the shared token changed | `npm run mcp:pair -- --server <s> --list` |
| Server won't start, "no authorized consumers" | no token configured and empty registry — fail-closed working as designed | env token + registry file |
| Schedule answers are stale/empty | daily refresh failed; snapshot old | `get-schedule-freshness`, snapshot mtime |
| `totalCount=0` from Banner | keep-alive dropped the stickiness cookie | fixed 2026-08-12 (`Connection: close`); recheck if it returns |
| Catalog tool times out at 15 s | Python CLI hung or venv missing | run `core/scripts/query.py` by hand |
| Catalog tools fail, schedule tools fine | `core/` venv or DB missing | `ls core/db/gc_advisor.db core/.venv/bin/python` |
| Answers are wrong but confident | wrong store queried — see below | `find-course-in-program` |

### The recurring defect: silence read as absence

Five instances in one week, across two codebases. Worth stating as a design rule
because it keeps arriving in different disguises:

| Where | Silence | Reported as |
|---|---|---|
| `find-requirement-sections` (PCID) | one of two requirement stores had no row | "no such requirement exists" |
| `checkPrereqEligible` | a prereq rule that did not parse | "no prerequisite" / "not eligible" |
| core plan-next | a course absent from the student's plan | "unreachable" |
| a bare freshness timestamp | never crawled | "unchanged" |
| `findCoreqs` (latent) | malformed `coreq_parsed`, or an unreadable DB | "no corequisites" |

The shared root, as the core maintainer put it: **the data layer represents
presence well and the absence of knowledge not at all.** So every consumer has to
invent its own encoding for "I don't know", and the cheapest encoding — an empty
array, a false, a null — is indistinguishable from "no".

The rule that follows, and the one question to ask of any new field:

> **What does this return when we haven't looked?**

If the answer is the same value as "we looked and there is nothing", the field is
wrong. Give it a third state (`prereqEligible` is now
`eligible | not_eligible | undetermined`), or carry a note saying what ground was
covered (`find-course-in-program` states that both stores were searched, which is
what makes its `found: false` authoritative), or return an error. What is not
acceptable is a confident negative the data cannot support — that is worse than
no answer, because an advisor acts on it.

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

## 6. Capacity and operations

Both have their own documents, because both are things you consult while doing
something rather than while reading:

- **`capacity.md`** — measured throughput, the user-to-request arithmetic,
  sizing, and the thresholds that would change any of it. The headline: a
  measured ceiling of 968-1,171 req/s against a projected 10.6 req/s for 200
  users, so roughly a 90x margin. The caveat that matters is that agent traffic
  is not human traffic and the arithmetic assumes a human reading between calls.
- **`operations.md`** — install, configure, serve over TLS, keep the data fresh,
  restart, health, back up, and how this repository was extracted.

Two operational facts are worth stating here because they explain the design
above rather than merely following from it:

1. **The servers load their tool registry and policy once, at process start.**
   Editing source does not change a running server; it keeps serving the old
   build and the new tool simply never appears in `tools/list`. A restart is
   part of shipping a tool change, not an afterthought.
2. **Silent staleness is the most common failure** (see s5). Nothing breaks — the
   servers keep answering confidently from an old snapshot. The daily refresh
   job is what prevents it, and the `data as of` stamp on every schedule answer
   is what makes it visible.
