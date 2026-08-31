import assert from "node:assert/strict";
import test from "node:test";
import { __setTermClockForTest, resolveTerm } from "../src/term-resolve.ts";

// Pins defaultTerm's month→term mapping AS SHIPPED, month by month, so a change
// is deliberate (2026-08-26 review D14 questions Nov→Fall and Apr→Spring; this
// table is where that decision gets made, with the seam that makes it testable).
const EXPECTED: Record<number, string> = {
  1: "202601",
  2: "202601",
  3: "202601",
  4: "202601",
  5: "202608",
  6: "202608",
  7: "202608",
  8: "202608",
  9: "202608",
  10: "202608",
  11: "202608",
  12: "202701",
};

test("defaultTerm by month (2026), through the test clock seam", () => {
  try {
    for (let m = 1; m <= 12; m++) {
      __setTermClockForTest(() => new Date(Date.UTC(2026, m - 1, 15, 12)));
      const r = resolveTerm("");
      const term = "term" in r ? r.term : `error:${r.error.slice(0, 40)}`;
      // With no snapshots on disk resolveTerm may return an error naming the
      // resolved code; accept either form and compare the code.
      const code =
        "term" in r ? r.term : (r.error.match(/\b20\d{4}\b/)?.[0] ?? term);
      assert.equal(code, EXPECTED[m], `month ${m}`);
    }
  } finally {
    __setTermClockForTest(null);
  }
});

test("the seam is off by default (wall clock) and resets to it", () => {
  __setTermClockForTest(null);
  const r = resolveTerm("");
  const code = "term" in r ? r.term : (r.error.match(/\b20\d{4}\b/)?.[0] ?? "");
  assert.match(code, /^20\d{4}$/);
});
