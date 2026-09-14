// The reveal page is the one surface a non-operator ever sees, and the only
// place a raw token is ever rendered. These pin the properties whose failure
// is silent: an unescaped value, a missing disclosure, a token presented as
// though it were shared across servers.
import assert from "node:assert/strict";
import test from "node:test";

import { renderRevealPage, type Grant } from "../src/portal/reveal-page.js";
import { escapeHtml } from "../src/portal/escape.js";

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
