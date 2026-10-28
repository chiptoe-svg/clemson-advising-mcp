// What the refresh job does on each launchd firing (05:00 and hourly
// 08:00–17:00, every day). Registration mode, Chip 2026-10-28: from Nov 4
// through Dec 4, Spring 2027 hourly on weekdays 08–17 Eastern, plus the 05:00
// run daily — Spring only, which is what stops Fall 2026 for the month.
// Outside a window: 05:00 daily, all live terms, as before. A 05:00 run
// missed while the Mac slept still runs as the nightly when it wakes.
import assert from "node:assert/strict";
import test from "node:test";

import { planRefresh, type RegistrationWindow } from "../src/refresh-plan.ts";

const WIN: RegistrationWindow[] = [
  { term: "202701", start: "2026-11-04", end: "2026-12-04" },
];
// Eastern is UTC-5 in November (after the Nov 1 DST change), UTC-4 before.
const at = (iso: string) => new Date(iso);

test("05:00 outside any window: the nightly, all live terms", () => {
  const p = planRefresh(at("2026-10-29T09:00:00Z"), WIN, "2026-10-28");
  assert.deepEqual(p, {
    run: "nightly",
    mode: "normal",
    terms: "live",
    date: "2026-10-29",
  });
});

test("10:00 on a weekday outside any window: nothing", () => {
  const p = planRefresh(at("2026-10-29T14:00:00Z"), WIN, "2026-10-29");
  assert.equal(p.run, "skip");
  assert.equal(p.mode, "normal");
});

test("first day of the window, 05:00: the nightly, registering term only", () => {
  const p = planRefresh(at("2026-11-04T10:00:00Z"), WIN, "2026-11-03");
  assert.deepEqual(p, {
    run: "nightly",
    mode: "registration",
    terms: ["202701"],
    date: "2026-11-04",
  });
});

test("weekday 08:00 and 17:00 in the window: hourly, registering term only", () => {
  for (const iso of ["2026-11-04T13:00:00Z", "2026-11-04T22:00:00Z"]) {
    const p = planRefresh(at(iso), WIN, "2026-11-04");
    assert.equal(p.run, "hourly", iso);
    assert.deepEqual(p.terms, ["202701"]);
  }
});

test("Saturday 10:00 in the window: nothing (hourly is weekdays only)", () => {
  const p = planRefresh(at("2026-11-07T15:00:00Z"), WIN, "2026-11-07");
  assert.equal(p.run, "skip");
  assert.equal(p.mode, "registration");
});

test("the last day is included; the day after is normal again", () => {
  assert.equal(
    planRefresh(at("2026-12-04T15:00:00Z"), WIN, "2026-12-04").run,
    "hourly",
  );
  const after = planRefresh(at("2026-12-05T10:00:00Z"), WIN, "2026-12-04");
  assert.equal(after.mode, "normal");
  assert.equal(after.terms, "live");
});

test("a 05:00 run missed while asleep runs as the nightly when it fires late", () => {
  const p = planRefresh(at("2026-10-31T15:00:00Z"), WIN, "2026-10-30"); // Sat 11:00
  assert.equal(p.run, "nightly");
  assert.equal(p.terms, "live");
});

test("the day is read in Eastern, not UTC (23:30 ET is still the same day)", () => {
  // 2026-11-05 04:30Z = Nov 4, 23:30 ET; the nightly for Nov 4 already ran.
  const p = planRefresh(at("2026-11-05T04:30:00Z"), WIN, "2026-11-04");
  assert.equal(p.run, "skip");
});

test("no windows: always normal", () => {
  const p = planRefresh(at("2026-11-04T15:00:00Z"), [], "2026-11-04");
  assert.equal(p.mode, "normal");
  assert.equal(p.run, "skip");
});
