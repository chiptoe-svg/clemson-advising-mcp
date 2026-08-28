# CUassistant MCP servers — IT review manifest

This is the human-readable companion to the MCP entry points
(`src/mcp-public.ts`, `src/mcp-catalog.ts`). It enumerates the MCP operation
surface across the two public-data servers, what backend each operation uses, what
permission it requires, and whether the tool is exposed to the agent.

## Two servers, both public-data

This repo serves two MCP servers. Both expose **public** Clemson data; neither
holds a delegated credential of any kind.

### `cuassistant-credentialed` (8765) — not in this repo

As of 2026-08-24 the credentialed server (private Exchange/MS365 + Google
Workspace tools, send-approval gate, per-agent token registry) lives in the
private `github.com/chiptoe-svg/mailcal` repo, in its own checkout on this
machine. It is not part of this project, and it never loads the public or
catalog tool indexes. The NanoClaw wiring runbook
(`docs/nanoclaw-integration-handoff.md`) moved with it. The only trace left
here is a guard: `src/advisor-mcp.ts` refuses to let the advisor dial port
8765 even if the environment tells it to.

### `cuassistant-public` / `cuassistant-catalog` (public DATA, bearer required)

- **What.** 8766 serves the Clemson class-schedule tools (public Banner Browse
  Classes API); 8767 serves the College of Business curriculum / degree-plan /
  audit tools, bridged from `core/` in this repo (the Python catalog + audit
  core, merged 2026-08-25). The DATA is public; access to the servers is not.
  Nine tools each — see the generated table below.
- **Transports.** Dual.
  - **Streamable HTTP** — `npm run mcp:public:http` / `npm run mcp:catalog:http`
    (`MCP_TRANSPORT=http`). Bind
    `${MCP_PUBLIC_HTTP_HOST:-127.0.0.1}:${MCP_PUBLIC_HTTP_PORT:-8766}` and
    `${MCP_CATALOG_HTTP_HOST:-127.0.0.1}:${MCP_CATALOG_HTTP_PORT:-8767}`.
    launchd services run both as host daemons.
  - **stdio** — `npm run mcp:public` / `npm run mcp:catalog`. Local/dev only.
- **Inbound auth — the env token IS the credential.** One bearer per server:
  `MCP_PUBLIC_AUTH_TOKEN` and `MCP_CATALOG_AUTH_TOKEN`, in the gitignored
  `.env`. Each server's consumer source is EMPTY (`load: () => []`), so its env
  key is the *only* credential it accepts. Revoking one server's key does not
  affect the other. Unset key ⇒ the process refuses to start rather than
  serving open.

  The per-agent consumer registry (`src/mcp-tools/consumers.ts`, backed by
  `<STATE_DIR>/mcp-consumers.json`) is a **separate, optional** mechanism: it
  is what the credentialed server in the `mailcal` repo uses, it is not wired
  up here, and it grants nothing on 8766/8767. Do not read "registry" as an
  alternative way in here — there is exactly one bearer per server, and it
  comes from the environment. Each bearer carries an attested provider
  (`MCP_PUBLIC_AUTH_TOKEN_PROVIDER` / `MCP_CATALOG_AUTH_TOKEN_PROVIDER`,
  both defaulting to the literal `openai_api`) that the policy gate reasons
  about; that default is worth reviewing before exposing a server.
  Rotation procedure: `docs/runbooks.md`.
- **Bind hosts are per server, by design.** `MCP_HTTP_HOST` is unused in this
  repo since the split; the public/catalog hosts have their own variables so a
  future credentialed server can never inherit an off-loopback bind.
- **No rebinding protection off loopback.** `StreamableHTTPServerTransport` in
  this SDK performs no Host/Origin validation (the DNS-rebinding feature exists
  only in the `sse.js`/express paths, which these servers do not use). Once
  bound to `0.0.0.0`, the bearer is the ONLY gate. There is no `allowedHosts`
  knob to set.
- **Clients.** Three places hold these bearers and all three must send the
  header: nanoclaw's `config/default-mcp-servers.json`; the per-group
  `mcp_servers` copies stored in nanoclaw's `container_configs` DB table (these
  do NOT re-read the default file — patch them too); and this repo's advisor
  (`src/advisor-mcp.ts`), which is a *client* of 8766/8767 as well as their
  host. The `scripts/mcp-public-bridge.mjs` forwarder is a fourth consumer only
  in the network sense: it is a raw TCP pipe, never parses HTTP, and passes
  Authorization headers through unchanged, so it needs no token and no restart.
- **Ops note.** Ports are tracked in `~/.dev-ports.yaml`. The catalog server is
  `mcp:catalog` on **8767** — older notes and that file may still call it
  `mcp_curriculum`, which is the pre-rename name for the same service. 8766 is
  `mcp_public`; 8765 (`mcp_credentialed`) belongs to `mailcal`, not here.

## Deploying tool or policy changes — RESTART REQUIRED

Logs: `~/Library/Logs/cuassistant.{mcp-public,mcp-catalog,advisor}.log`, rotated at
10 MB × 5 by the process (`LOG_FILE` / `LOG_MAX_BYTES` / `LOG_KEEP`); `*.err.log`
holds crash output plus this server's startup/registration lines (`server.ts`
writes those to stderr directly; tool-module lines use the logger).

**The servers load their tool registry and policy ONCE at process start.** They
run as long-lived launchd daemons (`tsx` against source), so editing the code is
NOT enough — a running daemon keeps serving the OLD build indefinitely and fails
**silently** (the new tool just never appears in `tools/list`). This is part of
shipping ANY new MCP functionality: after the change lands, restart the affected
service and verify.

Restart maps to what you changed:

| You edited | Affects tools on | Restart this launchd job |
|---|---|---|
| `src/mcp-tools/clemson-*.ts`, `index-public.ts` | public 8766 | `com.cuassistant.mcp-public-http` |
| `src/mcp-tools/catalog.ts`, `clemson-advising.ts`, `index-catalog.ts` | catalog 8767 | `com.cuassistant.mcp-catalog-http` |
| `src/mcp-tools/skills.ts` (both load it) | 8766 + 8767 | both jobs |
| `policy/action-policy.yaml`, `permissions.ts` | whichever server serves the op | the matching job(s) above |

Restart (KeepAlive jobs — `kickstart -k` kills and respawns):

```
launchctl kickstart -k gui/$(id -u)/com.cuassistant.mcp-public-http
launchctl kickstart -k gui/$(id -u)/com.cuassistant.mcp-catalog-http
```

The `com.cuassistant.mcp-public-bridge` forwarder (gateway → `127.0.0.1`) is a
transparent TCP pipe and does **not** need restarting for tool changes.

Verify the new tools are actually live (not just that the process restarted):

```
node scripts/mcp-tools-probe.mjs 8766 "$MCP_PUBLIC_AUTH_TOKEN"
```

Use `8767 "$MCP_CATALOG_AUTH_TOKEN"` for the catalog server. Confirm the tool
you added is in the list. A stale daemon is the first thing to suspect when an
agent reports a tool "doesn't exist" that you know is committed.

The `load-tools` menu is derived from the servers actually reachable at the
turn; during an outage of `gc_alumni`/`gc_curriculum_wiki` its category is
absent, so production can present a shorter menu than the benchmarks'
all-categories literal.

## Per-agent consumer registry

Not used by these servers. The machinery still exists in this repo
(`src/mcp-tools/consumers.ts`, backing `<STATE_DIR>/mcp-consumers.json`), but
both servers pass an EMPTY consumer source, so no registry file is read and
none exists here — it is the credentialed server's mechanism, and 8765 went to
`mailcal`. On 8766/8767 the env bearer is the whole of inbound auth (see
"Inbound auth" above). Giving these servers a per-user registry is what would
unpark `src/token-portal.ts`.

## Allow-list and authorized use

- `src/mcp-tools/permissions.ts` is the operation registry; both servers
  assert against it. `policy/action-policy.yaml` is the policy registry. A
  tool is exposed only when its operation is active **and** maps to an
  `approval: none` policy action; registration fails closed otherwise. Every
  tool calls `assertMcpOperation()` before any backend call, and write tools
  pass normalized inputs through policy constraint validators.
- The authorized-use list (`action-policy.yaml`) describes what this project is
  allowed to expose, independently of what any backend would technically
  permit. Every operation these two servers register is read-only over public
  data and maps to an `approval: none` action; there is no
  `approval: human_required` surface left in this repo — those actions belonged
  to the credentialed server and moved to `mailcal`.
- `action-policy.yaml` also carries the `data_egress` record the advisor's
  provider chain is checked against, at startup and again per turn. That is the
  enforcement point for `docs/policy/student-data.md`.

## Operation table — both servers (generated)

Servers 8766 (`cuassistant-public`) and 8767 (`cuassistant-catalog`). See
`docs/tool-rename-map.md` for the old→new tool-name migration (this table
reflects the deployed surface, post-migration). Generated from the live
registry by `scripts/mcp-manifest.ts` — run `npm run docs:mcp-manifest` after
any tool/operation change and commit the result;
`test/mcp-manifest.test.ts` fails on drift.

<!-- BEGIN GENERATED operation-table -->

| Tool                          | Server              | Operation key                         | Policy action                         | Backend       | Category          | Exposed |
| ----------------------------- | ------------------- | ------------------------------------- | ------------------------------------- | ------------- | ----------------- | ------- |
| `audit-gc-progress`           | cuassistant-catalog | `clemson.gc_audit_progress`           | `clemson.gc_audit_progress`           | external-http | curriculum-extras | yes     |
| `find-course-in-program`      | cuassistant-catalog | `clemson.gc_find_course_in_program`   | `clemson.gc_find_course_in_program`   | external-http | curriculum-extras | yes     |
| `find-requirement-sections`   | cuassistant-catalog | `clemson.find_requirement_sections`   | `clemson.find_requirement_sections`   | external-http | core              | yes     |
| `get-gc-gen-ed`               | cuassistant-catalog | `clemson.gc_gen_ed`                   | `clemson.gc_gen_ed`                   | external-http | curriculum-extras | yes     |
| `get-gc-program-plan`         | cuassistant-catalog | `clemson.gc_program_plan`             | `clemson.gc_program_plan`             | external-http | curriculum-extras | yes     |
| `get-gc-requirement-rules`    | cuassistant-catalog | `clemson.gc_requirement_rules`        | `clemson.gc_requirement_rules`        | external-http | curriculum-extras | yes     |
| `get-gc-skill-docs`           | cuassistant-catalog | `host.get_skill_docs`                 | `host.get_skill_docs`                 | host-state    | meta              | yes     |
| `get-program-requirements`    | cuassistant-catalog | `clemson.gc_program_requirements`     | `clemson.gc_program_requirements`     | external-http | curriculum-extras | yes     |
| `list-gc-catalog-years`       | cuassistant-catalog | `clemson.gc_catalog_years`            | `clemson.gc_catalog_years`            | external-http | curriculum-extras | yes     |
| `list-gc-skills`              | cuassistant-catalog | `host.list_skills`                    | `host.list_skills`                    | host-state    | meta              | yes     |
| `check-conflicts`             | cuassistant-public  | `clemson.check_conflicts`             | `clemson.check_conflicts`             | external-http | core              | yes     |
| `find-alternatives`           | cuassistant-public  | `clemson.find_alternatives`           | `clemson.find_alternatives`           | external-http | core              | yes     |
| `find-conflict-free-schedule` | cuassistant-public  | `clemson.find_conflict_free_schedule` | `clemson.find_conflict_free_schedule` | external-http | scheduling        | yes     |
| `get-course-details`          | cuassistant-public  | `clemson.course_details`              | `clemson.course_details`              | external-http | core              | yes     |
| `get-schedule-freshness`      | cuassistant-public  | `clemson.schedule_freshness`          | `clemson.schedule_freshness`          | external-http | meta              | yes     |
| `get-skill-docs`              | cuassistant-public  | `host.get_skill_docs`                 | `host.get_skill_docs`                 | host-state    | meta              | yes     |
| `list-clemson-terms`          | cuassistant-public  | `clemson.list_terms`                  | `clemson.list_terms`                  | external-http | meta              | yes     |
| `list-skills`                 | cuassistant-public  | `host.list_skills`                    | `host.list_skills`                    | host-state    | meta              | yes     |
| `search-classes`              | cuassistant-public  | `clemson.search_classes`              | `clemson.search_classes`              | external-http | core              | yes     |

<!-- END GENERATED operation-table -->

## Tool details

### Clemson public class schedule — `cuassistant-public` (Banner, no auth)

- `list-clemson-terms`, `search-classes`, `find-alternatives`,
  `check-conflicts`, `get-course-details`, `find-conflict-free-schedule` —
  read Clemson's public Banner Browse Classes data from a local SQLite snapshot
  refreshed daily at 05:00, so every answer carries a "data as of" stamp
  (`get-schedule-freshness` reports it). No outbound credentials.
- `list-skills` / `get-skill-docs` — serve the `clemson-schedule-advising`
  skill docs from `skills/`. Host state, no network.

### Catalog / degree audit — `cuassistant-catalog` (backed by `core/`)

- `list-gc-catalog-years`, `get-gc-program-plan`, `get-gc-requirement-rules`,
  `get-gc-gen-ed`, `get-program-requirements`, `find-requirement-sections`,
  `audit-gc-progress` — shell into `core/scripts/query.py` and
  `core/scripts/audit.py` (JSON on stdout) against `core/db/gc_advisor.db`.
  Every one takes `program` + `catalog_year` (with `name` / `year` accepted as
  deprecated aliases) and echoes the resolved pair back; there is no default
  program. Audit verdicts outside `Graphic Communications, BS` are
  **advisory-only**. Full contract: `docs/mcp-catalog.md`.
- `list-gc-skills` / `get-gc-skill-docs` — serve `core/skills/`. Host state.

## Adding or widening an operation

Every tool here is read-only over public data, so there is no policy-blocked
surface waiting to be widened — the `approval: human_required` actions that
used to be described in this section (mail/event delete, RSVP, task delete,
trigger-scan) belong to the credentialed server and moved to `mailcal` on
2026-08-24. Nothing in this repo is wired-but-unexposed.

To add a new operation:

1. Register it in `src/mcp-tools/permissions.ts` and give it an action in
   `policy/action-policy.yaml`. Registration fails closed: a tool is exposed
   only when its operation is active AND maps to an `approval: none` action.
2. Confirm the handler calls `assertMcpOperation()` before any backend call.
3. `npm run typecheck && npm run test:gate`, then `npm run docs:mcp-manifest`
   and commit the regenerated table above (`test/mcp-manifest.test.ts` fails on
   drift).
4. Restart the affected server and re-probe its tool list — see the restart
   section above. This step is part of shipping, not optional.

## What these servers do not do

- No writes of any kind. Every registered operation is a read against public
  Clemson data or a host-state skill lookup.
- No mailbox, calendar, task, or messaging capability. None is wired here; the
  advisor is additionally guarded against being handed the credentialed
  server's tools by port (`assertAdvisorMcpUrlSafe`).
- No student data. These servers see course codes, program names, and catalog
  years — never a transcript, name, or C-ID. See `docs/policy/student-data.md`.
- No SSO. Caller identity is the bearer: on stdio it is inherited from the
  spawning process, on HTTP it is whoever holds the server's one env token,
  plus the provider attested for it. Federated identity is a separate review
  step (hardening item D5/S1).
- Rate limiting is coarse: unauthenticated requests are logged through
  `src/log.ts` and a source exceeding 30 unauthenticated hits per minute gets
  429s. There are no per-tool throttles.
