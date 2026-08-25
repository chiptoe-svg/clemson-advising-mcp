# CUassistant MCP servers — IT review manifest

This is the human-readable companion to the MCP entry points
(`src/mcp-public.ts`, `src/mcp-catalog.ts`). It enumerates the MCP operation
surface across the two public-data servers, what backend each operation uses, what
permission it requires, and whether the tool is exposed to the agent.

## Two servers, split by security class

CUassistant exposes its capabilities through two MCP servers, separated by
whether they hold credentials — not by vendor domain.

### `cuassistant-credentialed` (8765) — moved to the mailcal repo

As of 2026-08-24 the credentialed server (private Exchange/MS365 + Google
Workspace tools, send-approval gate, per-agent token registry) lives in
`/Users/admin/projects/mailcal_tonkin` (`github.com/chiptoe-svg/mailcal`,
private). It is not part of CUassistant. It never loads the public or catalog
tool indexes. The NanoClaw wiring runbook
(`docs/nanoclaw-integration-handoff.md`) moved with it.

### `cuassistant-public` / `cuassistant-catalog` (public DATA, bearer required)

- **What.** 8766 serves the Clemson class-schedule tools (public Banner Browse
  Classes API); 8767 serves the GC curriculum/degree-plan tools bridged from
  gc_advisor. The DATA is public; access to the servers is not.
- **Transports.** Dual.
  - **Streamable HTTP** — `npm run mcp:public:http` / `npm run mcp:catalog:http`
    (`MCP_TRANSPORT=http`). Bind
    `${MCP_PUBLIC_HTTP_HOST:-127.0.0.1}:${MCP_PUBLIC_HTTP_PORT:-8766}` and
    `${MCP_CATALOG_HTTP_HOST:-127.0.0.1}:${MCP_CATALOG_HTTP_PORT:-8767}`.
    launchd services run both as host daemons.
  - **stdio** — `npm run mcp:public` / `npm run mcp:catalog`. Local/dev only.
- **Inbound auth.** One bearer per server: `MCP_PUBLIC_AUTH_TOKEN` and
  `MCP_CATALOG_AUTH_TOKEN`, in the gitignored `.env`. Each server's consumer
  source is EMPTY (`load: () => []`), so its env key is the only credential it
  accepts — the per-agent registry behind 8765 grants nothing here, and
  revoking one server's key does not affect the other. Unset key ⇒ the process
  refuses to start rather than serving open.
- **Bind hosts are per server, by design.** `MCP_HTTP_HOST` is unused in this
  repo since the split; the public/catalog hosts have their own variables so a
  future credentialed server can never inherit an off-loopback bind.
- **No rebinding protection off loopback.** `StreamableHTTPServerTransport` in
  this SDK performs no Host/Origin validation (the DNS-rebinding feature exists
  only in the `sse.js`/express paths, which these servers do not use). Once
  bound to `0.0.0.0`, the bearer is the ONLY gate. There is no `allowedHosts`
  knob to set.
- **Clients.** All four must send the header: nanoclaw's
  `config/default-mcp-servers.json`, the per-group `mcp_servers` copies stored
  in nanoclaw's `container_configs` DB table (these do NOT re-read the default
  file — patch them too), and this repo's advisor (`src/advisor-mcp.ts`). The
  `scripts/mcp-public-bridge.mjs` forwarder is a raw TCP pipe and needs no
  change; it never parses HTTP, so Authorization headers pass through.
- **Ops note.** Ports tracked in `~/.dev-ports.yaml` (cuassistant:
  `mcp_credentialed` 8765, `mcp_public` 8766, `mcp_curriculum` 8767).

## Deploying tool or policy changes — RESTART REQUIRED

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

## Per-agent consumer registry — moved to mailcal with 8765.

## Allow-list and authorized use

- `src/mcp-tools/permissions.ts` is the operation registry; both servers
  assert against it. `policy/action-policy.yaml` is the policy registry. A
  tool is exposed only when its operation is active **and** maps to an
  `approval: none` policy action; registration fails closed otherwise. Every
  tool calls `assertMcpOperation()` before any backend call, and write tools
  pass normalized inputs through policy constraint validators.
- OAuth scopes describe what the delegated token may technically permit; the
  authorized-use list (`action-policy.yaml`) describes what CUassistant is
  allowed to expose. Destructive or affects-others actions (mail/event delete,
  RSVP, task delete, trigger-scan) are `approval: human_required` and are
  therefore **wired but not exposed**.

## Operation table — `cuassistant-public`

Server 8766. See `docs/tool-rename-map.md` for the old→new tool-name migration
(this table reflects the deployed surface, post-migration).

| Tool                          | Operation key                         | Policy action                         | Backend | Exposed |
| ------------------------------ | -------------------------------------- | -------------------------------------- | ------- | ------- |
| `list-clemson-terms`          | `clemson.list_terms`                  | `clemson.list_terms`                  | Banner  | yes     |
| `search-classes`              | `clemson.search_classes`              | `clemson.search_classes`              | Banner  | yes     |
| `find-alternatives`           | `clemson.find_alternatives`           | `clemson.find_alternatives`           | Banner  | yes     |
| `check-conflicts`             | `clemson.check_conflicts`             | `clemson.check_conflicts`             | Banner  | yes     |
| `get-course-details`          | `clemson.course_details`              | `clemson.course_details`              | Banner  | yes     |
| `find-conflict-free-schedule` | `clemson.find_conflict_free_schedule` | `clemson.find_conflict_free_schedule` | Banner  | yes     |

## Tool details

### Clemson public class schedule — `cuassistant-public` (Banner, no auth)

- `list-clemson-terms`, `search-classes`, `find-alternatives`,
  `check-conflicts`, `get-course-details`, `find-conflict-free-schedule` —
  read Clemson's public Banner Browse Classes data. No credentials.

## Widening a policy-blocked operation

`delete-todo-task`, `delete-calendar-event`, the three RSVP tools, and
`trigger_scan` are fully wired but unregistered because their policy action is
`approval: human_required`. To expose one:

1. Change the action's `approval` to `none` in `policy/action-policy.yaml`
   (only if genuinely safe unattended), or route it through a human-approval
   gate equivalent to the send gate.
2. Confirm the action's policy constraints are enforced by validators in
   `src/mcp-tools/permissions.ts`.
3. Re-run `npm test` and `npm run typecheck`, and update the table above.

## What these servers do not do

- No send-mail outside the Telegram approval gate. Drafts only on the
  mail-write surface.
- No mailbox rules CRUD; no shared mailbox or shared calendar access.
- No Teams chat, OneDrive, SharePoint, Drive, or Planner tools.
- No SSO. Caller identity on stdio is inherited from the spawning process; on
  HTTP it is the per-agent registry token (the matched consumer id). Federated
  identity beyond the token registry is a separate review step.
- No rate limiting beyond the send gate's throttles. Per-tool throttles are a
  separate review step.
