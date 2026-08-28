# Capacity and sizing

Companion to `architecture.md`. Every number here was measured on this system,
not estimated. Where a figure is a projection it says so.

**The short version:** for human-driven advising, these servers are not the
bottleneck and will not become one. The measured ceiling is roughly 90× the
projected load for 200 users. The interesting question is not whether they can
keep up; it is what changes that answer.

---

## 1. Measured throughput

Measured 2026-08-27 on a 16-core Apple Silicon machine with 64 GB, using an
in-process Node load generator against the live servers.

> A methodological note that cost real time: an earlier harness spawned `curl`
> per request and reported far worse numbers. It was measuring process spawn in
> the *test client*. If you re-measure, keep the generator in-process.

**Schedule tools** (SQLite-backed, in-process, no subprocess):

| Concurrency | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|
| 1 | 333 req/s | 2 ms | 5 ms | 7 ms |
| 10 | 1,063 req/s | 6 ms | 15 ms | 35 ms |
| 50 | 1,171 req/s | 34 ms | 58 ms | 136 ms |

**Catalog tools, before the SQL-in-Node port** (each call spawned `query.py`):

| Concurrency | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|
| 1 | 31 req/s | 31 ms | 35 ms | 102 ms |
| 10 | 216 req/s | 42 ms | 55 ms | 78 ms |
| 25 | 267 req/s | 79 ms | 143 ms | 153 ms |

**Catalog tools, after the port** (same box, same generator, `get-gc-program-plan`):

| Concurrency | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|
| 1 | **429 req/s** (13.8×) | **2 ms** | 3 ms | 5 ms |
| 10 | 841 req/s | 7 ms | 27 ms | 58 ms |
| 25 | **968 req/s** (3.6×) | 19 ms | 39 ms | 60 ms |

The binding constraint is gone. Catalog reads now perform like schedule reads
because they are now the same kind of work: an in-process read of a page-cached
SQLite file. Confirmed by counting `query.py` spawns during sustained traffic —
zero at baseline, zero under load.

**Adding TLS** (2026-08-28, real MCP client through the campus reverse proxy):
`initialize` completed in 55 ms and a `tools/call` round-trip in 12–19 ms
against the catalog. The proxy hop is not a factor at this scale.

One tool keeps the old profile: `audit-gc-progress` still shells out to Python.
It was called **0 times in 366 real tool calls**. If that changes, make it a
persistent worker rather than porting a 439-line golden-tested engine.

---

## 2. Translating users into requests

From 138 real advising turns: **2.65 tool calls per turn** (median 1, max 19).
Human advising is slow — an advisor reads a 7–33 s answer, thinks, then asks
again. One turn per user per 45–60 s is a realistic sustained rate.

```
200 concurrent users ÷ 50 s per turn × 2.65 calls  ≈  10.6 req/s
```

Against 968 req/s on the catalog path and 1,171 req/s on the schedule path, that
is **about 1% of capacity**. For a 64-student class: ~3.4 req/s, about 0.35%.

Turn latency is dominated by LLM inference (median 7.1 s), of which MCP calls
are roughly 16 ms — about 0.2%. **If advising feels slow with 200 users, the
constraint is inference capacity, not this service.**

### The caveat that actually matters

*Agent* traffic is not human traffic. An autonomous agent fires 20–50 calls in a
burst with no think time. The arithmetic above assumes a human reading between
calls, and it does not survive contact with a fleet of agents.

Two things follow. Size for the traffic you expect rather than the traffic in
the table, and watch `state/analytics/mcp-calls.jsonl` for the real shape — it
is per-consumer, so a single agent's burst is visible as its own line rather
than lost in an aggregate. The per-consumer rate limit (600/min) is what bounds
the damage in the meantime.

---

## 3. Sizing

**Floor: 2 cores, 4 GB RAM, 50 GB SSD.**

An earlier recommendation of 8 vCPU / 16 GB was sized against the Python-spawn
ceiling. Removing Python from the serving path collapsed the CPU requirement,
and the recommendation with it. That is the honest history of this number.

Dimension by dimension:

- **CPU** is the only dimension that scaled with load, and only because of
  process spawn. With that gone, request handling is an in-process SQLite read.
- **RAM is nearly irrelevant.** The daemons measure 31 MB and 49 MB resident;
  the entire serving dataset is 27 MB and lives in page cache.
- **Disk is for logs, backups, and snapshot growth** (~3 MB per term), not data.
- **No GPU.** These servers do no inference of any kind.

### What to actually run it on

1. **A small VM from campus IT** — 2 vCPU / 4 GB / 50 GB. Usually free or
   near-free to a department, and it hands off patching, backup, uptime, static
   DNS, and the TLS certificate: the parts that make departmental infrastructure
   hard. Worth asking for during the security review conversation.
2. **A Mac mini, any M-series or 2018 Intel.** Every plist, log path, and runbook
   already targets macOS/launchd, so there is no porting. **It must run a
   currently-supported macOS** — an unsupported version is a review finding, not
   a saving. This is the confirmed target for the first deployment.
3. **Raspberry Pi 5, 8 GB.** ARM64 Node 22 and `better-sqlite3` prebuilds both
   work; it would idle in single-digit CPU.
4. **Any x86 box from 2015 on, 8 GB, SSD**, on Ubuntu LTS — at the cost of
   porting the launchd plists to systemd units.

What matters more than the specifications: an SSD, a static IP and DNS name for
the certificate, remote reboot, a UPS if it sits under a desk, and a supported
OS.

**Why cheap hardware is defensible here.** The service is almost entirely
rebuildable: the catalog DB rebuilds from the published catalog, snapshots
re-fetch from Banner, code is in git. The only irreplaceable state is the
consumer registry and the usage ledger — a few KB each, both in the nightly
backup. Total hardware failure costs a restore and a rebuild measured in hours,
not data loss. Buy cheap and keep a spare.

---

## 4. When to revisit any of this

Each of these is a threshold, not a worry:

| Signal | What it changes |
|---|---|
| Sustained agent traffic in the ledger, not human traffic | Re-measure; §2's arithmetic no longer applies |
| `audit-gc-progress` becomes hot | Make it a persistent worker |
| Per-student state with concurrent writes (saved plans, advisor notes) | Raises reliability requirements *and* triggers the SQLite-vs-Postgres question. Both arrive together |
| The dataset outgrows RAM | The page-cache assumption underneath every number here |

None are on the roadmap. All would be visible in the ledger or the data
directory before they were felt as a problem.
