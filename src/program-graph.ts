// src/program-graph.ts
// One major x catalog year as a graph: requirement nodes (Degree Works when
// imported, else the catalog plan's slots and choices), course nodes, and the
// prerequisite edges between courses, read from the reviewed expressions in
// prereq_expression (src/prereq-expr.ts notation).
//
// The prerequisite layer is stored ONCE for the whole university (one
// snapshot; Banner enforces the current rule regardless of catalog year); a
// major's graph is a view assembled per request. Nothing here decides whether
// a requirement is satisfied — that is a degree audit, which belongs to the
// advisor and to Degree Works.
//
// Design and rules: docs/superpowers/plans/2026-09-25-program-graph-phase1.md

import crypto from "node:crypto";

import {
  getProgramPlan,
  getRegistrarRequirements,
  type ProgramPlan,
} from "./catalog-read.js";
import {
  courseCodes,
  evaluate,
  isComplete,
  minPriorTerms,
  parsePrereq,
  renderPrereq,
  requiredCodes,
  unresolved,
  type EvalCtx,
  type Expr,
  type Tri,
} from "./prereq-expr.js";

type Db = Parameters<typeof getProgramPlan>[0];

export interface CourseFacts {
  code: string;
  title: string | null;
  prereqText: string | null;
  expr: string | null;
  exprHash: string | null;
  /** course.prereq_parsed — the old flat list; witness "flat" mode only. */
  flatPrereq: string[];
  /** course.coreq_parsed — taken TOGETHER (lecture/lab). */
  coreqs: string[];
  missing?: true;
}

export type Standing = "freshman" | "sophomore" | "junior" | "senior";

export interface StudentState {
  /** normalized code -> letter grade if known ("C"), else null */
  completed: Map<string, string | null>;
  standing?: Standing;
}

export interface GraphInputs {
  program: string;
  catalogYear: string;
  plan: ProgramPlan;
  registrar: {
    audit_date: string | null;
    requirements: Record<string, unknown>[];
  };
  /** Plan courses plus their prerequisite closure. */
  courses: Map<string, CourseFacts>;
}

export type ParseState = "complete" | "partial" | "unparsed" | "stale" | "none";
export type CourseStatus =
  "eligible" | "conditional" | "not_eligible" | "undetermined";

export interface GraphCourse {
  code: string;
  title: string | null;
  planned: string | null;
  choice?: true;
  requirements: string[];
  prereq: string | null;
  parse: ParseState;
  prereq_text?: string;
  coreqs?: string[];
  min_prior_terms: number;
  required_by: number;
  one_way_into: number;
  status?: CourseStatus;
  take_with?: string[];
  unresolved?: string[];
  assumes?: string[];
}

export interface GraphRequirement {
  name: string;
  source: "degree_works" | "catalog_plan";
  need: number | null;
  unit: string | null;
  courses: string[];
  other_ways?: string[];
}

export interface ProgramGraph {
  program: string;
  catalog_year: string;
  requirement_source: "degree_works" | "catalog_plan";
  requirements: GraphRequirement[];
  courses: GraphCourse[];
  critical_path: string[];
  choices: {
    term: string;
    options: { code: string; min_prior_terms: number }[];
  }[];
  notes: string[];
}

const STANDINGS: readonly Standing[] = [
  "freshman",
  "sophomore",
  "junior",
  "senior",
];
const GRADE_RANK: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** The usable expression for a course, or its parse state when there is none. */
function usable(f: CourseFacts | undefined): {
  expr: Expr | null;
  parse: ParseState;
} {
  if (!f || f.missing || !f.prereqText || !f.prereqText.trim())
    return { expr: null, parse: "none" };
  if (!f.expr || !f.exprHash) return { expr: null, parse: "unparsed" };
  if (f.exprHash !== sha256(f.prereqText))
    return { expr: null, parse: "stale" };
  try {
    const e = parsePrereq(f.expr);
    return { expr: e, parse: isComplete(e) ? "complete" : "partial" };
  } catch {
    return { expr: null, parse: "unparsed" };
  }
}

function standingWord(value: string): Standing | null {
  const lower = value.toLowerCase();
  return STANDINGS.find((s) => lower.split(/\s+/).includes(s)) ?? null;
}

/** [standing:V] leaves that every satisfying path must meet (not inside an OR). */
function requiredStandings(e: Expr): string[] {
  if (e.t === "cond" && e.kind === "standing") return [e.value];
  if (e.t === "and") return e.of.flatMap(requiredStandings);
  return [];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function loadGraphInputs(
  db: Db,
  year: string,
  program: string,
): GraphInputs {
  const plan = getProgramPlan(db, year, program);
  const registrar = getRegistrarRequirements(db, year, program);
  const courses = new Map<string, CourseFacts>();
  const get = db.prepare(
    `SELECT c.code, c.title, c.prereq_text, c.prereq_parsed, c.coreq_parsed,
            p.expr, p.source_text_hash
       FROM course c LEFT JOIN prereq_expression p ON p.code = c.code
      WHERE c.code = ?`,
  );
  let frontier = plan.groups.flatMap((g) =>
    g.items.flatMap((it) => (it.course_code ? [it.course_code] : it.one_of)),
  );
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const code of frontier) {
      if (courses.has(code)) continue;
      const r = get.get(code) as
        | {
            code: string;
            title: string | null;
            prereq_text: string | null;
            prereq_parsed: string | null;
            coreq_parsed: string | null;
            expr: string | null;
            source_text_hash: string | null;
          }
        | undefined;
      const facts: CourseFacts = r
        ? {
            code,
            title: r.title,
            prereqText: r.prereq_text,
            expr: r.expr,
            exprHash: r.source_text_hash,
            flatPrereq: r.prereq_parsed
              ? (JSON.parse(r.prereq_parsed) as string[])
              : [],
            coreqs: r.coreq_parsed
              ? (JSON.parse(r.coreq_parsed) as string[])
              : [],
          }
        : {
            code,
            title: null,
            prereqText: null,
            expr: null,
            exprHash: null,
            flatPrereq: [],
            coreqs: [],
            missing: true,
          };
      courses.set(code, facts);
      // The closure follows only USABLE expressions — never a stale one.
      const u = usable(facts);
      if (u.expr) next.push(...courseCodes(u.expr));
    }
    frontier = next;
  }
  return { program, catalogYear: year, plan, registrar, courses };
}

// ---------------------------------------------------------------------------
// Plan positions
// ---------------------------------------------------------------------------

interface PlanPositions {
  /** First term index where the course is a FIXED plan item. */
  fixedAt: Map<string, number>;
  /** First term index where the course appears at all (fixed or choice). */
  plannedAt: Map<string, { index: number; label: string; choice: boolean }>;
  order: string[];
}

function planPositions(plan: ProgramPlan): PlanPositions {
  const fixedAt = new Map<string, number>();
  const plannedAt = new Map<
    string,
    { index: number; label: string; choice: boolean }
  >();
  const order: string[] = [];
  plan.groups.forEach((g, i) => {
    for (const it of g.items) {
      if (it.course_code) {
        if (!fixedAt.has(it.course_code)) fixedAt.set(it.course_code, i);
        if (
          !plannedAt.has(it.course_code) ||
          plannedAt.get(it.course_code)!.choice
        )
          plannedAt.set(it.course_code, {
            index: i,
            label: g.label,
            choice: false,
          });
        if (!order.includes(it.course_code)) order.push(it.course_code);
      }
      for (const c of it.one_of ?? []) {
        if (!plannedAt.has(c))
          plannedAt.set(c, { index: i, label: g.label, choice: true });
        if (!order.includes(c)) order.push(c);
      }
    }
  });
  return { fixedAt, plannedAt, order };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildProgramGraph(
  inp: GraphInputs,
  student?: StudentState,
): ProgramGraph {
  const notes: string[] = [];
  const pos = planPositions(inp.plan);

  // Every code named anywhere becomes a node; a code with no catalog row is
  // reported, never dropped.
  const facts = new Map(inp.courses);
  const parsed = new Map<string, { expr: Expr | null; parse: ParseState }>();
  const ensure = (code: string) => {
    if (!facts.has(code)) {
      facts.set(code, {
        code,
        title: null,
        prereqText: null,
        expr: null,
        exprHash: null,
        flatPrereq: [],
        coreqs: [],
        missing: true,
      });
    }
  };
  for (const code of pos.order) ensure(code);
  for (let changed = true; changed;) {
    changed = false;
    for (const [code, f] of [...facts]) {
      if (parsed.has(code)) continue;
      const u = usable(f);
      parsed.set(code, u);
      changed = true;
      if (u.expr) for (const c of courseCodes(u.expr)) ensure(c);
    }
  }
  for (const [code, f] of facts) {
    if (f.missing) notes.push(`${code} is not in the course catalog`);
  }

  // Standing floors, from the plan's own term labels.
  const floorOf = (code: string): number => {
    const e = parsed.get(code)?.expr;
    if (!e) return 0;
    let floor = 0;
    for (const v of requiredStandings(e)) {
      const word = standingWord(v);
      const idx = word
        ? inp.plan.groups.findIndex((g) =>
            g.label.toLowerCase().startsWith(word),
          )
        : -1;
      if (idx < 0) {
        const note = `standing '${v}' has no matching term label in this plan`;
        if (!notes.includes(note)) notes.push(note);
      } else floor = Math.max(floor, idx);
    }
    return floor;
  };

  // Chain bounds: memoized DFS with cycle breaking.
  const chain = new Map<string, number>();
  const onStack = new Set<string>();
  const chainOf = (code: string): number => {
    const known = chain.get(code);
    if (known !== undefined) return known;
    if (onStack.has(code)) {
      const note = `prerequisite cycle broken at ${code}`;
      if (!notes.includes(note)) notes.push(note);
      return 0;
    }
    onStack.add(code);
    const e = parsed.get(code)?.expr;
    const bound = e ? Math.max(minPriorTerms(e, chainOf), floorOf(code)) : 0;
    onStack.delete(code);
    chain.set(code, bound);
    return bound;
  };
  for (const code of facts.keys()) chainOf(code);

  // Direct edge counts.
  const requiredBy = new Map<string, number>();
  const oneWayInto = new Map<string, number>();
  for (const { expr } of parsed.values()) {
    if (!expr) continue;
    const req = new Set(requiredCodes(expr));
    for (const c of courseCodes(expr)) {
      const m = req.has(c) ? requiredBy : oneWayInto;
      m.set(c, (m.get(c) ?? 0) + 1);
    }
  }

  // Requirements.
  const requirements: GraphRequirement[] = [];
  const reqNamesOf = new Map<string, string[]>();
  const requirementSource: ProgramGraph["requirement_source"] =
    inp.registrar.requirements.length > 0 ? "degree_works" : "catalog_plan";
  if (requirementSource === "degree_works") {
    for (const r of inp.registrar.requirements) {
      const name = String(r.display_name ?? "Requirement");
      const courses = Array.isArray(r.courses) ? (r.courses as string[]) : [];
      const other = otherWays(r);
      requirements.push({
        name,
        source: "degree_works",
        need: typeof r.need === "number" ? r.need : null,
        unit: typeof r.unit === "string" ? r.unit : null,
        courses,
        ...(other.length ? { other_ways: other } : {}),
      });
      for (const c of courses)
        reqNamesOf.set(c, [...(reqNamesOf.get(c) ?? []), name]);
    }
  } else {
    notes.push(
      "No Degree Works import for this program-year; requirements shown are the catalog plan's slots and choices.",
    );
    for (const g of inp.plan.groups) {
      for (const it of g.items) {
        if (it.slot_type) {
          requirements.push({
            name: it.slot_type,
            source: "catalog_plan",
            need: it.credits,
            unit: "credits",
            courses: [],
          });
        } else if (it.one_of?.length) {
          const name = `Choice: ${it.one_of.join(" / ")}`;
          requirements.push({
            name,
            source: "catalog_plan",
            need: 1,
            unit: "classes",
            courses: [...it.one_of],
          });
          for (const c of it.one_of)
            reqNamesOf.set(c, [...(reqNamesOf.get(c) ?? []), name]);
        }
      }
    }
  }

  // Course nodes: plan order first, then prerequisite-only courses by code.
  const rest = [...facts.keys()].filter((c) => !pos.order.includes(c)).sort();
  const courses: GraphCourse[] = [...pos.order, ...rest].map((code) => {
    const f = facts.get(code)!;
    const { expr, parse } = parsed.get(code)!;
    const planned = pos.plannedAt.get(code);
    const node: GraphCourse = {
      code,
      title: f.title,
      planned: planned?.label ?? null,
      ...(planned?.choice ? { choice: true as const } : {}),
      requirements: reqNamesOf.get(code) ?? [],
      prereq: expr ? renderPrereq(expr) : null,
      parse,
      ...(parse === "partial" || parse === "unparsed" || parse === "stale"
        ? { prereq_text: f.prereqText ?? "" }
        : {}),
      ...(f.coreqs.length ? { coreqs: f.coreqs } : {}),
      min_prior_terms: chain.get(code) ?? 0,
      required_by: requiredBy.get(code) ?? 0,
      one_way_into: oneWayInto.get(code) ?? 0,
    };
    if (student && !student.completed.has(code)) {
      Object.assign(node, statusFor(expr, parse, inp.program, student));
    }
    return node;
  });

  // Critical path: the longest prerequisite CHAIN, followed leaf by leaf. It
  // uses a chain-only bound (no standing floors): a floor is a timing bound,
  // not a chain of courses, and GC 4800's senior-standing floor otherwise
  // made the "path" just ["GC 4800"] (real GC 2026-27 output).
  const pure = new Map<string, number>();
  const pureStack = new Set<string>();
  const pureOf = (code: string): number => {
    const known = pure.get(code);
    if (known !== undefined) return known;
    if (pureStack.has(code)) return 0; // cycle already reported in notes
    pureStack.add(code);
    const e = parsed.get(code)?.expr;
    const bound = e ? minPriorTerms(e, pureOf) : 0;
    pureStack.delete(code);
    pure.set(code, bound);
    return bound;
  };
  for (const code of facts.keys()) pureOf(code);
  const critical_path: string[] = [];
  const start = pos.order
    .map((code, i) => ({ code, i, b: pure.get(code) ?? 0 }))
    .sort((a, b) => b.b - a.b || a.i - b.i)[0];
  for (let cur = start?.b ? start.code : undefined; cur;) {
    critical_path.unshift(cur);
    if (critical_path.length > facts.size) break;
    const e = parsed.get(cur)?.expr;
    cur = e ? bindingLeaf(e, pure.get(cur) ?? 0, pureOf) : undefined;
  }

  const choices = inp.plan.groups.flatMap((g) =>
    g.items
      .filter((it) => (it.one_of?.length ?? 0) > 0)
      .map((it) => ({
        term: g.label,
        options: it.one_of.map((c) => ({
          code: c,
          min_prior_terms: chain.get(c) ?? 0,
        })),
      })),
  );

  return {
    program: inp.program,
    catalog_year: inp.catalogYear,
    requirement_source: requirementSource,
    requirements,
    courses,
    critical_path,
    choices,
    notes,
  };
}

/** The course leaf whose own chain produces `bound` (AND: max; OR: min). */
function bindingLeaf(
  e: Expr,
  bound: number,
  chainOf: (c: string) => number,
): string | undefined {
  const leafBound = (x: Expr): number => minPriorTerms(x, chainOf);
  switch (e.t) {
    case "course":
      return leafBound(e) === bound ? e.code : undefined;
    case "and":
      for (const c of e.of) {
        if (leafBound(c) === bound) {
          const hit = bindingLeaf(c, bound, chainOf);
          if (hit) return hit;
        }
      }
      return undefined;
    case "or": {
      const best = [...e.of].sort((a, b) => leafBound(a) - leafBound(b))[0];
      return best && leafBound(best) === bound
        ? bindingLeaf(best, bound, chainOf)
        : undefined;
    }
    default:
      return undefined;
  }
}

function otherWays(r: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const w of (r.wildcards as Record<string, unknown>[] | undefined) ??
    []) {
    if (w.type === "dept_level_min")
      out.push(`any ${w.dept} course at ${w.min}-level or above`);
    else if (w.type === "level_min")
      out.push(`any course at ${w.min}-level or above`);
    else out.push(`wildcard: ${JSON.stringify(w)}`);
  }
  if (r.attribute) out.push(`any course with attribute ${r.attribute}`);
  for (const a of (r.alternatives as Record<string, unknown>[] | undefined) ??
    []) {
    const cs = Array.isArray(a.courses) ? (a.courses as string[]) : [];
    const rest = otherWays(a);
    out.push(
      `alternative route: ${[cs.join(" or "), ...rest].filter(Boolean).join("; ")}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function statusFor(
  expr: Expr | null,
  parse: ParseState,
  program: string,
  student: StudentState,
): Pick<GraphCourse, "status" | "take_with" | "unresolved" | "assumes"> {
  if (parse === "none") return { status: "eligible" };
  if (!expr)
    return {
      status: "undetermined",
      unresolved: ["prerequisite text not structured"],
    };

  const assumes: string[] = [];
  const ctx = (opts: {
    conditions: "full" | "coursework";
    concurrentOk: boolean;
  }): EvalCtx => ({
    course: (l) => {
      if (student.completed.has(l.code)) {
        if (!l.minGrade) return "T";
        const g = student.completed.get(l.code);
        if (g === null || g === undefined) {
          const a = `${l.minGrade.replace(/[+-]/, "")} or better in ${l.code}`;
          if (!assumes.includes(a)) assumes.push(a);
          return "T";
        }
        const have = GRADE_RANK[g.toUpperCase().replace(/[+-]/, "")];
        const need = GRADE_RANK[l.minGrade.toUpperCase().replace(/[+-]/, "")];
        return have !== undefined && need !== undefined && have >= need
          ? "T"
          : "F";
      }
      return l.concurrent && opts.concurrentOk ? "T" : "F";
    },
    cond: (c) => {
      if (c.kind === "major")
        return program.toLowerCase().startsWith(c.value.toLowerCase())
          ? "T"
          : "F";
      if (c.kind === "standing" && student.standing) {
        const want = standingWord(c.value);
        if (want)
          return STANDINGS.indexOf(student.standing) >= STANDINGS.indexOf(want)
            ? "T"
            : "F";
      }
      return opts.conditions === "coursework" ? "T" : "U";
    },
    unknown: () => "U",
  });

  const fullCtx = ctx({ conditions: "full", concurrentOk: true });
  const full: Tri = evaluate(expr, fullCtx);
  const coursework: Tri = evaluate(
    expr,
    ctx({ conditions: "coursework", concurrentOk: true }),
  );

  let status: CourseStatus;
  let unres: string[] | undefined;
  if (full === "T") status = "eligible";
  else if (full === "F") status = "not_eligible";
  else if (coursework === "T") {
    status = "conditional";
    unres = unresolved(expr, fullCtx);
  } else {
    status = "undetermined";
    unres = unresolved(expr, fullCtx);
  }

  const out: ReturnType<typeof statusFor> = { status };
  if (unres?.length) out.unresolved = unres;
  if (status === "eligible" || status === "conditional") {
    const strict = evaluate(
      expr,
      ctx({
        conditions: status === "eligible" ? "full" : "coursework",
        concurrentOk: false,
      }),
    );
    if (strict !== "T") {
      const tw = concurrentLeaves(expr).filter(
        (c) => !student.completed.has(c),
      );
      if (tw.length) out.take_with = tw;
    }
    if (assumes.length) out.assumes = assumes;
  }
  return out;
}

function concurrentLeaves(e: Expr): string[] {
  if (e.t === "course") return e.concurrent ? [e.code] : [];
  if (e.t === "and" || e.t === "or")
    return [...new Set(e.of.flatMap(concurrentLeaves))];
  return [];
}

// ---------------------------------------------------------------------------
// Witness
// ---------------------------------------------------------------------------

/**
 * Published-plan witness: Clemson's own semester sequence must never place a
 * course before a prerequisite it cannot be taken alongside. A fixed plan
 * course earlier -> T; same term -> T only for a concurrent leaf; later -> F;
 * a course that is only a choice option, or not in the plan -> U;
 * conditions -> T; unknown text -> U. F is a violation.
 */
export function planOrderViolations(
  inp: GraphInputs,
  mode: "parsed" | "flat",
): string[] {
  const pos = planPositions(inp.plan);
  const out: string[] = [];
  for (const [code, at] of pos.plannedAt) {
    let e: Expr | null = null;
    const f = inp.courses.get(code);
    if (mode === "parsed") e = usable(f).expr;
    else if (f && f.flatPrereq.length > 0)
      e = {
        t: "and",
        of: f.flatPrereq.map((c) => ({
          t: "course" as const,
          code: c,
          concurrent: false,
        })),
      };
    if (!e) continue;
    const v = evaluate(e, {
      course: (l) => {
        const j = pos.fixedAt.get(l.code);
        if (j === undefined) return "U";
        if (j < at.index) return "T";
        if (j === at.index) return l.concurrent ? "T" : "F";
        return "F";
      },
      cond: () => "T",
      unknown: () => "U",
    });
    if (v === "F")
      out.push(
        `${inp.catalogYear} ${inp.program}: ${code} (term ${at.index}) needs ${renderPrereq(e)}`,
      );
  }
  return out;
}
