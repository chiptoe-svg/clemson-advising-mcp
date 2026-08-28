# Clemson Advising MCP Servers

Two [Model Context Protocol](https://modelcontextprotocol.io) servers that give
an AI assistant reliable access to Clemson course data:

- **Schedule server** — live class-schedule search against Clemson's public
  Banner system: sections, times, seats, conflicts, alternatives.
- **Catalog server** — College of Business curriculum: program plans,
  requirement rules, general-education categories, and a deterministic degree
  audit.

Both are read-only. Both serve **published** Clemson data. Neither holds student
records, credentials, or any write path into a system of record.

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

## Why this repository is public

It is published **to be read**, primarily by Clemson IT security. It is not
published for reuse: see `LICENSE`, which grants no rights to use, modify, or
redistribute. GitHub will report "no open-source license", which is accurate and
intended.

If you are here to review it, start with **`docs/security.md`** — it states what
the servers hold, what defeating each control gains an attacker, and, in its own
section, the limitations we know about and have not fixed.

---

## Documentation

|                            |                                                                |
| -------------------------- | -------------------------------------------------------------- |
| `docs/architecture.md`     | How it works, module by module, and how to diagnose it         |
| `docs/security.md`         | Threat model, authentication, authorization, known limitations |
| `docs/operations.md`       | Install, configure, serve over TLS, refresh, restart, back up  |
| `docs/capacity.md`         | Measured throughput, sizing, and what would change it          |
| `deploy/Caddyfile.example` | Working reverse-proxy configuration for campus TLS             |

---

## Quick start

```bash
npm ci
npm run typecheck
npm test                      # expect 0 fail, 0 skipped

npm run mcp:pair -- --server public --id my-agent --provider clemson_hosted
MCP_TRANSPORT=http npm run mcp:public:http
```

Two data artifacts are not in git — a curriculum database and Banner schedule
snapshots. `docs/operations.md` §1 explains where each comes from. Without them
the suite reports a large **skipped** count rather than failing, so check the
count and not just the colour.

To run it as a service rather than a terminal process:

```bash
cp deploy/env.example .env    # then fill it in
bash deploy/install.sh        # launchd services + preflight + verification
npm run mcp:health            # exit 0 healthy, 1 degraded, 2 down
```

`docs/operations.md` §4b is the full path for a fresh machine, including the
reverse proxy that terminates TLS.

## Layout

```
src/mcp-public.ts, src/mcp-catalog.ts   the two entry points
src/mcp-tools/                          transport, auth, policy, the tools
src/policy.ts, policy/                  authorized backends and data classes
core/                                   Python catalog pipeline — BUILD TIME ONLY
test/                                   the suite; no test is allowed to skip
deploy/                                 reverse-proxy configuration
```

`core/` is the only Python in the project and never runs on a request path. A
serving host needs Node and a prebuilt database; it does not need Python at all.

## History

The TypeScript history is preserved. `core/` was imported fresh, without its
former project's lineage. The extraction ran a blocking audit over all published
history for private files, credentials, student identifiers, and personal data —
`docs/operations.md` §8 describes what it checks and what it caught.
