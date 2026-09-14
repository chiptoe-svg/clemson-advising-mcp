// The reveal page: what a person sees after proving inbox control with a PIN.
//
// THIS IS THE DELIVERABLE. Chip said so directly, and it reframed the work:
// the roster, the approval and the claim seam are all a means to this page.
// If the page is good he does not care how the grants reached it; if it is bad,
// none of the plumbing buys him anything.
//
// WHAT IT IS FOR, concretely: a person follows a link, types a PIN, and lands
// here with the URL and bearer token for each server they were granted, ready
// to paste into Codex's "add MCP server" settings.
//
// WHY PASTE-INTO-SETTINGS IS THE PRIMARY FORM, not the CLI. When a token is
// pasted into Codex's own settings, Codex stores it, and the whole
// bearer-token-env-var problem disappears. That trap has burned this project
// before: a .zshrc export reads correctly in a shell and 401s under a
// GUI-launched client, because the GUI never sourced the shell profile. The
// symptom is an auth failure that points at the token. So the page leads with
// copyable URL + token fields and offers the CLI form second.
//
// ONE TOKEN PER SERVER, NEVER MERGED. The servers keep separate registries and
// the tokens are not interchangeable; a token minted for one returns 401 on
// another. Presenting them as a set with one label would produce exactly that
// 401, read as "my token doesn't work".
//
// SHOWN ONCE. Only the sha256 is stored, so this page cannot be reproduced.
// That has to be stated before the tokens rather than after, because a person
// who scrolls past it has already lost the thing.
import { escapeHtml } from "./escape.js";
import { resolveDisclosure } from "./disclosures.js";

export interface Grant {
  /** User-visible server name, e.g. "cu_schedule". */
  server: string;
  /** Human label, e.g. "Clemson class schedule". */
  label: string;
  /** Full external URL to paste. Supplied by whoever owns the path. */
  url: string;
  /** Raw bearer. Exists only for this response. */
  token: string;
  /** Human-readable scope summary, or null when granted whole. */
  scopeSummary: string | null;
  /**
   * A plain-language statement of what this token reaches, shown prominently.
   * RETURNED BY THE SERVER THAT OWNS THE DATA (gc_alumni's /claim includes it
   * in the 200 payload), because that side can assert its figures against the
   * database it actually serves and this side cannot. Render what you are
   * given; a local fallback applies only when the field is absent.
   *
   * Every warning before this page was aimed at the approver. The HOLDER has
   * seen none of them, and this is the moment they understand what they hold.
   */
  disclosure?: string;
}

export interface RevealPageInput {
  personName: string;
  grants: Grant[];
  /** Where to point someone whose grant is wrong or missing. */
  contact: string;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1a1a1a;--muted:#5c5c5c;
--line:#dcd8d0;--card:#fff;--accent:#7a2226;--warn-bg:#fdf3f2;--warn-line:#c9a3a3;
--code-bg:#f4f2ee}
@media (prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#eceae6;--muted:#a3a09a;
--line:#32343a;--card:#1e2024;--accent:#e0888c;--warn-bg:#2a1e1f;--warn-line:#6b4446;
--code-bg:#26282d}}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);margin:0;
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:47rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
h1{font-size:1.5rem;margin:0 0 .25rem;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0 0 2rem}
.once{background:var(--warn-bg);border:1px solid var(--warn-line);
border-radius:.5rem;padding:.9rem 1.1rem;margin:0 0 2rem}
.once strong{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:.6rem;
padding:1.25rem;margin:0 0 1.25rem}
.card h2{font-size:1.05rem;margin:0 0 .15rem}
.card .server{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
font-size:.85rem;color:var(--muted)}
.disclosure{background:var(--warn-bg);border-left:3px solid var(--accent);
padding:.7rem .9rem;margin:.9rem 0;border-radius:0 .3rem .3rem 0;font-size:.93rem}
.field{margin:.9rem 0 0}
.field label{display:block;font-size:.78rem;text-transform:uppercase;
letter-spacing:.06em;color:var(--muted);margin-bottom:.3rem}
.field input{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
font-size:.88rem;padding:.55rem .65rem;border:1px solid var(--line);
border-radius:.35rem;background:var(--code-bg);color:var(--fg)}
.scope{font-size:.87rem;color:var(--muted);margin:.75rem 0 0}
details{margin:2rem 0 0;border-top:1px solid var(--line);padding-top:1.25rem}
summary{cursor:pointer;color:var(--muted);font-size:.92rem}
pre{background:var(--code-bg);border:1px solid var(--line);border-radius:.35rem;
padding:.8rem;overflow-x:auto;font-size:.82rem}
.steps{padding-left:1.15rem}.steps li{margin:.3rem 0}
footer{color:var(--muted);font-size:.87rem;margin-top:2.5rem;
border-top:1px solid var(--line);padding-top:1.25rem}
`;

function grantCard(g: Grant): string {
  // Falls back rather than rendering nothing: a missing disclosure is silence,
  // and silence here reads as "nothing about this needs saying".
  const text = resolveDisclosure(g.server, g.disclosure);
  const disclosure = text ? `<p class="disclosure">${escapeHtml(text)}</p>` : "";
  const scope = g.scopeSummary
    ? `<p class="scope">Scope: ${escapeHtml(g.scopeSummary)}</p>`
    : `<p class="scope">Granted in full — this server has no narrower scope.</p>`;
  return `
    <section class="card">
      <h2>${escapeHtml(g.label)}</h2>
      <p class="server">${escapeHtml(g.server)}</p>
      ${disclosure}
      <div class="field">
        <label for="u-${escapeHtml(g.server)}">Server URL</label>
        <input id="u-${escapeHtml(g.server)}" value="${escapeHtml(g.url)}" readonly
               onclick="this.select()">
      </div>
      <div class="field">
        <label for="t-${escapeHtml(g.server)}">Bearer token</label>
        <input id="t-${escapeHtml(g.server)}" value="${escapeHtml(g.token)}" readonly
               onclick="this.select()">
      </div>
      ${scope}
    </section>`;
}

export function renderRevealPage(input: RevealPageInput): string {
  const n = input.grants.length;
  // A token is per-server, so the CLI example uses the FIRST grant rather than
  // a placeholder — a placeholder is the thing people paste by accident.
  const first = input.grants[0];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your MCP access</title><style>${STYLE}</style></head>
<body><div class="wrap">
<h1>Your MCP access is ready</h1>
<p class="sub">${escapeHtml(input.personName)} — ${n} server${n === 1 ? "" : "s"}</p>

<div class="once">
  <strong>This page is shown once.</strong> Only a hash of each token is stored,
  so we cannot show them again. Copy them into your client now — if you lose
  them, ask ${escapeHtml(input.contact)} to issue new ones.
</div>

${input.grants.map(grantCard).join("")}

<details open>
  <summary>Adding these to Codex</summary>
  <ol class="steps">
    <li>Open Codex settings and choose <b>Add MCP server</b>.</li>
    <li>Paste the <b>Server URL</b> above.</li>
    <li>Choose bearer-token authentication and paste the <b>Bearer token</b>.</li>
    <li>Repeat for each server listed — the tokens are different and are
        <b>not interchangeable</b>.</li>
  </ol>
  <p class="scope">Pasting the token into Codex is the reliable way to do this:
  Codex stores it itself, so there is no environment variable to set. A token
  exported from a shell profile often works in a terminal and fails under an
  app launched from the Dock, because the app never read that profile.</p>
</details>

<details>
  <summary>Command-line form, if you configure clients by file</summary>
  <pre>${escapeHtml(
    `{
  "mcpServers": {
    "${first?.server ?? "server"}": {
      "url": "${first?.url ?? ""}",
      "headers": { "Authorization": "Bearer ${first?.token ?? ""}" }
    }
  }
}`,
  )}</pre>
</details>

<footer>
  These credentials identify you. Do not share or forward them. If something
  here is wrong or missing, contact ${escapeHtml(input.contact)}.
</footer>
</div></body></html>`;
}
