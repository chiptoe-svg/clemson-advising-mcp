# Security model

Companion to `architecture.md` (what the system is) and `operations.md` (how to
run it). This document is written for a security reviewer: it states what the
servers hold, what an attacker gains by defeating each control, and — in a
separate section — the limitations we know about and have not fixed.

---

## 1. The primary control is structural: there is nothing here to steal

**These servers hold no student data and no credentials.** They serve Clemson's
published class schedule and the College of Business published curriculum —
information already on Clemson's public web pages. A full compromise of this
service yields data that is public by definition, plus the consumer token
registry (hashes, not tokens), a usage ledger, and the one reference file
described below.

**The one input that is not published: room capacities.**
`data/clemson-room-capacity.json` maps 435 `building|room` keys to a seat count
(9–600). It came from a **CuSectionOverview export, Fall 2026 (202608), taken by
hand on 2026-07-21** — a report behind Clemson SSO, not a public page. Banner's
public feed carries no room capacity at all, which is why it exists.

It is named here rather than left implicit, because "everything in this
repository is already published" is the claim the rest of this document rests
on, and this file is the exception. What it contains is seat counts for rooms:
no names, no identifiers, no enrolment, no schedule — verified before it was
committed. What it costs an attacker who obtains it is knowledge of how many
seats are in Daniel 415. It is committed rather than kept in `state/` because
the nightly refresh rebuilds everything in `state/` and cannot rebuild this: if
it is lost it needs another manual export from behind SSO.

Two operational notes. No tool currently returns this field to a caller — it is
computed onto meeting records and dropped before serialisation — so today it
affects nothing a client sees. And it is a point-in-time snapshot: a renovated
or re-measured room goes quietly stale, so it is a planning aid and never an
authority. An unknown room yields `null`, never `0`, because `0` would read as
"this room seats nobody" rather than "we do not know".

That is the control that does the most work, and it is worth stating before the
authentication details, because every control below is defence for a low-value
target rather than the last line before something sensitive. **Read the rest of
this document with that in mind: the controls exist to bound abuse and to
attribute usage, not to protect confidential data, because there is none here.**

**What passes through without being stored — the FERPA question, answered.**
Tool arguments are course codes, term codes, CRNs, program names, and lists of
completed course codes a caller may send to filter by prerequisite eligibility.
That last one is the most student-shaped input the servers accept, so to be
exact about it: it arrives with **no identity** — no name, no C-ID, no term of
enrolment, nothing that ties the list to a person — because the client strips
identity before it calls, and the servers have no field to receive it. It
crosses the wire under TLS, is used to filter one query, and is never written
down: the usage ledger records no arguments (§6), the application log records
none, and there is no student-record storage of any kind. Nothing here is an
education record; the servers could not reconstruct one from what they see.

**What is deliberately NOT here:**

|                                                  | Where it lives instead                               |
| ------------------------------------------------ | ---------------------------------------------------- |
| Mail, calendar, tasks, any Microsoft Graph token | A separate private repository and a separate server  |
| Student records, grades, DegreeWorks derivatives | Never in this repo; excluded by the extraction audit |
| LLM API keys, the advisor, the chat UI           | The advisor's own repository                         |
| Any write path to a Clemson system of record     | Does not exist — every tool is read-only             |
| Anything else sourced from behind Clemson SSO    | Only the room-capacity file above, and it is named   |

The extraction that produced this repository ran a blocking audit over the full
published history for exactly these categories. See `operations.md`,
"How this repository was extracted".

---

## 2. Authentication

Every request needs `Authorization: Bearer <token>`. There is no anonymous
surface and no read-only public mode.

- **Per-consumer tokens.** Each caller gets its own token, minted with
  `npm run mcp:pair`. The raw token is printed once and never stored — only a
  sha256 hash goes to disk, compared in constant time. Losing a token means
  minting a new one, which is the intended failure mode.
- **Separate registries per server.** The schedule server and the catalog server
  each read their own registry file. A token minted for one is rejected by the
  other, and revoking one has no effect on the other. This is verified over TLS
  as part of deployment (`operations.md`).
- **Fail-closed startup.** With zero configured consumers the server refuses to
  start rather than serving open. There is no configuration that yields an
  unauthenticated listener.
- **Fail-closed authentication.** An authenticator that throws returns 503, never 200. One that hangs is raced against a 10-second timeout and denies. A
  credential whose expiry is absent is treated as non-expiring; one whose expiry
  is not a finite future number — including `NaN`, which is what a malformed
  OAuth claim most often produces — is rejected.
- **Revocation takes effect on the next request.** The registry is re-read per
  request; no restart is needed to revoke.

**Roadmap, and why the shape already accommodates it.** Static bearer tokens
identify software, not people. The expected direction is an OAuth/OIDC
credential from a Clemson identity provider. The authenticator interface is
already async, receives the full request context rather than just the header,
separates subject (a person) from client (an agent), enforces expiry centrally
so a new scheme cannot forget it, and chains so two schemes can run during a
migration. 401s carry `WWW-Authenticate`, which is how an OAuth client discovers
where to authenticate. These seams are pinned by tests
(`test/mcp-auth-future.test.ts`) so a refactor cannot quietly remove them.

---

## 3. Authorization

Authentication answers _who_; these answer _what they may reach_.

- **Scopes.** A consumer may carry a scope list. Both `tools/list` and
  `tools/call` filter by it, so a narrowly-scoped agent cannot see, let alone
  call, tools outside its grant.

There is no per-consumer restriction on _what the caller does with the data_:
everything served is already published by Clemson, so the servers do not ask a
consumer which AI vendor, if any, sits behind it. Scopes exist to keep an
integration to the tools it needs, not to classify data.

---

## 4. Abuse and resource limits

| Limit                        | Value                           | Keyed on                            |
| ---------------------------- | ------------------------------- | ----------------------------------- |
| Unauthenticated requests     | 30/min → 429 with `Retry-After` | Client address                      |
| Authenticated requests       | 600/min → 429                   | The **credential**, not the address |
| Request body                 | 1 MiB → rejected                | —                                   |
| Authenticator latency        | 10 s → deny                     | —                                   |
| Unauthorized-request logging | First hit, then every 100th     | Client address                      |

The authenticated limit is keyed on the credential deliberately. Keying it on
the address would let one leaked token spread across hosts to evade it, and
would let many legitimate agents behind one NAT throttle each other.

The log-sampling rule exists because the naive version — one stderr line per
unauthenticated request — measured **1.4 GB/day at 215 req/s** into a
never-rotated file. A log that fills a disk is an availability defect.

---

## 5. Transport

The servers speak plain HTTP and bind to **loopback**. Each has its own bind
variable defaulting to `127.0.0.1`, so no server can inherit an off-loopback
bind from another. Campus exposure is a reverse proxy in front that terminates
TLS (`deploy/Caddyfile.example`).

The servers have no TLS of their own and should not grow any: certificate
renewal, cipher policy, and HTTP/2 are what a proxy does well.

**Client attribution behind the proxy.** Behind a proxy every request arrives
from the proxy's address, which erases the caller. The servers read the real
client from `X-Forwarded-For`, but only when the connection came from a
configured trusted proxy (`MCP_TRUSTED_PROXIES`, loopback by default), and take
the rightmost hop — the address the nearest proxy actually observed. Entries to
its left are whatever the client sent and are treated as evidence of nothing.
Without the trust check any client could forge an identity into the audit log
and escape the per-source throttle by rotating a header.

### What leaves this machine

A reviewer's first question about any campus service. There are exactly three
outbound destinations, all Clemson-operated or Clemson-published, and none of
them carries anything about a caller.

| Destination                                        | When                                                                                                                                                                            | What is sent                                                                                                                                   | What comes back             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `regssb.sis.clemson.edu` (Banner "Browse Classes") | Daily at 05:00 for the snapshot refresh; and per request for the three tools that read live (`list-clemson-terms`, `get-course-details`, `search-classes` with `refresh: true`) | A term code and search filters — subject, course number, instructor, days. No caller identity, no token, no cookie beyond Banner's own session | Public section data         |
| `catalog.clemson.edu`                              | Only during a catalog rebuild, about once a year, on whatever machine runs it                                                                                                   | Page requests                                                                                                                                  | Published catalog pages     |
| A Clemson-hosted LLM endpoint                      | Only during a catalog rebuild                                                                                                                                                   | The text of published catalog pages, for requirement extraction                                                                                | Structured requirement JSON |

Nothing leaves during ordinary serving except the Banner reads above. The two
rebuild destinations are not reachable from a serving host at all: no request
path can trigger a rebuild.

**The refresh job is deliberately gentle with Banner**, because it is someone
else's production system: one sweep per live term, pages of 500 sections capped
at 40 pages, 200–400 ms between requests, 1 s between terms, at most three
attempts per term, `Connection: close` per request, and a partial scan is
discarded rather than written. It runs once a day.

**A caller can drive Banner reads.** `search-classes` with `refresh: true` and
`get-course-details` reach Banner on the request path, so an authenticated
consumer at its 600/min ceiling could put that many requests through to Banner.
That ceiling is the bound; if Banner's operators want a lower one, it is a
one-line change (`MCP_CONSUMER_RATE_LIMIT`).

---

## 6. Audit

Every call appends one line to `state/analytics/mcp-calls.jsonl`: timestamp,
server, consumer id, auth method, outcome, tool name.

**No arguments and no results are recorded.** This is a deliberate trade. It
means the ledger cannot reconstruct what anyone asked about — no course, no
program, no search term — and it also means the ledger cannot help investigate
what a compromised token was used to look up. Given the data is public, the
privacy side wins.

Refused calls are recorded too, with an `outcome` field, so an unknown-tool
probe or an out-of-scope attempt leaves a trace rather than vanishing. A
caller-supplied tool name is truncated at 128 characters before it is recorded:
the unknown-tool path is the one place a caller controls what is written, and an
append-only file is not a place to let it write freely.

The ledger does **not** record client IP addresses. The information is now
available (§5) but recording it is a privacy decision that has not been taken;
the 401 warnings in the application log carry the address for abuse
investigation, and they rotate.

---

## 6b. The surface is not only tools

Two other things reach a client, and both are part of what a reviewer should
consider published:

- **Server instructions** (`src/mcp-tools/instructions.ts`) — a text preamble
  returned during `initialize`, describing what the server is for.
- **Skill documents** — Markdown under `skills/` (schedule server) and
  `core/skills/` (catalog server), served by `list-skills`/`get-skill-docs` and
  their catalog equivalents. They are advising guidance for a model: which tool
  to reach for, in what order, and where the data is known to mislead.

Exposure is an **allowlist per server, not a denylist**: the schedule server
serves exactly one document, the catalog server nine (the advising method,
catalog usage, and one policy document per department), and anything else
in those directories — including a file added tomorrow — is refused until
someone opts it in by name. A refusal names the document rather than pretending
it does not exist, so a client can tell "not exposed to me" from "nothing
there". `list-skills` returns `{ name, description }` per document; clients
index on that shape.

These documents contain no credentials and no student data, but they are the
part of the surface most likely to go stale, because they describe tools rather
than being generated from them. That is a correctness risk, not a security one:
a document naming a tool the server no longer serves sends a model at a
non-existent tool. It happened on 2026-08-28 and is why the tool inventory in
`architecture.md` and these documents are checked together.

---

## 7. Known limitations — stated plainly

An honest list matters more here than a clean one.

**7.1 No Host/Origin validation.** The servers validate neither header, so off
loopback the bearer token is the only gate.

Be precise about what the SDK offers, because a reviewer will open it. The
transport in use — `StreamableHTTPServerTransport` from
`@modelcontextprotocol/sdk/server/streamableHttp.js`, SDK 1.30.0 — has no
Host/Origin options at all. The SDK's _other_ HTTP transport
(`webStandardStreamableHttp`, built on Web-standard `Request`/`Response`) does
expose `allowedHosts`, `allowedOrigins`, and `enableDnsRebindingProtection`.
Switching transports, or adding a Host allow-list to `createHttpHandler`, is
possible and has not been done: on a loopback bind with a proxy in front, a
rebound browser request still needs a bearer token it cannot obtain. It is
listed here because "there is nothing to enable" would be wrong, and because a
deployment that ever binds off loopback should do one of the two.

Any deployment beyond loopback must treat token issuance and rotation as the
primary control — which is why per-consumer tokens, not one shared token, are
mandatory in a multi-user deployment.

**7.2 A shared environment token still exists.** Alongside the per-consumer
registry, each server accepts one token from its environment. It is the
migration path, and it is attributed in the ledger as `env-token`, so its
traffic is distinguishable from any paired consumer's. It should be retired once
every real caller holds its own token.

**7.3 No mutual TLS and no client certificates.** Access control is the bearer
token plus whatever the network provides. On a campus network whose edge blocks
public inbound, that is the actual perimeter, and it is worth confirming rather
than assuming that this is still true of the network you deploy onto.

**7.4 An unmapped proxy path can reach the wrong application.** Observed
2026-08-28: a client posting to a misspelled MCP path fell through a proxy's
catch-all to a different local application, which answered "Authentication
required." — an auth error from the wrong service, indistinguishable from the
right one. The mitigation is in the shipped proxy config: an explicit 404 for
unmapped paths. It is a configuration hazard rather than a code defect, and it
is the kind that stays invisible.

**7.5 The dependencies.** Three runtime packages: the MCP SDK, `better-sqlite3`,
and a YAML parser. Node 22+. Python 3.12+ exists only to build the catalog
database; no request ever spawns it. There is no web framework, no ORM, and no
authentication library.

---

## 8. Ownership and maintenance

The answers to the five questions every review asks, so they are on the page
rather than in a meeting.

|                        |                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner and operator** | Chip Tonkin, College of Business. Sole maintainer; a backup operator is named in the deployment's own records, not here                                                                                                                                                                                                                                                                               |
| **Contact**            | Open an issue on the repository, or use GitHub's private vulnerability reporting for anything security-shaped. Expect a reply within one business day; a confirmed security issue is fixed before any other work                                                                                                                                                                                      |
| **Where it runs**      | `operations.md` §4b, "The current deployment" — a single campus-connected machine, servers on loopback, TLS at the proxy                                                                                                                                                                                                                                                                              |
| **Update cadence**     | Node LTS and the three runtime dependencies are checked monthly and on any advisory; `npm audit` runs in CI on every push and gitleaks scans every push and weekly. The catalog rebuild is annual; the schedule refresh is nightly                                                                                                                                                                    |
| **Data retention**     | Schedule snapshots: overwritten nightly, current terms only. The usage ledger (`state/analytics/mcp-calls.jsonl`) holds tool names and consumer ids, no arguments and no addresses, and is kept indefinitely because it is the only record of use; it grows ~150 bytes per call. Application logs rotate at 10 MB × 5. Consumer registries hold token hashes and are kept until a consumer is revoked |
| **Decommissioning**    | `bash deploy/install.sh --uninstall` removes the services and leaves the data; deleting `state/` and `.env` removes every credential and every record this service ever held                                                                                                                                                                                                                          |

---

## 9. What to look at first, if you are reviewing this

1. `src/mcp-tools/server.ts` — transport, authentication, expiry, rate limits.
   Everything in §2, §4, and §5 is here.
2. `src/policy.ts` and `policy/action-policy.yaml` — §3, and the fail-closed
   behaviour described there.
3. `src/mcp-tools/consumers.ts` — token hashing, registry storage, atomic writes.
4. `test/mcp-auth-future.test.ts`, `test/mcp-client-source.test.ts`,
   `test/mcp-public-catalog-auth.test.ts` — the tests that pin the claims above.
   Each was demonstrated to fail with its fix reverted; a test that has never
   been shown red is not evidence.
5. `docs/operations.md` — the deployment steps that these controls assume.
