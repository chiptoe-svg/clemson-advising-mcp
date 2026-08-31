# Clemson Advising MCP Servers

Two [Model Context Protocol](https://modelcontextprotocol.io) servers that give
an AI assistant reliable access to Clemson course data:

- **Schedule server** (port 8766) — class-schedule search over Clemson's public
  Banner system: sections, meeting times, seats, conflicts, alternatives.
- **Catalog server** (port 8767) — College of Business curriculum: program
  plans, requirement rules, General Education categories, course entries.

Both are read-only. Both serve **published** Clemson data. Neither holds student
records, credentials, or any write path into a system of record.

## At a glance

|                         |                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **What data**           | Clemson's published class schedule and published College of Business curriculum, plus one non-published reference file of room seat counts (`docs/security.md` §1) |
| **Where it comes from** | Banner (`regssb.sis.clemson.edu`) daily; the online catalog (`catalog.clemson.edu`) annually                                                                       |
| **Who can reach it**    | Callers holding a bearer token this deployment issued — there is no anonymous access                                                                               |
| **How**                 | HTTPS to a reverse proxy on campus, which forwards to loopback-only servers                                                                                        |
| **What it never holds** | Student records, grades, DegreeWorks data, mail, LLM keys, any credential but its own consumer tokens                                                              |
| **Where it runs**       | One small machine; see `docs/capacity.md` for why cheap hardware is defensible                                                                                     |

---

## Why this exists

An advisor asking "can this student take BUS 3120 next spring?" needs the
catalog requirement, the prerequisite chain, and whether a section actually
exists at a time that fits. A language model asked that question without tools
will produce a fluent, plausible, and frequently wrong answer. These servers
make each of those three facts a deterministic lookup instead.

The design rule that follows from that, and the one worth knowing before reading
any code here: **a tool must never let silence read as absence.** A lookup that
found nothing because it did not look must say so — not return an empty list
that a model will report as "there is no such requirement." Several tools carry
explicit three-state answers for exactly this reason. See `docs/architecture.md`.

---

## Why this repository is written to be read

It exists to be reviewed, primarily by Clemson IT security, and it is written
for that reader rather than for reuse: see `LICENSE`, which grants no rights to
use, modify, or redistribute. Where it is published, GitHub will report "no
open-source license", which is accurate and intended.

**Everything these servers serve is already public.** That is the first fact to
hold onto, because it explains the shape of everything else: the bearer tokens,
the loopback bind, and the rate limits exist to control **abuse and attribute
usage**, not to protect data. There is no confidential data here to protect.

**Reading order for a reviewer**, about twenty minutes:

1. **`docs/security.md`** — what the servers hold, what defeating each control
   would gain an attacker, what leaves this machine, and a section of known
   limitations we have not fixed.
2. **`docs/overview.md`** — how the data gets from Clemson's published sources
   into two databases and out through the servers, and what every tool does.
3. `src/mcp-tools/server.ts` — transport, authentication, rate limits: one file.

Who owns it, how to reach them, and how it is maintained: `docs/security.md`
§8.

`docs/operations.md` and `docs/capacity.md` are references you consult while
doing something, not documents to read front to back.

---

## Documentation

|                                                                                                   |                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `docs/security.md`                                                                                | Threat model, authentication, what leaves the machine, known limitations                              |
| `docs/overview.md`                                                                                | The data from source to answer, and every tool described                                              |
| [chiptoe-svg.github.io/clemson-advising-mcp](https://chiptoe-svg.github.io/clemson-advising-mcp/) | The same overview as a web page — what the servers provide, where the data comes from, and every tool |
| `docs/architecture.md`                                                                            | How it works, module by module, and how to diagnose it                                                |
| `docs/operations.md`                                                                              | Install, configure, serve over TLS, refresh, restart, back up                                         |
| `docs/capacity.md`                                                                                | Measured throughput, sizing, and what would change it                                                 |
| `deploy/Caddyfile.example`                                                                        | Working reverse-proxy configuration for campus TLS                                                    |
| `docs/clemson-it-data-api-request.md`                                                             | What we read from Clemson systems today, and the supported access we are asking for                   |

---

## Quick start

```bash
npm ci
npm run typecheck
npm test

npm run mcp:pair -- --server public --id my-agent
MCP_TRANSPORT=http npm run mcp:schedule:http
```

Two data artifacts are not in git — the curriculum database and the Banner
schedule snapshots (`docs/operations.md` §1 explains where each comes from).
Without them the suite **skips** the tests that need them, each with a stated
reason, and reports the count. `npm run test:gate` sets `REQUIRE_ARTIFACTS=1`,
which turns those skips into failures; that is the gate a release passes, and it
must report **0 failed and 0 skipped**. A skip count is how a missing artifact
hides behind a green run.

To run it as a service rather than a terminal process:

```bash
cp deploy/env.example .env    # then fill it in
bash deploy/install.sh        # preflight + launchd services + verification
npm run mcp:health            # exit 0 healthy, 1 degraded, 2 down
```

`docs/operations.md` §4b is the full path for a fresh machine, including the
reverse proxy that terminates TLS.

## Layout

```
src/mcp-schedule.ts, src/mcp-catalog.ts   the two entry points
src/mcp-tools/                          transport, auth, policy check, the tools
src/policy.ts, policy/                  the action allow-list every tool is checked against
skills/, core/skills/                   documents served to clients by the skill tools
scripts/                                refresh, token pairing, health check
core/                                   the catalog builder — see core/README.md
test/                                   the suite
deploy/                                 launchd services, reverse-proxy config, env template
state/                                  runtime data: snapshots, registries, usage ledger (not in git)
```

`core/` is the only Python in the project, and **no request ever runs it**. It
builds the catalog database; the servers then read that database in-process.
Travelling with it are 6,057 scraped catalog pages across nine catalog years and
326 cached model extractions, so this repository can rebuild its own database
rather than depending on another machine to produce one. Serving needs only
Node, SQLite, and a built database.

## Glossary

|                  |                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Banner**       | Clemson's student-information system. Its public "Browse Classes" search is where schedule data comes from.                                                                                                                                       |
| **GC**           | Graphic Communications, the Clemson department this began with. It survives in tool names (`get-gc-program-plan`) and in the catalog database's filename. The catalog now covers seven College of Business programs plus minors and certificates. |
| **The advisor**  | A separate, private application that is a _client_ of these servers. It holds the chat interface, the LLM keys, and student-facing state. None of it is in this repository.                                                                       |
| **`gc_advisor`** | The name of the Python package under `core/`; the database it builds is now `core/db/catalog.db` (renamed 2026-08-30). Historical; unrelated to the human advisors who use the system.                                                            |
| **Consumer**     | A caller holding a bearer token this deployment issued — an agent or an application, not a person.                                                                                                                                                |

## History

The TypeScript history is preserved from the private repository this was split
out of, where these servers ran inside the advisor application. `core/` was
imported fresh, without its former project's lineage. The extraction ran a
blocking audit over all published history for private files, credentials,
student identifiers, and personal data — `docs/operations.md` §8 describes what
it checks and what it caught. One name from that history survives on the wire:
the `cuassistant/` prefix on the `_meta` keys every result carries
(`cuassistant/skillsVersion`, `cuassistant/category`). Clients key on those
strings, so they stay until every client is updated together.
