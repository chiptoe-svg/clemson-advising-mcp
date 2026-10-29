// Room seating capacity for Clemson classrooms.
//
// Banner's public "Browse Classes" feed carries no room capacity — it is not in
// searchResults at either the section or meetingTime level. The numbers here
// come from the SSO-gated CuSectionOverview report, exported by hand and
// committed under data/ as reference data.
//
// That is why this lives in data/ and not the gitignored state/: the nightly
// Banner refresh rebuilds everything in state/, and it cannot rebuild this. If
// state/ is wiped it regenerates; if this file is lost it needs another manual
// export from a system behind Clemson SSO.
//
// Capacity is a planning aid, never an authority. It is a point-in-time
// snapshot (see _source in the JSON), so a renovated or re-measured room goes
// quietly stale. Unknown rooms yield null — never 0, which would read as "this
// room seats nobody" rather than "we don't know".
//
// This is its own module rather than living in clemson-classes.ts because both
// the live-scan path (clemson-classes) and the snapshot path
// (clemson-schedule-db) build meetings, and clemson-classes already imports
// clemson-schedule-db — putting it in either would create a cycle.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { STATE_DIR } from "./config-mcp.js";
import { log } from "./log.js";

let capacities: Map<string, number> | null = null;

function load(): Map<string, number> {
  if (capacities) return capacities;
  try {
    const raw = readFileSync(
      new URL("../data/clemson-room-capacity.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { rooms?: Record<string, number> };
    capacities = new Map(Object.entries(parsed.rooms ?? {}));
  } catch (err) {
    // Degrade to "unknown everywhere" rather than failing every class search.
    log.warn("clemson room capacity data unavailable", { err: String(err) });
    capacities = new Map();
  }
  return capacities;
}

// Department-known capacities (Chip, 2026-10-28: "I know Godfrey holds 64"
// where the reference table says 60). A hand-edited file in state/, read on
// change without a restart:
//
//   # state/room-capacity-overrides.yaml
//   rooms:
//     "Godfrey Hall 201": 64     # building, a space, then the room
//
// An override wins over the reference table and can add a room it lacks. An
// absent file means none; an unreadable one falls back to the reference
// numbers — a class search must never fail on it — and capacityOverrides()
// reports the error so the admin tools can say so.
const OVERRIDES_PATH = () =>
  process.env.ROOM_CAPACITY_OVERRIDES ||
  path.join(STATE_DIR, "room-capacity-overrides.yaml");

let overrides: {
  checkedAt: number;
  mtimeMs: number | null;
  rooms: Map<string, number>;
  error: string | null;
} | null = null;

export function capacityOverrides(): {
  rooms: ReadonlyMap<string, number>;
  error: string | null;
} {
  // roomCapacity runs once per meeting; look at the file at most once a
  // second, so an edit still lands without a restart.
  const now = Date.now();
  if (overrides && now - overrides.checkedAt < 1000) return overrides;
  const p = OVERRIDES_PATH();
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(p).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  if (overrides && overrides.mtimeMs === mtimeMs) {
    overrides.checkedAt = now;
    return overrides;
  }
  const rooms = new Map<string, number>();
  let error: string | null = null;
  if (mtimeMs !== null) {
    try {
      const parsed = YAML.parse(readFileSync(p, "utf8")) as {
        rooms?: unknown;
      } | null;
      const raw = parsed?.rooms ?? {};
      if (typeof raw !== "object" || Array.isArray(raw))
        throw new Error("'rooms' must be a map of \"Building Room\": seats");
      for (const [name, seats] of Object.entries(
        raw as Record<string, unknown>,
      )) {
        const m = /^(.*\S)\s+(\S+)$/.exec(name.trim());
        if (!m) throw new Error(`"${name}" must be "Building Room"`);
        if (typeof seats !== "number" || !(seats > 0))
          throw new Error(`"${name}" must be a positive number of seats`);
        rooms.set(`${m[1]}|${m[2]}`, seats);
      }
    } catch (err) {
      rooms.clear();
      error = `room capacity overrides unreadable (${p}): ${err instanceof Error ? err.message : String(err)}`;
      log.warn("room capacity overrides unreadable", { error });
    }
  }
  overrides = { checkedAt: now, mtimeMs, rooms, error };
  return overrides;
}

/**
 * Seats in `room` of `building`, or null when unknown. A department
 * override (capacityOverrides) wins over the reference table.
 *
 * `building` is the Banner *description* ("Jordan Hall"), not the code
 * ("JORDAN"), because that is what both meeting paths already carry.
 */
export function roomCapacity(
  building: string | null,
  room: string | null,
): number | null {
  if (!building || !room) return null;
  const key = `${building}|${room}`;
  return capacityOverrides().rooms.get(key) ?? load().get(key) ?? null;
}

/** Test seam: drop the memoised table so a fixture can be re-read. */
export function resetRoomCapacityCache(): void {
  capacities = null;
  overrides = null;
}
