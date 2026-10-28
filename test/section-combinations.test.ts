// Which sections of A and B can a student take together (2026-10-28).
//
// Reproduced on 8766 before this existed: find-conflict-free-schedule with
// candidate_crns = both sections of GC 4061 and both of GC 4401 returned
// conflict_free: [], because it checks every candidate against every other —
// so a course's own alternative sections ruled each other out. Two pairings
// fit (12333+17915, 12332+12336); a model read the empty answer as
// "impossible". Sections of one group are alternatives and are never compared.
import assert from "node:assert/strict";
import test from "node:test";

import {
  searchCombinations,
  type CombinationSection,
} from "../src/section-combinations.ts";

const mw = (crn: string, s: number, e: number): CombinationSection => ({
  crn,
  meetings: ["M", "W"].map((day) => ({ day, startMin: s, endMin: e })),
});
const tr = (crn: string, s: number, e: number): CombinationSection => ({
  crn,
  meetings: ["T", "R"].map((day) => ({ day, startMin: s, endMin: e })),
});

// Spring 2027 as Banner lists them: MW 11:15–2:00, TR 8:00–10:45.
const GC4061 = [mw("12332", 675, 840), tr("12333", 480, 645)];
const GC4401 = [mw("17915", 675, 840), tr("12336", 480, 645)];

test("alternative sections of one course never rule each other out", () => {
  const r = searchCombinations({
    groups: [
      { label: "GC 4061", sections: GC4061 },
      { label: "GC 4401", sections: GC4401 },
    ],
    fixed: [],
    busy: [],
  });
  assert.equal(r.count, 2);
  assert.deepEqual(r.combinations, [
    ["12332", "12336"],
    ["12333", "17915"],
  ]);
  assert.equal(r.complete, true);
  assert.deepEqual(r.blocking, []);
});

test("a busy block removes sections, with the reason", () => {
  const r = searchCombinations({
    groups: [
      { label: "GC 4061", sections: GC4061 },
      { label: "GC 4401", sections: GC4401 },
    ],
    fixed: [],
    busy: [
      {
        label: "GC 3401 (proposed)",
        meetings: ["T", "R"].map((day) => ({
          day,
          startMin: 600,
          endMin: 700,
        })),
      },
    ],
  });
  // Both TR sections are gone, leaving only the two MW sections, which clash.
  assert.equal(r.count, 0);
  assert.deepEqual(
    r.groups[0]!.excluded.map((x) => x.crn),
    ["12333"],
  );
  assert.match(r.groups[0]!.excluded[0]!.reason, /GC 3401 \(proposed\)/);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0]!.kind, "pair");
  assert.deepEqual(r.blocking[0]!.groups, ["GC 4061", "GC 4401"]);
});

test("a group emptied by fixed CRNs is named as the blocker", () => {
  const r = searchCombinations({
    groups: [
      { label: "GC 4061", sections: GC4061 },
      { label: "GC 4401", sections: GC4401 },
    ],
    fixed: [mw("19999", 700, 760), tr("19998", 500, 560)],
    busy: [],
  });
  assert.equal(r.count, 0);
  assert.deepEqual(
    r.blocking.map((b) => [b.kind, ...b.groups]),
    [
      ["group", "GC 4061"],
      ["group", "GC 4401"],
    ],
  );
  assert.match(r.groups[0]!.excluded[0]!.reason, /19999/);
});

test("every pair fits but all three cannot: said as such", () => {
  // A: {a1 M9, a2 M10}; B: {b1 M9, b2 M11}; C: {c1 M10, c2 M11}
  // A-B: a2+b1 / a1+b2 / a2+b2; A-C: a1+c1 ...; but each triple collides.
  const m = (crn: string, h: number): CombinationSection => ({
    crn,
    meetings: [{ day: "M", startMin: h * 60, endMin: h * 60 + 50 }],
  });
  const r = searchCombinations({
    groups: [
      { label: "A", sections: [m("a1", 9), m("a2", 10)] },
      { label: "B", sections: [m("b1", 9), m("b2", 10)] },
      { label: "C", sections: [m("c1", 9), m("c2", 10)] },
    ],
    fixed: [],
    busy: [],
  });
  assert.equal(r.count, 0);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0]!.kind, "all");
});

test("the listing is capped but the count is not", () => {
  const free = (p: string, n: number) =>
    Array.from({ length: n }, (_, i): CombinationSection => ({
      crn: `${p}${i}`,
      meetings: [],
    }));
  const r = searchCombinations({
    groups: [
      { label: "X", sections: free("x", 10) },
      { label: "Y", sections: free("y", 10) },
    ],
    fixed: [],
    busy: [],
  });
  assert.equal(r.count, 100);
  assert.equal(r.countCapped, false);
  assert.equal(r.combinations.length, 20);
});

test("a search that runs out of budget says so instead of reporting 0", () => {
  // Every pair of groups fits but no full set does, so the search must walk
  // a large tree to prove 0; a tiny budget stops it partway.
  const m = (crn: string, h: number): CombinationSection => ({
    crn,
    meetings: [{ day: "M", startMin: h * 60, endMin: h * 60 + 50 }],
  });
  const groups = Array.from({ length: 6 }, (_, g) => ({
    label: `G${g}`,
    sections: Array.from({ length: 5 }, (_, i) => m(`g${g}s${i}`, 8 + i)),
  }));
  const r = searchCombinations({ groups, fixed: [], busy: [], nodeBudget: 50 });
  assert.equal(r.complete, false);
  assert.deepEqual(r.blocking, []);
});

test("same-time alternatives of one course are both offered", () => {
  // Two lab sections at the identical hour are the common case; they are
  // alternatives, so their overlap with each other is irrelevant.
  const m = (crn: string, h: number): CombinationSection => ({
    crn,
    meetings: [{ day: "M", startMin: h * 60, endMin: h * 60 + 50 }],
  });
  const r = searchCombinations({
    groups: [
      { label: "LAB", sections: [m("l1", 9), m("l2", 9)] },
      { label: "LEC", sections: [m("c1", 10)] },
    ],
    fixed: [],
    busy: [],
  });
  assert.deepEqual(r.combinations, [
    ["l1", "c1"],
    ["l2", "c1"],
  ]);
});
