// A course with no sections is a real answer, not an outage (Cob_advisor,
// 2026-10-28: "is GC 4070 offered in spring? check live" was told Banner was
// down, for every zero-section course, every time). Banner answers both a
// cold session (term not bound) and a genuinely empty query with
// totalCount 0; a term-wide control search on a fresh session tells them
// apart. Fake Banner via globalThis.fetch, as clemson-banner-fetch.test.ts.
import assert from "node:assert/strict";
import test from "node:test";

import { searchClemsonClasses } from "../src/clemson-classes.js";

function fakeBanner(termWideTotal: number) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (!u.includes("searchResults")) return new Response("", { status: 200 });
    const q = new URL(u).searchParams;
    const total = q.get("txt_courseNumber") ? 0 : termWideTotal;
    return new Response(
      JSON.stringify({
        totalCount: total,
        data: total ? [{ courseReferenceNumber: "1", term: "202701" }] : [],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

test("a course with no sections answers 0 live, when the term itself answers", async () => {
  const restore = fakeBanner(10073);
  try {
    const r = await searchClemsonClasses({
      term: "202701",
      subject: "GC",
      courseNumber: "2510",
      refresh: true,
    });
    assert.ok(r, "an empty course is not an outage");
    assert.equal(r.totalCount, 0);
    assert.deepEqual(r.sections, []);
    assert.equal(r.scope, "live");
  } finally {
    restore();
  }
});

test("when even the term-wide control is empty, it is still an outage (null)", async () => {
  const restore = fakeBanner(0);
  try {
    const r = await searchClemsonClasses({
      term: "202701",
      subject: "GC",
      courseNumber: "2510",
      refresh: true,
    });
    assert.equal(r, null);
  } finally {
    restore();
  }
});
