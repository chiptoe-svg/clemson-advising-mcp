// src/plan-whatif.ts
// "What happens to graduation if the plan changes?" — computed from the
// program graph, never left to a model to derive (Cob_advisor T8b,
// 2026-10-20: models given the graph still answered wrong 3-7 times in 8).
// Changes: move a course later or earlier, skip a term. Measured against the
// PUBLISHED plan's term order: not course load, not a guarantee of
// offerings, not requirement satisfaction (Degree Works).

import { parsePrereq, type Expr } from "./prereq-expr.js";
import type { ProgramGraph } from "./program-graph.js";

type Season = "fall" | "spring" | "summer";
export type SeasonLabels = Partial<Record<Season, string>>;

const YEARS = [
  "Freshman",
  "Sophomore",
  "Junior",
  "Senior",
  "Fifth Year",
  "Sixth Year",
  "Seventh Year",
];
const PARTS = ["First Semester", "Second Semester", "Summer"];
const SEASONS: Season[] = ["fall", "spring", "summer"];
const OFFERED = new Set(["very likely", "likely", "confirmed"]);
const RISKY = new Set(["uncertain"]);
/** How far past the plan's last term to search before giving up. */
const HORIZON = 12;
const MAX_CHANGES = 6;
/** Course pairs at most one of which may be in a summer, in any years.
 *  GC (Chip, 2026-11-10): either internship may be a summer, never both;
 *  the published plan shows both in summers only because of how it can be
 *  displayed. */
const ONE_SUMMER_OF: readonly (readonly string[])[] = [["GC 3500", "GC 4500"]];

/** Senior/First Semester: a plan that ends before it has no graduation. */
const SENIOR_FALL = 9;

/** "Junior/First Semester" -> 6 (calendar order: fall, spring, summer). */
export function slotOf(label: string): number | null {
  const m = /^(?:Pre-Business )?([^/]+)\/(.+)$/.exec(label.trim());
  if (!m) return null;
  const y = YEARS.indexOf(m[1]);
  const p = PARTS.indexOf(m[2]);
  return y < 0 || p < 0 ? null : y * 3 + p;
}

export function labelOf(slot: number): string {
  const y = Math.floor(slot / 3);
  return `${YEARS[y] ?? `Year ${y + 1}`}/${PARTS[slot % 3]}`;
}

export type PlanChange =
  | { course: string; delayTerms?: number; moveTo?: string }
  | { skipTerm: string };

export interface WhatIfQuery {
  changes: PlanChange[];
  completed: ReadonlySet<string>;
  /** The student's current plan term ("Junior/Second Semester"): courses
   *  planned before it and not completed move to the first term they can use
   *  at or after it, and every answer is measured from that rebased plan. */
  now?: string;
  /** Completed courses known to have been taken in a summer (for
   *  ONE_SUMMER_OF); a completed course not listed is not assumed either way. */
  completedInSummer?: ReadonlySet<string>;
}

export interface PlanMove {
  code: string;
  from: string;
  to: string;
  because: string;
  risk?: string;
  only_if_chosen?: true;
}

export interface WhatIfResult {
  slips_graduation: boolean;
  graduation_term: string;
  new_graduation_term: string;
  moves: PlanMove[];
  prereq_problems: { course: string; term: string; problem: string }[];
  on_critical_path: string[];
  /** Only with `now`: where each overdue course lands. */
  behind?: PlanMove[];
  /** Only with `now`: the published plan's graduation term. */
  plan_graduation_term?: string;
  /** Only with `now`: fall/spring terms graduation has already slipped
   *  before any change (a summer finish counts as one); 0 = on plan. */
  graduation_slip_terms?: number;
  verdict: string;
  assumptions: string[];
  unresolved: string[];
  caveat: string;
}

const AS_ASKED = "moved as asked";

export function whatIf(
  graph: ProgramGraph,
  planTerms: string[],
  q: WhatIfQuery,
  seasons?: ReadonlyMap<string, SeasonLabels>,
): WhatIfResult {
  const caveat =
    `Measured against the published ${graph.catalog_year} plan's term order, ` +
    "not the student's own schedule. It does not check course load or credit " +
    "limits; seasons are offering history, not a guarantee; Degree Works " +
    "decides what counts toward the degree.";
  const assumptions: string[] = [];
  const unresolved: string[] = [];

  if (q.changes.length === 0 && q.now === undefined)
    throw new Error(
      "changes is empty — give at least one course move or skipped term",
    );
  if (q.changes.length > MAX_CHANGES)
    throw new Error(`at most ${MAX_CHANGES} changes at once`);

  let finalSlot = -1;
  for (const t of planTerms) {
    const s = slotOf(t);
    if (s === null)
      throw new Error(`plan term "${t}" is not a recognised term label`);
    finalSlot = Math.max(finalSlot, s);
  }
  if (finalSlot < SENIOR_FALL)
    throw new Error(
      `this plan runs only through ${labelOf(finalSlot)} and does not reach a senior year, so there is no graduation term to measure a slip against (it is likely a pre-major plan)`,
    );
  const limit = finalSlot + HORIZON;
  const nowSlot = q.now === undefined ? 0 : slotOf(q.now);
  if (nowSlot === null)
    throw new Error(
      `current_term "${q.now}" is not a recognised plan term label (e.g. "Junior/Second Semester")`,
    );

  const byCode = new Map(graph.courses.map((c) => [c.code, c]));
  const slot = new Map<string, number>();
  const original = new Map<string, number>();
  // With a current term, a choice the student already made is settled: its
  // other options are not overdue.
  const settled = new Set<string>();
  if (q.now !== undefined)
    for (const ch of graph.choices) {
      const opts = ch.options.map((o) => o.code);
      if (opts.some((o) => q.completed.has(o)))
        for (const o of opts) settled.add(o);
    }
  for (const c of graph.courses) {
    if (c.planned === null || q.completed.has(c.code) || settled.has(c.code))
      continue;
    const s = slotOf(c.planned);
    if (s === null)
      throw new Error(
        `plan term "${c.planned}" is not a recognised term label`,
      );
    slot.set(c.code, s);
    original.set(c.code, s);
  }
  // The published term, kept apart from `original` (which `now` rebases):
  // whether a course may go in a summer follows the plan, not the rebase.
  const published = new Map(original);
  const summerPlanned = (code: string) => (published.get(code) ?? 0) % 3 === 2;

  const skipped = new Set<number>();
  for (const ch of q.changes)
    if ("skipTerm" in ch) {
      const s = slotOf(ch.skipTerm);
      if (s === null)
        throw new Error(
          `skip_term "${ch.skipTerm}" is not a recognised term label`,
        );
      skipped.add(s);
    }

  const assumed = new Set<string>();
  if (!seasons)
    assumptions.push(
      "No offering history was available: every course was assumed to run every fall and spring.",
    );
  const partnerInSummer = (code: string) =>
    ONE_SUMMER_OF.some(
      (pair) =>
        pair.includes(code) &&
        pair.some(
          (p) =>
            p !== code &&
            ((slot.get(p) ?? 0) % 3 === 2 ||
              (q.completedInSummer?.has(p) ?? false)),
        ),
    );
  const placeable = (code: string, s: number) =>
    s >= nowSlot &&
    !skipped.has(s) &&
    (s % 3 !== 2 || (summerPlanned(code) && !partnerInSummer(code)));
  const usableSeasons = (code: string): Season[] =>
    summerPlanned(code) ? SEASONS : ["fall", "spring"];
  const offerState = (code: string, s: number): "yes" | "risky" | "no" => {
    const season = SEASONS[s % 3];
    const labels = seasons?.get(code);
    const known =
      labels !== undefined &&
      Object.values(labels).some((l) => l && l !== "no basis");
    const state = (l: string | undefined) =>
      l && OFFERED.has(l) ? "yes" : l && RISKY.has(l) ? "risky" : "no";
    // No history, or no season this course could use is offered any more
    // (a discontinued course): assume fall and spring, and say so, rather
    // than sink the whole answer (review 6: ENGL 3040, 2024-2025 plans).
    const current =
      known && usableSeasons(code).some((x) => state(labels![x]) !== "no");
    if (!current) {
      if (seasons && !assumed.has(code)) {
        assumed.add(code);
        assumptions.push(
          known
            ? `${code} has not been offered recently in any term it could move to: assumed to run every fall and spring — check with the department or plan a substitute.`
            : `${code} has no offering history: assumed to run every fall and spring.`,
        );
      }
      return season === "summer" && !summerPlanned(code) ? "no" : "yes";
    }
    return state(labels![season]);
  };
  const riskText = (code: string, s: number) =>
    `${code} is only "uncertain" in ${SEASONS[s % 3]}`;

  // Corequisites share a term: every planned, not-completed course linked by
  // a corequisite either way is placed as one group (review 1, 2).
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b || !slot.has(a) || !slot.has(b)) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const c of graph.courses)
    for (const k of c.coreqs ?? []) link(c.code, k);
  const groupOf = (code: string): string[] => {
    const seen = new Set([code]);
    const todo = [code];
    while (todo.length)
      for (const n of adj.get(todo.pop()!) ?? [])
        if (!seen.has(n)) {
          seen.add(n);
          todo.push(n);
        }
    return [...seen];
  };

  /** First slot >= from where every member may go and is offered. */
  const placeGroup = (
    codes: string[],
    from: number,
  ): { at: number; notOffered: Season[]; risk?: string } => {
    const notOffered: Season[] = [];
    for (let s = from; s <= limit; s++) {
      if (!codes.every((c) => placeable(c, s))) continue;
      const states = codes.map((c) => offerState(c, s));
      if (states.includes("no")) {
        notOffered.push(SEASONS[s % 3]);
        continue;
      }
      const risky = codes.filter((_, i) => states[i] === "risky");
      return {
        at: s,
        notOffered,
        ...(risky.length
          ? { risk: risky.map((c) => riskText(c, s)).join("; ") }
          : {}),
      };
    }
    throw new Error(
      `could not place ${codes.join(" + ")} within ${HORIZON} terms after the plan ends — check its prerequisites and offerings`,
    );
  };
  const offeredNote = (p: { notOffered: Season[] }) =>
    p.notOffered.length
      ? `; not usually offered in ${[...new Set(p.notOffered)].join(", ")}`
      : "";

  const because = new Map<string, string>();
  const risks = new Map<string, string>();
  const setSlot = (code: string, s: number, why: string, risk?: string) => {
    slot.set(code, s);
    because.set(code, why);
    if (risk) risks.set(code, risk);
  };
  /** Put a whole group in one slot; `lead` gets `why`, the rest follow it. */
  const setGroup = (
    group: string[],
    lead: string,
    at: number,
    why: string,
    risk?: string,
    leads: ReadonlySet<string> = new Set([lead]),
  ) => {
    for (const c of group)
      if (slot.get(c) !== at || leads.has(c))
        setSlot(
          c,
          at,
          leads.has(c) ? why : `taken with ${lead} (corequisite)`,
          risk,
        );
  };
  const pinned = new Set<string>();
  const explicit = new Set<string>();

  /** An exact term for a whole group, or an error naming who cannot go. */
  const exactly = (code: string, group: string[], s: number) => {
    for (const c of group) {
      const who = c === code ? c : `${c} (taken with ${code})`;
      if (s < nowSlot)
        throw new Error(
          `${code} cannot move to ${labelOf(s)}: that is before the current term (${labelOf(nowSlot)})`,
        );
      if (!placeable(c, s))
        throw new Error(
          `${code} cannot move to ${labelOf(s)}: ${skipped.has(s) ? "that term is skipped" : summerPlanned(c) && partnerInSummer(c) ? `only one of ${ONE_SUMMER_OF.find((p) => p.includes(c))!.join(" and ")} may be in a summer` : `${who === code ? "it" : who} is not planned in a summer`}`,
        );
      if (offerState(c, s) === "no")
        throw new Error(
          `${who} is not usually offered in ${SEASONS[s % 3]}, so ${code} cannot move to ${labelOf(s)}`,
        );
    }
    const risky = group.filter((c) => offerState(c, s) === "risky");
    return risky.length
      ? risky.map((c) => riskText(c, s)).join("; ")
      : undefined;
  };

  // Push everything whose prerequisites can no longer be met.
  const need = (e: Expr): { at: number; by?: string } => {
    switch (e.t) {
      case "course": {
        const s = slot.get(e.code);
        if (s === undefined) return { at: -Infinity };
        return { at: e.concurrent ? s : s + 1, by: e.code };
      }
      case "and":
        return e.of
          .map(need)
          .reduce((a, b) => (b.at > a.at ? b : a), { at: -Infinity });
      case "or":
        return e.of
          .map(need)
          .reduce((a, b) => (b.at < a.at ? b : a), { at: Infinity });
      default:
        return { at: -Infinity };
    }
  };
  const parsed = parsedRules(graph);

  const propagate = () => {
    let changed = true;
    let rounds = 0;
    while (changed) {
      changed = false;
      if (++rounds > graph.courses.length + HORIZON)
        throw new Error(
          "could not place the affected courses — the prerequisite data may contain a cycle",
        );
      for (const c of graph.courses) {
        const at = slot.get(c.code);
        const e = parsed.get(c.code);
        if (at === undefined || !e || pinned.has(c.code)) continue;
        const n = need(e);
        if (!(n.at > at)) continue;
        const group = groupOf(c.code);
        if (group.some((g) => pinned.has(g))) continue;
        const p = placeGroup(group, n.at);
        const by = n.by
          ? `needs ${n.by} (now ${labelOf(slot.get(n.by)!)})`
          : "prerequisites";
        setGroup(group, c.code, p.at, by + offeredNote(p), p.risk);
        changed = true;
      }
    }
  };

  // 0. The student's current term: everything planned before it and not
  // completed moves to the first term it can use at or after it, and then
  // that rebased plan is the baseline every later step measures from.
  const planFinal = finalSlot;
  let behind: PlanMove[] | undefined;
  if (q.now !== undefined) {
    const done = new Set<string>();
    for (const [code] of [...slot.entries()].sort((a, b) => a[1] - b[1])) {
      if (slot.get(code)! >= nowSlot || done.has(code)) continue;
      const group = groupOf(code);
      for (const g of group) done.add(g);
      const p = placeGroup(group, nowSlot);
      setGroup(
        group,
        code,
        p.at,
        `planned before ${labelOf(nowSlot)} and not completed${offeredNote(p)}`,
        p.risk,
        new Set(group.filter((g) => slot.get(g)! < nowSlot)),
      );
    }
    propagate();
    behind = [...slot.keys()]
      .filter((c) => slot.get(c) !== original.get(c))
      .sort((a, b) => original.get(a)! - original.get(b)! || a.localeCompare(b))
      .map((code) => ({
        code,
        from: labelOf(original.get(code)!),
        to: labelOf(slot.get(code)!),
        because: because.get(code) ?? "",
        ...(risks.has(code) ? { risk: risks.get(code)! } : {}),
        ...(byCode.get(code)?.choice ? { only_if_chosen: true as const } : {}),
      }));
    for (const m of behind)
      if (!m.only_if_chosen) finalSlot = Math.max(finalSlot, slot.get(m.code)!);
    for (const [c, at] of slot) original.set(c, at);
    because.clear();
    risks.clear();
  }

  // 1. Explicit course moves. move_to (earlier or later) is exact; a delay
  // counts from the PLAN term and goes to the first term the whole
  // corequisite group can use (review 1, 3).
  const fixedGroups = new Map<string, number>();
  const pending = new Map<string, { group: string[]; wanted: number }>();
  const keyOf = (g: string[]) => [...g].sort().join("+");
  for (const ch of q.changes) {
    if (!("course" in ch)) continue;
    const code = ch.course;
    if (explicit.has(code))
      throw new Error(`${code} appears in more than one change`);
    explicit.add(code);
    const c = byCode.get(code);
    if (!c || c.planned === null)
      throw new Error(
        `${code} is not in the ${graph.catalog_year} ${graph.program} plan`,
      );
    if (q.completed.has(code))
      throw new Error(`${code} is already completed — nothing to move`);
    if (settled.has(code))
      throw new Error(
        `${code} is an option of a choice the student already completed — nothing to move`,
      );
    const from = original.get(code)!;
    const hasDelay = ch.delayTerms !== undefined;
    const hasMove = ch.moveTo !== undefined;
    if (hasDelay === hasMove)
      throw new Error(`${code}: give exactly one of delay_terms or move_to`);
    const group = groupOf(code);
    const key = keyOf(group);
    if (hasMove) {
      const s = slotOf(ch.moveTo!);
      if (s === null)
        throw new Error(
          `move_to "${ch.moveTo}" is not a recognised term label`,
        );
      if (s === from)
        throw new Error(`${code} is already planned in ${labelOf(from)}`);
      if (
        pending.has(key) ||
        (fixedGroups.has(key) && fixedGroups.get(key) !== s)
      )
        throw new Error(
          `${group.join(" and ")} are corequisites — move them together, to the same term`,
        );
      const risk = exactly(code, group, s);
      fixedGroups.set(key, s);
      const leads = new Set(group.filter((g) => explicit.has(g)));
      setGroup(
        group,
        code,
        s,
        s < from ? "moved earlier, as asked" : AS_ASKED,
        risk,
        leads,
      );
      if (s < from) for (const g of group) pinned.add(g);
      continue;
    }
    const n = ch.delayTerms!;
    if (!Number.isInteger(n) || n < 1 || n > 6)
      throw new Error(
        `${code}: delay_terms must be a whole number from 1 to 6`,
      );
    if (fixedGroups.has(key))
      throw new Error(
        `${group.join(" and ")} are corequisites — move them together, the same way`,
      );
    let wanted = from;
    for (let k = 0; k < n;) {
      wanted++;
      if (placeable(code, wanted)) k++;
    }
    const prev = pending.get(key);
    pending.set(key, { group, wanted: Math.max(wanted, prev?.wanted ?? 0) });
  }
  for (const { group, wanted } of pending.values()) {
    const p = placeGroup(group, wanted);
    const leads = new Set(group.filter((g) => explicit.has(g)));
    setGroup(
      group,
      [...leads][0],
      p.at,
      AS_ASKED + offeredNote(p),
      p.risk,
      leads,
    );
  }

  // 2. Skipped terms displace what was planned in them.
  const emptySkips: string[] = [];
  for (const s of skipped) {
    const there = [...slot.entries()]
      .filter(([code, at]) => at === s && !pinned.has(code))
      .map(([code]) => code);
    if (there.length === 0 && ![...slot.values()].includes(s))
      emptySkips.push(labelOf(s));
    const done = new Set<string>();
    for (const code of there) {
      if (done.has(code)) continue;
      const group = groupOf(code);
      for (const g of group) done.add(g);
      const p = placeGroup(group, s + 1);
      setGroup(
        group,
        code,
        p.at,
        `${labelOf(s)} is skipped${offeredNote(p)}`,
        p.risk,
        new Set(group.filter((g) => slot.get(g) === s)),
      );
    }
  }

  // 3. Push everything whose prerequisites can no longer be met.
  propagate();

  // 4. Earlier moves are checked, never pushed.
  const prereq_problems: WhatIfResult["prereq_problems"] = [];
  for (const code of pinned) {
    const floor = byCode.get(code)?.standing_floor;
    const fs = floor ? slotOf(floor) : null;
    if (fs !== null && slot.get(code)! < fs)
      prereq_problems.push({
        course: code,
        term: labelOf(slot.get(code)!),
        problem: `${code} has a class-standing requirement this plan first meets in ${floor}`,
      });
    const e = parsed.get(code);
    if (!e) continue;
    const n = need(e);
    if (n.at > slot.get(code)! && n.by)
      prereq_problems.push({
        course: code,
        term: labelOf(slot.get(code)!),
        problem: `${code} in ${labelOf(slot.get(code)!)} needs ${n.by}, which is planned in ${labelOf(slot.get(n.by)!)}`,
      });
  }

  for (const pair of ONE_SUMMER_OF)
    if (pair.every((p) => slot.has(p) && slot.get(p)! % 3 === 2))
      assumptions.push(
        `${pair.join(" and ")} are both in summers here, as the published plan shows them, but only one of them may be in a summer — plan the other in a fall or spring.`,
      );

  const movedCodes = [...slot.keys()].filter(
    (c) => slot.get(c) !== original.get(c),
  );
  const movedSet = new Set(movedCodes);
  for (const c of graph.courses) {
    if (!slot.has(c.code)) continue;
    const e = parsed.get(c.code);
    if (
      e &&
      (movedSet.has(c.code) || courseLeaves(e).some((l) => movedSet.has(l)))
    )
      for (const t of unknownText(e))
        unresolved.push(
          `${c.code}: also requires "${t}" — confirm it separately`,
        );
    if (!e && (c.parse === "unparsed" || c.parse === "stale")) {
      const text = c.prereq_text ?? "";
      const named = movedCodes.filter((m) => text.includes(m));
      if (named.length)
        unresolved.push(
          `${c.code}: its prerequisite rule could not be read (${c.parse}) and mentions ${named.join(", ")} — check whether it must move too`,
        );
    }
  }

  const moves: PlanMove[] = movedCodes
    .sort((a, b) => original.get(a)! - original.get(b)! || a.localeCompare(b))
    .map((code) => ({
      code,
      from: labelOf(original.get(code)!),
      to: labelOf(slot.get(code)!),
      because: because.get(code) ?? "",
      ...(risks.has(code) ? { risk: risks.get(code)! } : {}),
      ...(byCode.get(code)?.choice ? { only_if_chosen: true as const } : {}),
    }));

  const firm = moves.filter((m) => !m.only_if_chosen);
  const chosen = moves.filter((m) => m.only_if_chosen);
  const newFinal = Math.max(finalSlot, ...firm.map((m) => slot.get(m.code)!));
  const slips = newFinal > finalSlot;
  const fmt = (m: PlanMove) =>
    `${m.code} ${m.from} -> ${m.to}${m.because === AS_ASKED ? "" : ` (${m.because})`}${m.risk ? ` [${m.risk}]` : ""}`;
  const parts: string[] = [];
  const slipTerms = behind && countTerms(planFinal, finalSlot);
  if (behind)
    parts.push(
      slipTerms
        ? `Already ${slipTerms} term${slipTerms === 1 ? "" : "s"} behind the published plan: graduation is now ${labelOf(finalSlot)}, not ${labelOf(planFinal)}.`
        : `On track for ${labelOf(planFinal)} from ${labelOf(nowSlot)}${behind.length ? ` once ${behind.length} overdue course${behind.length === 1 ? " is" : "s are"} placed` : ""}.`,
    );
  if (prereq_problems.length)
    parts.push(
      `Not possible as asked: ${prereq_problems.map((p) => p.problem).join("; ")}.`,
    );
  parts.push(
    (slips
      ? `Graduation slips from ${labelOf(finalSlot)} to ${labelOf(newFinal)}`
      : `Graduation does not slip (still ${labelOf(finalSlot)})`) +
      (firm.length ? `: ${firm.map(fmt).join("; ")}.` : "."),
  );
  if (
    firm.length &&
    firm.every(
      (m) => explicit.has(m.code) || m.because.startsWith("taken with"),
    )
  )
    parts.push("Nothing else in the plan has to move.");
  for (const t of emptySkips) parts.push(`Nothing was planned in ${t}.`);
  if (chosen.length)
    parts.push(`Only if chosen: ${chosen.map(fmt).join("; ")}.`);

  return {
    slips_graduation: slips,
    graduation_term: labelOf(finalSlot),
    new_graduation_term: labelOf(newFinal),
    moves,
    prereq_problems,
    on_critical_path: [...explicit].filter((c) =>
      graph.critical_path.includes(c),
    ),
    ...(behind
      ? {
          behind,
          plan_graduation_term: labelOf(planFinal),
          graduation_slip_terms: slipTerms!,
        }
      : {}),
    verdict: parts.join(" "),
    assumptions,
    unresolved,
    caveat,
  };
}

/** Fall/spring terms from `from` to `to`; a summer finish counts as one. */
function countTerms(from: number, to: number): number {
  let n = 0;
  for (let s = from + 1; s <= to; s++) if (s % 3 !== 2) n++;
  return n + (to > from && to % 3 === 2 ? 1 : 0);
}

/**
 * How many fall/spring terms a planned course can slip before graduation
 * does: the largest k <= cap whose delay does not slip graduation. cap means
 * "cap or more"; undefined when the engine cannot answer at all.
 */
export function slackTerms(
  graph: ProgramGraph,
  planTerms: string[],
  code: string,
  completed: ReadonlySet<string>,
  seasons?: ReadonlyMap<string, SeasonLabels>,
  opts: {
    cap?: number;
    now?: string;
    completedInSummer?: ReadonlySet<string>;
  } = {},
): number | undefined {
  const cap = opts.cap ?? 4;
  for (let k = 1; k <= cap; k++) {
    try {
      const r = whatIf(
        graph,
        planTerms,
        {
          changes: [{ course: code, delayTerms: k }],
          completed,
          ...(opts.now !== undefined ? { now: opts.now } : {}),
          completedInSummer: opts.completedInSummer,
        },
        seasons,
      );
      if (r.slips_graduation) return k - 1;
    } catch {
      // Unanswerable (no senior year, bad data): absent, never a false 0.
      return undefined;
    }
  }
  return cap;
}

/** Parsed rules per graph, cached: slackTerms runs whatIf up to 4 times per
 *  course, and re-parsing every rule each time tripled get-program-graph's
 *  time (2.7 -> 7.4 ms on GC BS). */
const parseCache = new WeakMap<ProgramGraph, Map<string, Expr>>();
function parsedRules(graph: ProgramGraph): Map<string, Expr> {
  let m = parseCache.get(graph);
  if (!m) {
    m = new Map();
    for (const c of graph.courses)
      if (c.prereq && (c.parse === "complete" || c.parse === "partial"))
        m.set(c.code, parsePrereq(c.prereq));
    parseCache.set(graph, m);
  }
  return m;
}

function courseLeaves(e: Expr): string[] {
  return e.t === "course"
    ? [e.code]
    : e.t === "and" || e.t === "or"
      ? e.of.flatMap(courseLeaves)
      : [];
}

function unknownText(e: Expr): string[] {
  return e.t === "unknown"
    ? [e.text]
    : e.t === "and" || e.t === "or"
      ? e.of.flatMap(unknownText)
      : [];
}
