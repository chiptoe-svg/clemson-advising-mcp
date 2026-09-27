// src/prereq-expr.ts
// A strict notation for prerequisite rules, hand-authored per course and
// reviewed (core/prereqs/plan-courses.json). Strict on purpose: mixing & and |
// without parentheses is an error, so a precedence reading is always explicit.
// Grammar and authoring rules: docs/superpowers/plans/2026-09-25-program-graph-phase1.md

export type CondKind = "standing" | "major" | "minor" | "consent" | "test";
export type Expr =
  | { t: "course"; code: string; minGrade?: string; concurrent: boolean }
  | { t: "and"; of: Expr[] }
  | { t: "or"; of: Expr[] }
  | { t: "cond"; kind: CondKind; value: string }
  | { t: "unknown"; text: string };
export type Tri = "T" | "F" | "U";

const COND_KINDS: ReadonlySet<string> = new Set([
  "standing",
  "major",
  "minor",
  "consent",
  "test",
]);

export class PrereqSyntaxError extends Error {}

export function parsePrereq(src: string): Expr {
  let i = 0;
  const ws = () => {
    while (src[i] === " ") i++;
  };
  const syntax = (msg: string) =>
    new PrereqSyntaxError(`${msg} at ${i} in: ${src}`);

  function expr(): Expr {
    const first = unary();
    ws();
    const op = src[i];
    if (op !== "&" && op !== "|") return first;
    const of = [first];
    while (src[i] === op) {
      i++;
      of.push(unary());
      ws();
    }
    if (src[i] === "&" || src[i] === "|")
      throw syntax("mixed & and | need parentheses");
    return { t: op === "&" ? "and" : "or", of };
  }
  function unary(): Expr {
    ws();
    if (src[i] === "~") {
      i++;
      return markConcurrent(primary());
    }
    return primary();
  }
  function primary(): Expr {
    ws();
    const c = src[i];
    if (c === "(") {
      i++;
      const e = expr();
      ws();
      if (src[i] !== ")") throw syntax("expected )");
      i++;
      return e;
    }
    if (c === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) throw syntax("unclosed [");
      const body = src.slice(i + 1, end);
      i = end + 1;
      const colon = body.indexOf(":");
      const kind = (colon < 0 ? body : body.slice(0, colon)).trim();
      const value = colon < 0 ? "" : body.slice(colon + 1).trim();
      if (!COND_KINDS.has(kind))
        throw syntax(`unknown condition kind "${kind}"`);
      return { t: "cond", kind: kind as CondKind, value };
    }
    if (c === "?") {
      if (src[i + 1] !== '"') throw syntax('expected ?"text"');
      const end = src.indexOf('"', i + 2);
      if (end < 0) throw syntax("unclosed quote");
      const text = src.slice(i + 2, end);
      i = end + 1;
      return { t: "unknown", text };
    }
    const m = /^([A-Z]{2,5} \d{4})(>=([A-D][+-]?))?/.exec(src.slice(i));
    if (!m) throw syntax("expected a course, (, [ or ?");
    i += m[0].length;
    return {
      t: "course",
      code: m[1]!,
      concurrent: false,
      ...(m[3] ? { minGrade: m[3] } : {}),
    };
  }

  const e = expr();
  ws();
  if (i !== src.length) throw syntax("trailing input");
  return e;
}

function markConcurrent(e: Expr): Expr {
  switch (e.t) {
    case "course":
      return { ...e, concurrent: true };
    case "and":
    case "or":
      return { t: e.t, of: e.of.map(markConcurrent) };
    default:
      return e;
  }
}

export function renderPrereq(e: Expr): string {
  switch (e.t) {
    case "course":
      return `${e.concurrent ? "~" : ""}${e.code}${e.minGrade ? `>=${e.minGrade}` : ""}`;
    case "cond":
      return e.value ? `[${e.kind}:${e.value}]` : `[${e.kind}]`;
    case "unknown":
      return `?"${e.text}"`;
    case "and":
    case "or":
      return e.of
        .map((c) =>
          c.t === "and" || c.t === "or"
            ? `(${renderPrereq(c)})`
            : renderPrereq(c),
        )
        .join(e.t === "and" ? " & " : " | ");
  }
}

export function courseCodes(e: Expr): string[] {
  const out: string[] = [];
  const walk = (x: Expr) => {
    if (x.t === "course") {
      if (!out.includes(x.code)) out.push(x.code);
    } else if (x.t === "and" || x.t === "or") x.of.forEach(walk);
  };
  walk(e);
  return out;
}

export function isComplete(e: Expr): boolean {
  if (e.t === "unknown") return false;
  if (e.t === "and" || e.t === "or") return e.of.every(isComplete);
  return true;
}

/** Codes on EVERY satisfying path — what an OR alternative is not. */
export function requiredCodes(e: Expr): string[] {
  switch (e.t) {
    case "course":
      return [e.code];
    case "and":
      return [...new Set(e.of.flatMap(requiredCodes))];
    case "or": {
      const [first, ...rest] = e.of.map(requiredCodes);
      return (first ?? []).filter((c) => rest.every((r) => r.includes(c)));
    }
    default:
      return [];
  }
}

export interface EvalCtx {
  course(leaf: Extract<Expr, { t: "course" }>): Tri;
  cond(leaf: Extract<Expr, { t: "cond" }>): Tri;
  unknown(leaf: Extract<Expr, { t: "unknown" }>): Tri;
}

export function evaluate(e: Expr, ctx: EvalCtx): Tri {
  switch (e.t) {
    case "course":
      return ctx.course(e);
    case "cond":
      return ctx.cond(e);
    case "unknown":
      return ctx.unknown(e);
    case "and": {
      let r: Tri = "T";
      for (const c of e.of) {
        const v = evaluate(c, ctx);
        if (v === "F") return "F";
        if (v === "U") r = "U";
      }
      return r;
    }
    case "or": {
      let r: Tri = "F";
      for (const c of e.of) {
        const v = evaluate(c, ctx);
        if (v === "T") return "T";
        if (v === "U") r = "U";
      }
      return r;
    }
  }
}

/** Rendered leaves that evaluated UNKNOWN — the reasons behind an "undetermined". */
export function unresolved(e: Expr, ctx: EvalCtx): string[] {
  if (e.t === "and" || e.t === "or")
    return e.of.flatMap((c) => unresolved(c, ctx));
  return evaluate(e, ctx) === "U" ? [renderPrereq(e)] : [];
}

/**
 * Lower bound on the number of terms that must precede a course, from its
 * prerequisite CHAIN alone. `chainOf(code)` is that course's own bound (0 when
 * unknown or unparsed). Standing, tests and unknown clauses add nothing, so
 * the result is always "at least", never exact.
 */
export function minPriorTerms(
  e: Expr,
  chainOf: (code: string) => number,
): number {
  switch (e.t) {
    case "course":
      return chainOf(e.code) + (e.concurrent ? 0 : 1);
    case "and":
      return Math.max(0, ...e.of.map((c) => minPriorTerms(c, chainOf)));
    case "or":
      return Math.min(...e.of.map((c) => minPriorTerms(c, chainOf)));
    default:
      return 0;
  }
}
