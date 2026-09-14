// The reveal page is the one surface a non-operator ever sees, and the only
// place a raw token is ever rendered. These pin the properties whose failure
// is silent: an unescaped value, a missing disclosure, a token presented as
// though it were shared across servers.
import assert from "node:assert/strict";
import test from "node:test";

import { renderRevealPage, type Grant } from "../src/portal/reveal-page.js";
import { escapeHtml } from "../src/portal/escape.js";
import {
  PIN_TTL_HOURS,
  CLAIM_TTL_HOURS,
  MAX_PIN_RESENDS,
} from "../src/portal/constants.js";

const grant = (o: Partial<Grant> = {}): Grant => ({
  server: "cu_schedule",
  label: "Clemson class schedule",
  url: "https://gcworkflow.clemson.edu:8443/cu_schedule/",
  token: "cma_TESTTOKEN",
  scopeSummary: "class times",
  ...o,
});
const page = (g: Grant[] = [grant()]) =>
  renderRevealPage({ personName: "Jane Smith", grants: g, contact: "Chip Tonkin" });

test("escapeHtml covers the single quote, not just the double", () => {
  // Attribute values here use double quotes today. A later edit to single
  // quotes would silently turn an escaped-looking value back into an injection
  // point — the same omission found and fixed in the retired portal (cdda77c).
  assert.equal(escapeHtml(`<a href='x'>&"`), "&lt;a href=&#39;x&#39;&gt;&amp;&quot;");
});

test("a hostile name cannot break out of the page", () => {
  const html = renderRevealPage({
    personName: '"><script>alert(1)</script>',
    grants: [grant()],
    contact: "x",
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("a hostile server name cannot break out of an attribute", () => {
  // server is interpolated into id= and for= attributes, so it is the value
  // most likely to escape if escaping is dropped.
  const html = page([grant({ server: '" onfocus="alert(1)' })]);
  assert.doesNotMatch(html, /onfocus="alert/);
});

test("the shown-once warning appears BEFORE any token", () => {
  // A person who scrolls past it has already lost the thing it warns about.
  const html = page();
  assert.ok(html.indexOf("shown once") < html.indexOf("cma_TESTTOKEN"));
});

test("every granted server gets its own labelled token", () => {
  const html = page([
    grant({ server: "cu_schedule", token: "cma_ONE" }),
    grant({ server: "gc_careers", token: "gc_TWO", label: "GC careers" }),
  ]);
  assert.match(html, /cma_ONE/);
  assert.match(html, /gc_TWO/);
  assert.match(html, /not interchangeable/i, "must say the tokens differ per server");
});

test("a disclosure is rendered verbatim when supplied", () => {
  // Authored by the repo that owns the server; paraphrasing it here would put
  // measured figures in the hands of the side that has been wrong about them.
  const d = "This token reads the complete alumni record for 3,135 graduates.";
  assert.match(page([grant({ server: "gc_alumni", disclosure: d })]), new RegExp(d));
});

test("a grant with no narrower scope says so, rather than saying nothing", () => {
  // Silence would read as "scoped, details omitted" — the absence-vs-limit
  // confusion this project keeps meeting.
  assert.match(page([grant({ scopeSummary: null })]), /Granted in full/);
});

test("the CLI example uses a real grant, never a placeholder", () => {
  // A placeholder is the thing people paste by accident.
  const html = page([grant({ token: "cma_REALONE", url: "https://example.test/s/" })]);
  assert.match(html, /Bearer cma_REALONE/);
  assert.doesNotMatch(html, /YOUR_TOKEN|<token>|xxxx/i);
});

test("it explains why pasting into the client beats an env var", () => {
  // The trap that has burned this project: a shell export that reads correctly
  // in a terminal and 401s under a GUI-launched app.
  assert.match(page(), /never read that profile|environment variable/i);
});

test("the claim window is never SHORTER than the PIN window", () => {
  // A claim that dies before its own delivery key is strictly incoherent: the
  // code arrives already useless. This is the invariant; equality is allowed
  // but makes resend decorative, which is the open question in constants.ts.
  assert.ok(
    CLAIM_TTL_HOURS >= PIN_TTL_HOURS,
    "a claim expiring before its PIN makes the emailed code dead on arrival",
  );
  assert.equal(PIN_TTL_HOURS, 24, "settled by the owner 2026-09-13");
});

test("resend only means something while the claim outlives the PIN", () => {
  // Encodes the consequence rather than asserting a preferred number: if the
  // two are equal, a person whose PIN lapsed has also lost the claim, and the
  // resend button cannot help them. Raising CLAIM_TTL_HOURS is what makes this
  // stop being true — deliberately, in one place.
  const resendCanHelp = CLAIM_TTL_HOURS > PIN_TTL_HOURS;
  assert.equal(
    resendCanHelp,
    false,
    "if this fails, the claim now outlives the PIN — resend became useful; " +
      "update constants.ts and delete this test rather than editing it",
  );
});

test("a PIN can be re-requested a bounded number of times", () => {
  // 24 hours is only workable because a fresh code needs no new approval. But
  // unbounded resends make the resend form an email-sending oracle.
  assert.ok(MAX_PIN_RESENDS > 0 && MAX_PIN_RESENDS <= 10);
});

test("ONLY granted servers appear — the page has no notion of the others", () => {
  // Structural rather than filtered: the page renders the grants it is given
  // and holds no list of all servers, so there is nothing for a bug to leak.
  // Pinned because "which servers exist, and does this person have alumni?"
  // is itself information the holder should not learn from their own page.
  const html = page([grant({ server: "cu_schedule", token: "cma_ONLYONE" })]);
  assert.match(html, /cu_schedule/);
  for (const absent of ["cu_catalog", "gc_alumni", "gc_careers"]) {
    assert.doesNotMatch(
      html,
      new RegExp(absent),
      `${absent} was not granted and must not appear anywhere on the page`,
    );
  }
  assert.match(html, /1 server\b/, "count must reflect the grants, not the roster");
});
