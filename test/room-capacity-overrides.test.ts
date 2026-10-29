// Department-known room capacities override Banner's (Chip, 2026-10-28: "I
// know Godfrey holds 64" — the official table says 60). A hand-edited file
// in state/, read without a restart; an unreadable file never breaks a class
// search, but says so.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "room-cap-"));
process.env.STATE_DIR = STATE;
const F = path.join(STATE, "room-capacity-overrides.yaml");
const C = await import("../src/clemson-room-capacity.ts");

test("no override file: the official capacity", () => {
  assert.equal(C.roomCapacity("Godfrey Hall", "201"), 60);
  assert.equal(C.capacityOverrides().error, null);
});

test("an override replaces the official capacity, and a new room can be added", () => {
  fs.writeFileSync(
    F,
    'rooms:\n  "Godfrey Hall 201": 64\n  "Godfrey Hall 999": 12\n',
  );
  C.resetRoomCapacityCache();
  assert.equal(C.roomCapacity("Godfrey Hall", "201"), 64);
  assert.equal(C.roomCapacity("Godfrey Hall", "999"), 12);
  assert.equal(C.roomCapacity("Godfrey Hall", "205"), 44);
});

test("an unreadable file falls back to official numbers and reports the error", () => {
  fs.writeFileSync(F, "rooms: [unclosed");
  C.resetRoomCapacityCache();
  assert.equal(C.roomCapacity("Godfrey Hall", "201"), 60);
  assert.match(
    C.capacityOverrides().error ?? "",
    /room capacity overrides unreadable/,
  );
  fs.writeFileSync(F, 'rooms:\n  "Godfrey Hall 201": "lots"\n');
  C.resetRoomCapacityCache();
  assert.match(C.capacityOverrides().error ?? "", /must be a positive number/);
});
