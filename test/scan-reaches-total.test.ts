// A term scan is complete only when it reaches Banner's own count. An empty
// page partway through (a throttled or cut-off answer) used to count as "the
// end", so the nightly refresh could write a partial term over a good one.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "scan-total-"));
process.env.STATE_DIR = STATE;
fs.mkdirSync(path.join(STATE, "clemson"), { recursive: true });

const { refreshClemsonSnapshot } = await import("../src/clemson-classes.ts");
const { scheduleDbPath } = await import("../src/clemson-schedule-db.ts");

function rows(from: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    courseReferenceNumber: String(from + i),
    subjectCourse: "GC1010",
  }));
}

/** A fake Banner whose search pages come from `pages`, one per request. */
async function withBanner<T>(
  pages: { totalCount: number; data: unknown[] }[],
  run: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  let page = 0;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("searchResults/searchResults")) {
      const body = pages[Math.min(page++, pages.length - 1)];
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("an empty page before Banner's count is reached is not a complete term", async () => {
  const snap = await withBanner(
    [
      { totalCount: 1000, data: rows(0, 500) },
      { totalCount: 1000, data: [] },
    ],
    () => refreshClemsonSnapshot("209901"),
  );
  assert.equal(snap, null);
  assert.equal(fs.existsSync(scheduleDbPath("209901")), false);
});

test("a first page with a count but no rows is not a complete (empty) term", async () => {
  const snap = await withBanner([{ totalCount: 600, data: [] }], () =>
    refreshClemsonSnapshot("209902"),
  );
  assert.equal(snap, null);
  assert.equal(fs.existsSync(scheduleDbPath("209902")), false);
});

test("a scan that reaches Banner's count is written", async () => {
  const snap = await withBanner(
    [
      { totalCount: 700, data: rows(0, 500) },
      { totalCount: 700, data: rows(500, 200) },
    ],
    () => refreshClemsonSnapshot("209903"),
  );
  assert.equal(snap?.sectionCount, 700);
  assert.ok(fs.existsSync(scheduleDbPath("209903")));
});
