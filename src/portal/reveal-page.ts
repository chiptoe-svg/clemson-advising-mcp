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
// WHY THE HEADERS ROW, not the "Bearer token env var" field. Codex's add-MCP
// form offers both, and only Headers takes a literal value. CONFIRMED by the
// owner against Codex itself, 2026-09-13: "if you do not have a way to define
// environment variables, use Headers instead — Key: Authorization, Value:
// Bearer YOUR_TOKEN". An earlier version of this file asserted the opposite —
// that Codex "stores it itself, so there is no environment variable to set" —
// which pointed a reader straight at the field that does not take a token.
//
// The env-var field is legitimate for someone who manages environment
// variables, and the page says so, with the caveat that it reads the APP's
// environment: an export in a shell profile is invisible to an app launched
// from the Dock, which never read that profile. That trap has burned this
// project before and its symptom is an auth failure that points at the token.
//
// NOTE the two surfaces are different products with different stores. This
// page documents the ChatGPT app's Settings -> Plugins -> MCPs form, which is
// where the owner's servers actually live. The Codex CLI (`codex mcp add
// --url ... --bearer-token-env-var ...`) writes ~/.codex/config.toml and
// accepts ONLY an env var name — no header option — so its instructions are
// not interchangeable with these.
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
    <li>In the ChatGPT app, click your name at the bottom left, then
        <b>Settings</b> (<kbd>⌘,</kbd>).</li>
    <li>Choose <b>Plugins</b>, under <i>Integrations</i>.</li>
    <li>Select the <b>MCPs</b> tab, then <b>Add</b> → <b>Add MCP server</b>.</li>
    <li><b>Name</b>: anything you like — the server name above works well.</li>
    <li><b>Type</b>: choose <b>Streamable HTTP</b> (not STDIO).</li>
    <li><b>URL</b>: paste the Server URL above, including the trailing slash.</li>
    <li><b>Leave “Bearer token env var” empty.</b> See the warning below.</li>
    <li>Under <b>Headers</b>, click <b>Add header</b> and enter:<br>
        Key <code>Authorization</code> — Value <code>Bearer &lt;your token&gt;</code>
        (the word <code>Bearer</code>, a space, then the token).</li>
    <li>Save, and make sure the server’s toggle is on.</li>
    <li>Repeat for each server above. The tokens are different and are
        <b>not interchangeable</b>.</li>
  </ol>
  <p class="disclosure"><b>Do not paste your token into “Bearer token env var”.</b>
  That field expects the NAME of an environment variable, not the token itself.
  A token pasted there makes Codex look for a variable with that name, find
  nothing, and send no credential — producing a 401 that looks exactly like a
  bad token, so you would spend your time checking the token rather than the
  field. The <b>Headers</b> row takes the value literally, which is why it is
  the step above.</p>
  <p class="scope">If you already manage environment variables, that field is a
  perfectly good alternative — put the variable’s name in it and set the
  variable. One caveat if you do: it reads the environment of the app itself,
  and an app launched from the Dock never read your shell profile, so an export
  in <code>.zshrc</code> will work in a terminal and fail in the app. On macOS,
  <code>launchctl setenv NAME value</code> sets it where the app can see it.</p>
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
