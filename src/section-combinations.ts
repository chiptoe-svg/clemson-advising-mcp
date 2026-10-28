// src/section-combinations.ts
// Which choice of one section per course fits together (2026-10-28).
//
// Each group holds ALTERNATIVE sections of one need ("a section of GC 4061"),
// so sections of the same group are never compared with each other: that
// comparison is what made find-conflict-free-schedule answer "none" for
// "which sections of A and B fit together". Fixed CRNs and busy blocks (work
// hours, a proposed meeting time) remove sections up front, each with its
// reason; a backtracking search then counts and lists the combinations.
//
// A zero always comes with why (`blocking`): a group emptied by the fixed
// CRNs/busy blocks, a pair of groups with no compatible pair of sections, or
// — when every pair fits — the plain statement that no choice fits all at
// once. A search that ran out of budget reports complete:false, never 0.

import { minsToHHMM } from "./clemson-schedule-db.js";

export interface CombinationMeeting {
  day: string;
  startMin: number;
  endMin: number;
}

export interface CombinationSection {
  crn: string;
  meetings: CombinationMeeting[];
}

export interface CombinationInput {
  groups: { label: string; sections: CombinationSection[] }[];
  fixed: CombinationSection[];
  busy: { label: string; meetings: CombinationMeeting[] }[];
  /** Combinations listed (the count is not limited by this). */
  listLimit?: number;
  /** Stop counting here and report countCapped. */
  countCap?: number;
  /** Search steps before giving up with complete:false. */
  nodeBudget?: number;
}

export interface Blocking {
  /** group: emptied by fixed/busy; pair: no compatible pair; all: only together. */
  kind: "group" | "pair" | "all";
  groups: string[];
  reason: string;
}

export interface CombinationResult {
  groups: {
    label: string;
    eligible: string[];
    excluded: { crn: string; reason: string }[];
  }[];
  count: number;
  countCapped: boolean;
  combinations: string[][];
  /** False when the node budget ran out: count is then a lower bound. */
  complete: boolean;
  blocking: Blocking[];
}

/** The first overlap between two meeting lists, described; null if none. */
export function firstOverlap(
  a: readonly CombinationMeeting[],
  b: readonly CombinationMeeting[],
): string | null {
  for (const x of a)
    for (const y of b)
      if (x.day === y.day && x.startMin < y.endMin && y.startMin < x.endMin)
        return `${x.day} ${minsToHHMM(Math.max(x.startMin, y.startMin))}–${minsToHHMM(Math.min(x.endMin, y.endMin))}`;
  return null;
}

export function searchCombinations(input: CombinationInput): CombinationResult {
  const listLimit = input.listLimit ?? 20;
  const countCap = input.countCap ?? 10_000;
  const nodeBudget = input.nodeBudget ?? 500_000;

  const blockers = [
    ...input.fixed.map((f) => ({
      name: `fixed CRN ${f.crn}`,
      meetings: f.meetings,
    })),
    ...input.busy.map((b) => ({
      name: `busy block "${b.label}"`,
      meetings: b.meetings,
    })),
  ];

  const groups = input.groups.map((g) => {
    const eligible: CombinationSection[] = [];
    const excluded: { crn: string; reason: string }[] = [];
    for (const s of g.sections) {
      let reason: string | null = null;
      for (const b of blockers) {
        const o = firstOverlap(s.meetings, b.meetings);
        if (o) {
          reason = `overlaps ${b.name} (${o})`;
          break;
        }
      }
      if (reason) excluded.push({ crn: s.crn, reason });
      else eligible.push(s);
    }
    return { label: g.label, eligible, excluded };
  });

  const blocking: Blocking[] = [];
  for (const g of groups)
    if (g.eligible.length === 0)
      blocking.push({
        kind: "group",
        groups: [g.label],
        reason:
          g.excluded.length === 0
            ? `${g.label} has no sections to choose from`
            : `every section of ${g.label} overlaps a fixed CRN or busy block: ` +
              g.excluded.map((x) => `${x.crn} ${x.reason}`).join("; "),
      });

  const result = (
    count: number,
    countCapped: boolean,
    combinations: string[][],
    complete: boolean,
  ): CombinationResult => ({
    groups: groups.map((g) => ({
      label: g.label,
      eligible: g.eligible.map((s) => s.crn),
      excluded: g.excluded,
    })),
    count,
    countCapped,
    combinations,
    complete,
    blocking,
  });

  if (blocking.length > 0) return result(0, false, [], true);

  // Pairs of groups with no compatible pair of sections.
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      const A = groups[i]!;
      const B = groups[j]!;
      const clashes: string[] = [];
      let fits = false;
      for (const a of A.eligible) {
        for (const b of B.eligible) {
          const o = firstOverlap(a.meetings, b.meetings);
          if (!o) {
            fits = true;
            break;
          }
          if (clashes.length < 6) clashes.push(`${a.crn}×${b.crn} ${o}`);
        }
        if (fits) break;
      }
      if (!fits)
        blocking.push({
          kind: "pair",
          groups: [A.label, B.label],
          reason: `no section of ${A.label} fits with any section of ${B.label}: ${clashes.join("; ")}`,
        });
    }
  if (blocking.length > 0) return result(0, false, [], true);

  const combinations: string[][] = [];
  const chosen: CombinationSection[] = [];
  let count = 0;
  let nodes = 0;
  let stopped: "cap" | "budget" | null = null;

  const walk = (gi: number): void => {
    if (stopped) return;
    if (gi === groups.length) {
      count++;
      if (combinations.length < listLimit)
        combinations.push(chosen.map((s) => s.crn));
      if (count >= countCap) stopped = "cap";
      return;
    }
    for (const s of groups[gi]!.eligible) {
      if (++nodes > nodeBudget) {
        stopped = "budget";
        return;
      }
      if (chosen.some((c) => firstOverlap(c.meetings, s.meetings))) continue;
      chosen.push(s);
      walk(gi + 1);
      chosen.pop();
      if (stopped) return;
    }
  };
  walk(0);

  const complete = stopped !== "budget";
  if (complete && count === 0)
    blocking.push({
      kind: "all",
      groups: groups.map((g) => g.label),
      reason:
        "every pair of these courses has sections that fit together, but no " +
        "single choice of one section each fits all of them at once",
    });
  return result(count, stopped === "cap", combinations, complete);
}
