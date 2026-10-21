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

  if (q.changes.length === 0)
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
  const limit = finalSlot + HORIZON;

  const byCode = new Map(graph.courses.map((c) => [c.code, c]));
  const slot = new Map<string, number>();
  const original = new Map<string, number>();
  for (const c of graph.courses) {
    if (c.planned === null || q.completed.has(c.code)) continue;
    const s = slotOf(c.planned);
    if (s === null)
      throw new Error(
        `plan term "${c.planned}" is not a recognised term label`,
      );
    slot.set(c.code, s);
    original.set(c.code, s);
  }
  const summerPlanned = (code: string) => (original.get(code) ?? 0) % 3 === 2;

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
  const offerState = (code: string, s: number): "yes" | "risky" | "no" => {
    const season = SEASONS[s % 3];
    const labels = seasons?.get(code);
    const known =
      labels !== undefined &&
      Object.values(labels).some((l) => l && l !== "no basis");
    if (!known) {
      if (seasons && !assumed.has(code)) {
        assumed.add(code);
        assumptions.push(
          `${code} has no offering history: assumed to run every fall and spring.`,
        );
      }
      return season === "summer" ? "no" : "yes";
    }
    const l = labels![season];
    if (l && OFFERED.has(l)) return "yes";
    if (l && RISKY.has(l)) return "risky";
    return "no";
  };
  const placeable = (code: string, s: number) =>
    !skipped.has(s) && (s % 3 !== 2 || summerPlanned(code));
  const riskText = (code: string, s: number) =>
    `${code} is only "uncertain" in ${SEASONS[s % 3]}`;

  /** First slot >= from where the course may go and is offered. */
  const place = (
    code: string,
    from: number,
  ): { at: number; notOffered: Season[]; risk?: string } => {
    const notOffered: Season[] = [];
    for (let s = from; s <= limit; s++) {
      if (!placeable(code, s)) continue;
      const o = offerState(code, s);
      if (o === "no") {
        notOffered.push(SEASONS[s % 3]);
        continue;
      }
      return {
        at: s,
        notOffered,
        ...(o === "risky" ? { risk: riskText(code, s) } : {}),
      };
    }
    throw new Error(
      `could not place ${code} within ${HORIZON} terms after the plan ends — check its prerequisites and offerings`,
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
  const pinned = new Set<string>();
  const explicit = new Set<string>();
  const withCoreqs = (code: string) => {
    for (const k of byCode.get(code)?.coreqs ?? []) {
      const ks = slot.get(k);
      if (ks === undefined || ks === slot.get(code) || explicit.has(k))
        continue;
      setSlot(k, slot.get(code)!, `taken with ${code} (corequisite)`);
      if (pinned.has(code)) pinned.add(k);
    }
  };

  // 1. Explicit course moves.
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
    const from = slot.get(code)!;
    const hasDelay = ch.delayTerms !== undefined;
    const hasMove = ch.moveTo !== undefined;
    if (hasDelay === hasMove)
      throw new Error(`${code}: give exactly one of delay_terms or move_to`);
    let wanted: number;
    if (hasMove) {
      const s = slotOf(ch.moveTo!);
      if (s === null)
        throw new Error(
          `move_to "${ch.moveTo}" is not a recognised term label`,
        );
      if (s === from)
        throw new Error(`${code} is already planned in ${labelOf(from)}`);
      if (s < from) {
        if (!placeable(code, s))
          throw new Error(
            `${code} cannot move to ${labelOf(s)}: that term is skipped, or is a summer this course is not planned in`,
          );
        const o = offerState(code, s);
        if (o === "no")
          throw new Error(
            `${code} is not usually offered in ${SEASONS[s % 3]}, so it cannot move to ${labelOf(s)}`,
          );
        setSlot(
          code,
          s,
          "moved earlier, as asked",
          o === "risky" ? riskText(code, s) : undefined,
        );
        pinned.add(code);
        withCoreqs(code);
        continue;
      }
      wanted = s;
    } else {
      const n = ch.delayTerms!;
      if (!Number.isInteger(n) || n < 1 || n > 6)
        throw new Error(
          `${code}: delay_terms must be a whole number from 1 to 6`,
        );
      wanted = from;
      for (let k = 0; k < n;) {
        wanted++;
        if (placeable(code, wanted)) k++;
      }
    }
    const p = place(code, wanted);
    setSlot(code, p.at, AS_ASKED + offeredNote(p), p.risk);
    withCoreqs(code);
  }

  // 2. Skipped terms displace what was planned in them.
  const emptySkips: string[] = [];
  for (const s of skipped) {
    const there = [...slot.entries()]
      .filter(([code, at]) => at === s && !pinned.has(code))
      .map(([code]) => code);
    if (there.length === 0 && ![...slot.values()].includes(s))
      emptySkips.push(labelOf(s));
    for (const code of there) {
      const p = place(code, s + 1);
      setSlot(code, p.at, `${labelOf(s)} is skipped${offeredNote(p)}`, p.risk);
    }
    for (const code of there) withCoreqs(code);
  }

  // 3. Push everything whose prerequisites can no longer be met.
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
  const parsed = new Map<string, Expr>();
  for (const c of graph.courses)
    if (c.prereq && (c.parse === "complete" || c.parse === "partial"))
      parsed.set(c.code, parsePrereq(c.prereq));

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
      const p = place(c.code, n.at);
      const by = n.by
        ? `needs ${n.by} (now ${labelOf(slot.get(n.by)!)})`
        : "prerequisites";
      setSlot(c.code, p.at, by + offeredNote(p), p.risk);
      withCoreqs(c.code);
      changed = true;
    }
  }

  // 4. Earlier moves are checked, never pushed.
  const prereq_problems: WhatIfResult["prereq_problems"] = [];
  for (const code of pinned) {
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
    `${m.code} ${m.from} -> ${m.to}${m.because.startsWith(AS_ASKED) ? "" : ` (${m.because})`}`;
  const parts: string[] = [];
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
    verdict: parts.join(" "),
    assumptions,
    unresolved,
    caveat,
  };
}

/**
 * How many fall/spring terms a planned course can slip before graduation
 * does: the largest k <= cap whose delay neither slips nor errors. cap means
 * "cap or more".
 */
export function slackTerms(
  graph: ProgramGraph,
  planTerms: string[],
  code: string,
  completed: ReadonlySet<string>,
  seasons?: ReadonlyMap<string, SeasonLabels>,
  cap = 4,
): number {
  for (let k = 1; k <= cap; k++) {
    try {
      const r = whatIf(
        graph,
        planTerms,
        { changes: [{ course: code, delayTerms: k }], completed },
        seasons,
      );
      if (r.slips_graduation) return k - 1;
    } catch {
      return k - 1;
    }
  }
  return cap;
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
