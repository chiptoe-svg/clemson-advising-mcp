// The pages before the reveal: enter your code, and what went wrong.
//
// EVERY OUTCOME LOOKS THE SAME to someone who is not the intended recipient.
// This form is reachable by anyone who finds the URL, so it must never answer
// "does this address have access?" — not through wording, not through which
// error is shown, not through whether an email gets sent.
import { escapeHtml } from "./escape.js";
import { PIN_DIGITS } from "./constants.js";

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1a1a1a;--muted:#5c5c5c;
--line:#dcd8d0;--card:#fff;--accent:#7a2226;--warn-bg:#fdf3f2;--warn-line:#c9a3a3}
@media (prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#eceae6;--muted:#a3a09a;
--line:#32343a;--card:#1e2024;--accent:#e0888c;--warn-bg:#2a1e1f;--warn-line:#6b4446}}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);margin:0;
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:30rem;margin:0 auto;padding:3.5rem 1.25rem 4rem}
h1{font-size:1.4rem;margin:0 0 .4rem;letter-spacing:-.01em}
p{color:var(--muted);margin:0 0 1.5rem}
form{background:var(--card);border:1px solid var(--line);border-radius:.6rem;padding:1.4rem}
label{display:block;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;
color:var(--muted);margin:0 0 .3rem}
input{width:100%;padding:.6rem .7rem;border:1px solid var(--line);border-radius:.35rem;
background:var(--bg);color:var(--fg);font-size:1rem;margin-bottom:1.1rem}
input[name=pin]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
letter-spacing:.35em;font-size:1.2rem}
button{width:100%;padding:.7rem;border:0;border-radius:.35rem;background:var(--accent);
color:#fff;font-size:1rem;cursor:pointer}
.msg{background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:.5rem;
padding:.8rem 1rem;margin:0 0 1.5rem;color:var(--fg)}
.alt{margin:1.25rem 0 0;font-size:.9rem;text-align:center}
.alt button{background:none;color:var(--muted);text-decoration:underline;
font-size:.9rem;padding:.3rem}
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

export function activatePage(message?: string, email = ""): string {
  return shell(
    "Activate your MCP access",
    `<h1>Activate your access</h1>
<p>Enter the ${PIN_DIGITS}-digit code sent to your Clemson address.</p>
${message ? `<div class="msg">${escapeHtml(message)}</div>` : ""}
<form method="post" action="activate">
  <label for="email">Clemson email</label>
  <input id="email" name="email" type="email" required autocomplete="email"
         value="${escapeHtml(email)}">
  <label for="pin">Code</label>
  <input id="pin" name="pin" inputmode="numeric" autocomplete="one-time-code"
         pattern="[0-9]*" maxlength="${PIN_DIGITS + 2}" required>
  <button type="submit">Show my access</button>
</form>
<form method="post" action="resend" class="alt">
  <input type="hidden" name="email" value="${escapeHtml(email)}">
  <button type="submit">Send me a new code</button>
</form>`,
  );
}

/**
 * The ONE response a resend ever gives.
 *
 * Identical whether a grant exists, the address is unknown, the claim lapsed,
 * or the resend cap is hit. Any variation turns this form into an oracle
 * answering "does this person have access?" for anyone who can type an address
 * — a worse leak than anything the reveal page shows.
 */
export function resendPage(): string {
  return shell(
    "Check your email",
    `<h1>Check your email</h1>
<p>If access is waiting for that address, a new code is on its way. It is
valid for 24 hours.</p>
<p><a href="activate">Back to the code form</a></p>`,
  );
}

export function errorPage(title: string, detail: string): string {
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1>
<div class="msg">${escapeHtml(detail)}</div>
<p><a href="activate">Try again</a></p>`,
  );
}
