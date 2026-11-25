// src/prereq-eligibility.ts
//
// Can this student take this course, from the courses they have finished?
// THREE-VALUED, never a boolean: "undetermined" means the rule cannot be
// decided from what is known (a standing or consent gate, wording the flat
// list cannot read, or a prerequisite still in progress), and it must never
// be folded into "eligible" — that would be silence read as absence again.
//
// Rule source, in order: the reviewed expression (core/prereqs, current
// against the catalog text) when there is one, else the catalog's flat
// prereq_parsed list read conservatively. SIDE-EFFECT-FREE: no tool
// registration here, so the schedule and catalog tools can both import it.
import Database from "better-sqlite3";

import { CATALOG_DB } from "./config-mcp.js";
import {
  courseCodes,
  evaluate,
  parsePrereq,
  unresolved,
  type EvalCtx,
  type Expr,
  type Tri,
} from "./prereq-expr.js";
import { reviewedRules } from "./reviewed-prereq.js";

export interface CourseRuleFacts {
  prereqText: string | null;
  /** The catalog's flat prereq_parsed codes, "GC 3400" form. */
  flat: string[] | null;
  /** The reviewed expression, only when current against prereqText. */
  reviewed: string | null;
}

export interface StudentCourses {
  completed: Set<string>;
  /** In progress in a term BEFORE the search term. */
  inProgress: Set<string>;
  /** Courses of the CRNs she keeps in the search term itself: they meet
   *  only a may-be-concurrent prerequisite, never a plain one. */
  sameTerm: Set<string>;
}

export interface Eligibility {
  prereq_eligibility: "eligible" | "not_eligible" | "undetermined";
  /** not_eligible: prerequisites she has not taken (an OR lists each way). */
  missing?: string[];
  /** undetermined: in-progress prerequisites the verdict waits on. */
  pending?: string[];
  reason?: string;
  /** eligible on a grade minimum the course list cannot show. */
  assumes?: string[];
  prereq_text?: string;
}

const withText = (e: Eligibility, text: string | null): Eligibility =>
  text?.trim() ? { ...e, prereq_text: text } : e;

export function prereqEligibility(
  facts: CourseRuleFacts | null,
  s: StudentCourses,
): Eligibility {
  // No catalog row: its rule is unknown, which is not "no prerequisites".
  if (!facts)
    return {
      prereq_eligibility: "undetermined",
      reason: "not in the catalog, so its prerequisites cannot be checked",
    };
  const text = facts.prereqText;
  const earlier = (c: string) => s.inProgress.has(c) && !s.sameTerm.has(c);
  if (facts.reviewed) {
    let expr: Expr | null = null;
    try {
      expr = parsePrereq(facts.reviewed);
    } catch {
      // An unparseable reviewed rule falls back to the catalog's list.
    }
    if (expr) return fromExpr(expr, s, earlier, text);
  }
  if (!text?.trim()) return { prereq_eligibility: "eligible" };
  const codes = [...new Set(facts.flat ?? [])];
  const rest = beyondCodes(text);
  // Wording beyond course codes and a grade minimum — a standing, consent,
  // major or admission gate, an OR, or alternatives by major — is something a
  // code list cannot decide, met or not (hostile review, 2026-11-25).
  const notDone = codes.filter((c) => !s.completed.has(c));
  // Every listed course done meets an OR of them under any reading, so only
  // OR wording may remain beside the codes then.
  const left =
    notDone.length === 0
      ? rest.other
          .replace(/\b(?:or|either|one of|the following)\b|:/gi, "")
          .trim()
      : rest.other;
  if (codes.length === 0 || left)
    return withText(
      { prereq_eligibility: "undetermined", reason: cannotCheck(text) },
      text,
    );
  if (notDone.length === 0)
    return {
      prereq_eligibility: "eligible",
      ...(rest.grade ? { assumes: [`grade minimum met: ${text}`] } : {}),
    };
  const untaken = notDone.filter((c) => !earlier(c));
  if (untaken.length > 0)
    return withText(
      { prereq_eligibility: "not_eligible", missing: untaken },
      text,
    );
  return withText(pendingOn(notDone), text);
}

const CODE = /\b[A-Z]{2,5}\s?\d{4}\b/g;
const GRADE =
  /\b(?:with\s+)?(?:an?\s+)?(?:minimum\s+)?(?:grade\s+of\s+)?(?:an?\s+)?[A-D][+-]?\s+or\s+(?:better|higher)(?:\s+in)?\b|\bminimum\s+grade\s+of\s+[A-D][+-]?\b/gi;

/** What a rule says beyond its course codes: a grade minimum, and anything
 *  else (connectives and punctuation aside). */
function beyondCodes(text: string): { grade: boolean; other: string } {
  const noCodes = text.replace(CODE, " ");
  const grade = GRADE.test(noCodes);
  GRADE.lastIndex = 0;
  const other = noCodes
    .replace(GRADE, " ")
    .replace(/\b(?:and|each|both)\b/gi, " ")
    .replace(/[,;.&()]/g, " ")
    .trim();
  return { grade, other };
}

/** The rule in its own words — what a model should relay — falling back to
 *  the unresolved leaves when the catalog text is blank. */
function cannotCheck(text: string | null, leaves = ""): string {
  const t = text?.trim() || leaves;
  return `cannot check: ${t.length > 160 ? `${t.slice(0, 157)}...` : t}`;
}

function pendingOn(codes: string[]): Eligibility {
  return {
    prereq_eligibility: "undetermined",
    pending: codes,
    reason:
      codes.length === 1
        ? `eligible if ${codes[0]} is passed`
        : `depends on in-progress ${codes.join(", ")} — see prereq_text for which are needed`,
  };
}

function fromExpr(
  expr: Expr,
  s: StudentCourses,
  earlier: (c: string) => boolean,
  text: string | null,
): Eligibility {
  const assumes: string[] = [];
  const ctx = (inProgressPasses: boolean): EvalCtx => ({
    course: (l) => {
      if (s.completed.has(l.code)) {
        if (l.minGrade) {
          const a = `${l.minGrade} or better in ${l.code}`;
          if (!assumes.includes(a)) assumes.push(a);
        }
        return "T";
      }
      if (earlier(l.code)) return inProgressPasses ? "T" : "U";
      return l.concurrent && s.sameTerm.has(l.code) ? "T" : "F";
    },
    cond: () => "U",
    unknown: () => "U",
  });
  const strict = ctx(false);
  const v: Tri = evaluate(expr, strict);
  if (v === "T")
    return {
      prereq_eligibility: "eligible",
      ...(assumes.length ? { assumes } : {}),
    };
  if (v === "F")
    return withText(
      {
        prereq_eligibility: "not_eligible",
        missing: missingOf(expr, strict),
        ...(failingOr(expr, strict)
          ? { reason: "needs one of the ways in its rule — see prereq_text" }
          : {}),
      },
      text,
    );
  if (evaluate(expr, ctx(true)) === "T")
    return withText(pendingOn(courseCodes(expr).filter(earlier)), text);
  return withText(
    {
      prereq_eligibility: "undetermined",
      reason: cannotCheck(text, unresolved(expr, strict).join(", ")),
    },
    text,
  );
}

/** Whether a false rule fails at an OR — so one way would be enough. */
function failingOr(e: Expr, ctx: EvalCtx): boolean {
  if (e.t === "or") return evaluate(e, ctx) === "F";
  if (e.t === "and")
    return e.of.some((c) => evaluate(c, ctx) === "F" && failingOr(c, ctx));
  return false;
}

/** The untaken courses behind a false rule; an OR lists every way. */
function missingOf(e: Expr, ctx: EvalCtx): string[] {
  if (e.t === "course") return evaluate(e, ctx) === "F" ? [e.code] : [];
  if (e.t === "and" || e.t === "or") {
    const kids =
      e.t === "and" ? e.of.filter((c) => evaluate(c, ctx) === "F") : e.of;
    return [...new Set(kids.flatMap((c) => missingOf(c, ctx)))];
  }
  return [];
}

/** Rule facts for `codes` from the catalog, or null when it cannot be read —
 *  the caller must then say prerequisites went unchecked. */
export function loadRuleFacts(
  codes: string[],
): Map<string, CourseRuleFacts> | null {
  let db: Database.Database;
  try {
    db = new Database(CATALOG_DB, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const rules = reviewedRules(db);
    const one = db.prepare(
      "SELECT prereq_text, prereq_parsed FROM course WHERE code = ? LIMIT 1",
    );
    const out = new Map<string, CourseRuleFacts>();
    for (const code of codes) {
      const r = one.get(code) as
        | { prereq_text: string | null; prereq_parsed: string | null }
        | undefined;
      if (!r) continue;
      let flat: string[] | null = null;
      try {
        const p = r.prereq_parsed ? JSON.parse(r.prereq_parsed) : null;
        flat = Array.isArray(p) ? p.map(String) : null;
      } catch {
        flat = null;
      }
      out.set(code, {
        prereqText: r.prereq_text,
        flat,
        reviewed: rules.get(code)?.expr ?? null,
      });
    }
    return out;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
