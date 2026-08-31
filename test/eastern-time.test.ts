import assert from "node:assert/strict";
import test from "node:test";
import { toEasternIso } from "../src/eastern-time.ts";

test("the 2026-08-26 refresh stamp renders as 05:02 Eastern with an explicit offset (the '9:02 AM' misread)", () => {
  assert.equal(
    toEasternIso("2026-08-26T09:02:12.177Z"),
    "2026-08-26T05:02:12.177-04:00",
  );
});
test("standard time uses -05:00", () => {
  assert.equal(
    toEasternIso("2026-01-15T10:00:00.000Z"),
    "2026-01-15T05:00:00.000-05:00",
  );
});
test("the rendered string is the same instant", () => {
  for (const iso of [
    "2026-08-26T09:02:12.177Z",
    "2026-11-01T05:30:00.000Z",
    "2026-03-08T07:00:00.000Z",
  ]) {
    assert.equal(Date.parse(toEasternIso(iso)), Date.parse(iso), iso);
  }
});
test("unparseable or empty input passes through unchanged", () => {
  assert.equal(toEasternIso(""), "");
  assert.equal(toEasternIso("not a date"), "not a date");
});
