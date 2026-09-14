// The pages before the reveal are reachable by anyone who finds the URL. The
// property that matters is NON-DISCLOSURE: nothing here may answer "does this
// address have access?" — not by wording, not by which error appears, not by
// whether a mail goes out.
import assert from "node:assert/strict";
import test from "node:test";

import { activatePage, resendPage, errorPage } from "../src/portal/pages.js";

test("resend gives ONE answer, conditioned on nothing", () => {
  // It takes no argument by construction. A signature that accepted an
  // outcome would eventually be called with one, and the form would start
  // telling strangers which addresses have access pending.
  assert.equal(resendPage.length, 0);
  assert.match(resendPage(), /If access is waiting for that address/);
});

test("the activate form escapes a hostile email back into the field", () => {
  // The address is echoed so a person does not retype it, which makes it the
  // one attacker-controlled value rendered before authentication.
  const html = activatePage("msg", '"><script>alert(1)</script>');
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("a message is escaped too", () => {
  assert.doesNotMatch(activatePage('"><img onerror=x>'), /<img onerror/);
});

test("errorPage escapes both halves", () => {
  const html = errorPage("<b>t</b>", "<b>d</b>");
  assert.doesNotMatch(html, /<b>t<\/b>/);
  assert.doesNotMatch(html, /<b>d<\/b>/);
});

test("the form offers a resend without requiring a correct code first", () => {
  // Someone whose PIN expired must not have to guess at a dead code to reach
  // the way out.
  assert.match(activatePage(), /Send me a new code/);
});

test("no page links anywhere external", () => {
  // The CSP forbids it; this asserts the pages do not try, so a policy change
  // cannot quietly turn a broken link into a live one.
  for (const html of [activatePage(), resendPage(), errorPage("a", "b")]) {
    assert.doesNotMatch(html, /https?:\/\//);
  }
});
