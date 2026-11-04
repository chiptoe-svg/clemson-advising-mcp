// src/mcp-tools/course-fit.ts
//
// find-alternatives' verdicts: which COURSES can be added around the CRNs a
// student keeps — SIDE-EFFECT-FREE helper module (see gc-coreqs.ts for why
// helpers never live in a registering module).
//
// Why (Cob_advisor for Chip, 2026-11-04): a subject search returned the
// sections that don't collide — 22 for PKSC around eight kept CRNs — and a
// model relayed "22". The answer was two courses: a lecture whose required lab
// clashes cannot be added, a lab alone is not a course, graduate and
// zero-capacity placeholder sections are not options for an undergraduate.
//
// A course and its catalog corequisites (lecture + lab; coreq_parsed, both
// directions) are one UNIT. It fits when some choice of one section per member
// clears every kept CRN and the chosen sections clear each other. Sections
// with no meeting times never clash; a unit whose fitting choices are all
// untimed is "arranged". The lead — the member reported — is the credit-
// bearing course, never the lab.

import {
  getMeetingsForCrns,
  getSectionsByCrn,
  openScheduleDb,
  type MeetingInterval,
} from "../clemson-schedule-db.js";
import { coreqCatalog, type CoreqCatalogEntry } from "./gc-coreqs.js";
import {
  querySectionsEngine,
  type EngineMeeting,
  type EngineSection,
} from "./section-query.js";

export type VerdictFilters = Omit<
  Parameters<typeof querySectionsEngine>[0],
  | "term"
  | "subject"
  | "courseNumber"
  | "fitsAroundCrns"
  | "max"
  | "offset"
  | "unpaged"
>;

const SECTIONS_SHOWN = 10;
/** Section choices tried per unit; a lecture × lab product stays far below. */
const MAX_COMBINATIONS = 5000;
const GRADUATE_FROM = 5000;

interface Member {
  code: string;
  /** "lab" or "corequisite", for reasons a reader can follow. */
  role: string;
  all: EngineSection[];
  passing: EngineSection[];
  fitting: EngineSection[];
  blocked: { crn: string; meetings: EngineMeeting[]; blocked_by: string[] }[];
}

const mins = (hhmm: string) =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2, 4));

function clash(a: EngineSection, b: EngineSection): boolean {
  return a.meetings.some((m) =>
    b.meetings.some(
      (n) =>
        m.day === n.day &&
        mins(m.start) < mins(n.end) &&
        mins(n.start) < mins(m.end),
    ),
  );
}

function blockers(s: EngineSection, anchors: MeetingInterval[]): string[] {
  const by = new Set<string>();
  for (const m of s.meetings)
    for (const a of anchors)
      if (
        a.day === m.day &&
        mins(m.start) < a.endMin &&
        a.startMin < mins(m.end)
      )
        by.add(a.crn);
  return [...by];
}

const spaced = (subjectCourse: string) =>
  subjectCourse.replace(/^([A-Z]+)/, "$1 ");
const courseNumber = (code: string) => Number(/\d+/.exec(code)?.[0] ?? 0);
const leadCredits = (e: CoreqCatalogEntry | undefined) =>
  Number.parseFloat(e?.credits ?? "") || 0;

/** The course and everything it is a corequisite with, lead first. */
function unitOf(
  code: string,
  catalog: Map<string, CoreqCatalogEntry> | null,
): string[] {
  const members = new Set([code]);
  const todo = [code];
  while (todo.length && catalog) {
    for (const c of catalog.get(todo.pop()!)?.coreqs ?? [])
      if (!members.has(c)) {
        members.add(c);
        todo.push(c);
      }
  }
  const rank = (c: string) => {
    const e = catalog?.get(c);
    return [e?.lab ? 1 : 0, -leadCredits(e), c] as const;
  };
  return [...members].sort((a, b) => {
    const [la, ca, na] = rank(a);
    const [lb, cb, nb] = rank(b);
    return la - lb || ca - cb || na.localeCompare(nb);
  });
}

export interface UnitVerdict {
  course: string;
  title?: string;
  pairing_note?: string;
  with?: string[];
  requested_as?: string[];
  offered: boolean;
  already_kept?: string[];
  replaced_section?: string;
  fits: boolean;
  how?: "timed" | "arranged";
  /** Every section choice that fits: the lead's section first. */
  options_count?: number;
  options?: {
    crns: string[];
    credit_hours: number | null;
    sections: {
      crn: string;
      course: string;
      credit_hours: number | null;
      seats_available: number;
      meetings: EngineMeeting[];
    }[];
  }[];
  options_note?: string;
  reason?: string;
  /** The lead's own sections (courses mode has always returned these). */
  fitting_count: number;
  fitting: EngineSection[];
  fitting_note?: string;
  blocked?: Member["blocked"];
  outside_filters?: number;
  placeholders_skipped?: number;
}

export interface VerdictRun {
  snapshotDate: string | null;
  units: UnitVerdict[];
  unknownCrns: string[];
  graduate: string[];
  placeholdersOnly: string[];
  coreqsUnchecked: boolean;
}

/**
 * Verdicts for `codes` (courses mode) or for every course in `subject`
 * (subject mode: graduate courses and courses with only placeholder sections
 * set aside unless `includeGraduate`). `leadCredits` filters the lead only —
 * a 0-credit lab never matches a 3-credit filter.
 */
export function courseUnitVerdicts(opts: {
  term: string;
  keepers: string[];
  filters: VerdictFilters;
  codes?: string[];
  subject?: string;
  includeGraduate?: boolean;
}): VerdictRun | { error: string } {
  const { term, keepers } = opts;
  const { credits, ...memberFilters } = opts.filters;
  const db = openScheduleDb(term);
  if (!db) return { error: `No schedule snapshot for term ${term}.` };
  let anchors: MeetingInterval[];
  const keptBy = new Map<string, string[]>();
  const replacedBy = new Map<string, string>();
  const found = new Set<string>();
  try {
    anchors = getMeetingsForCrns(db, term, keepers);
    for (const k of getSectionsByCrn(db, term, keepers).sections) {
      found.add(k.crn);
      const c = spaced(k.subject_course);
      keptBy.set(c, [...(keptBy.get(c) ?? []), k.crn]);
    }
    for (const d of getSectionsByCrn(db, term, opts.filters.excludeCrns ?? [])
      .sections)
      replacedBy.set(spaced(d.subject_course), d.crn);
  } finally {
    db.close();
  }
  // Her own sections are never candidates: one would only clash with itself.
  const excludeCrns = [...(opts.filters.excludeCrns ?? []), ...keepers];

  // Sections per subject, fetched once: every section, and those passing the
  // filters (credits aside — applied to the lead below).
  const bySubject = new Map<
    string,
    { all: Map<string, EngineSection[]>; passing: Map<string, EngineSection[]> }
  >();
  let snapshotDate: string | null = null;
  const sectionsOf = (
    code: string,
  ): { all: EngineSection[]; passing: EngineSection[] } | { error: string } => {
    const subject = code.split(" ")[0]!;
    let got = bySubject.get(subject);
    if (!got) {
      const base = { term, subject, excludeCrns, unpaged: true };
      const all = querySectionsEngine(base);
      if ("error" in all) return all;
      const passing = querySectionsEngine({
        ...base,
        ...memberFilters,
        excludeCrns,
      });
      if ("error" in passing) return passing;
      snapshotDate ??= all.snapshotDate;
      const group = (ss: EngineSection[]) => {
        const m = new Map<string, EngineSection[]>();
        for (const s of ss) {
          const c = spaced(s.subjectCourse);
          m.set(c, [...(m.get(c) ?? []), s]);
        }
        return m;
      };
      got = { all: group(all.sections), passing: group(passing.sections) };
      bySubject.set(subject, got);
    }
    return {
      all: got.all.get(code) ?? [],
      passing: got.passing.get(code) ?? [],
    };
  };

  let codes = opts.codes ?? [];
  if (opts.subject) {
    const s = sectionsOf(`${opts.subject} 0`);
    if ("error" in s) return s;
    codes = [...bySubject.get(opts.subject)!.all.keys()].sort();
  }
  const catalog = coreqCatalog(codes);
  // The catalog holds undergraduate courses only. For a course it lacks, a
  // 0-credit "Laboratory" numbered one above an offered course is that
  // course's lab (PKSC 6301 with PKSC 6300) — inferred from the snapshot and
  // said so on the entry, so a lab is still never listed alone.
  const pairs = new Map<string, CoreqCatalogEntry & { inferred?: true }>(
    catalog ?? [],
  );
  const snapshotLab = (c: string) => {
    if (pairs.has(c)) return false;
    const got = sectionsOf(c);
    return (
      !("error" in got) &&
      got.all.length > 0 &&
      got.all.every(
        (x) => (x.creditHours ?? 0) === 0 && /laborator/i.test(x.title),
      )
    );
  };
  const shift = (c: string, by: number) => {
    const [subj, num] = c.split(" ");
    return `${subj} ${String(Number(num) + by).padStart(num!.length, "0")}`;
  };
  for (const c of codes) {
    if (pairs.has(c) || !/^\S+ \d+$/.test(c)) continue;
    const [lab, lecture] = snapshotLab(c)
      ? [c, shift(c, -1)]
      : [shift(c, 1), c];
    if (lab !== c && !snapshotLab(lab)) continue;
    const lec = sectionsOf(lecture);
    if ("error" in lec || lec.all.length === 0 || pairs.has(lecture)) continue;
    pairs.set(lab, {
      title: null,
      credits: "0",
      lab: true,
      coreqs: [lecture],
      inferred: true,
    });
    pairs.set(lecture, {
      title: lec.all[0]!.title,
      credits: String(lec.all[0]!.creditHours ?? ""),
      lab: false,
      coreqs: [lab],
      inferred: true,
    });
  }

  const units: UnitVerdict[] = [];
  const byKey = new Map<string, UnitVerdict>();
  const graduate: string[] = [];
  const placeholdersOnly: string[] = [];
  for (const code of codes) {
    const memberCodes = unitOf(code, pairs);
    const lead = memberCodes[0]!;
    const key = memberCodes.join("+");
    const seen = byKey.get(key);
    if (seen) {
      if (opts.codes && code !== lead && !seen.requested_as?.includes(code))
        (seen.requested_as ??= []).push(code);
      continue;
    }
    if (
      opts.subject &&
      !opts.includeGraduate &&
      courseNumber(lead) >= GRADUATE_FROM
    ) {
      if (!graduate.includes(lead)) graduate.push(lead);
      byKey.set(key, { course: lead } as UnitVerdict);
      continue;
    }

    const members: Member[] = [];
    for (const [i, mc] of memberCodes.entries()) {
      const got = sectionsOf(mc);
      if ("error" in got) return got;
      // Zero-capacity sections are Banner placeholders, not seats.
      let passing = got.passing.filter((s) => s.maxEnrollment > 0);
      if (i === 0 && credits !== undefined)
        passing = passing.filter(
          (s) =>
            s.creditHours !== null && Math.abs(s.creditHours - credits) < 0.01,
        );
      const fitting: EngineSection[] = [];
      const blocked: Member["blocked"] = [];
      for (const s of passing) {
        const by = blockers(s, anchors);
        if (by.length === 0) fitting.push(s);
        else blocked.push({ crn: s.crn, meetings: s.meetings, blocked_by: by });
      }
      members.push({
        code: mc,
        role: pairs.get(mc)?.lab ? "required lab" : "corequisite",
        all: got.all,
        passing,
        fitting,
        blocked,
      });
    }
    const leadM = members[0]!;
    const kept = memberCodes.flatMap((c) => keptBy.get(c) ?? []);
    const replaced = memberCodes.map((c) => replacedBy.get(c)).find(Boolean);
    const real = leadM.all.filter((s) => s.maxEnrollment > 0);
    if (
      opts.subject &&
      leadM.all.length > 0 &&
      real.length === 0 &&
      !kept.length
    ) {
      placeholdersOnly.push(lead);
      byKey.set(key, { course: lead } as UnitVerdict);
      continue;
    }

    // Every choice of one fitting section per member that clears itself.
    const combos: EngineSection[][] = [];
    let tried = 0;
    const walk = (i: number, picked: EngineSection[]) => {
      if (tried >= MAX_COMBINATIONS) return;
      if (i === members.length) {
        tried++;
        combos.push(picked);
        return;
      }
      for (const s of members[i]!.fitting)
        if (!picked.some((p) => clash(p, s))) walk(i + 1, [...picked, s]);
    };
    if (members.every((m) => m.fitting.length > 0)) walk(0, []);
    const fits = combos.length > 0;

    let reason: string | undefined;
    if (!fits) {
      const failing = members.find((m) => m.fitting.length === 0);
      if (!failing)
        reason =
          `the fitting ${members.map((m) => m.code).join(" and ")} sections ` +
          "conflict with each other";
      else {
        const what =
          failing === leadM ? failing.code : `${failing.role} ${failing.code}`;
        const blockedBy = [
          ...new Set(failing.blocked.flatMap((b) => b.blocked_by)),
        ];
        if (failing.all.length === 0)
          reason = `${what} is not offered this term`;
        else if (!failing.all.some((s) => s.maxEnrollment > 0))
          reason = `${what} has only zero-capacity placeholder sections`;
        else if (failing.passing.length === 0)
          reason = `no ${what} section passes the filters`;
        else
          reason =
            `every ${what} section conflicts with kept CRN` +
            `${blockedBy.length > 1 ? "s" : ""} ${blockedBy.join(", ")}`;
      }
    }
    const timed = combos.some((c) => c.some((s) => s.meetings.length > 0));
    const leadFitting = leadM.fitting.filter((s) =>
      combos.some((c) => c[0] === s),
    );
    const outside = leadM.all.length - leadM.passing.length;
    const placeholders = members.reduce(
      (n, m) => n + m.all.filter((s) => s.maxEnrollment === 0).length,
      0,
    );
    const u: UnitVerdict = {
      course: lead,
      title: pairs.get(lead)?.title ?? leadM.all[0]?.title,
      ...(memberCodes.some((c) => pairs.get(c)?.inferred)
        ? {
            pairing_note:
              "Not in the catalog: the lab pairing is inferred from the " +
              "schedule (a 0-credit laboratory numbered one above the course).",
          }
        : {}),
      ...(memberCodes.length > 1 ? { with: memberCodes.slice(1) } : {}),
      ...(opts.codes && code !== lead ? { requested_as: [code] } : {}),
      offered:
        leadM.all.length > 0 || kept.length > 0 || replaced !== undefined,
      ...(kept.length ? { already_kept: kept } : {}),
      ...(replaced ? { replaced_section: replaced } : {}),
      fits,
      ...(fits ? { how: timed ? "timed" : "arranged" } : {}),
      ...(fits
        ? {
            options_count: combos.length,
            options: combos.slice(0, SECTIONS_SHOWN).map((c) => ({
              crns: c.map((s) => s.crn),
              credit_hours: c[0]!.creditHours,
              sections: c.map((s) => ({
                crn: s.crn,
                course: spaced(s.subjectCourse),
                credit_hours: s.creditHours,
                seats_available: s.seatsAvailable,
                meetings: s.meetings,
              })),
            })),
            ...(combos.length > SECTIONS_SHOWN
              ? {
                  options_note:
                    `${SECTIONS_SHOWN} of ${combos.length}` +
                    `${tried >= MAX_COMBINATIONS ? "+" : ""} section choices shown.`,
                }
              : {}),
          }
        : { reason }),
      fitting_count: leadFitting.length,
      fitting: leadFitting.slice(0, SECTIONS_SHOWN),
      ...(leadFitting.length > SECTIONS_SHOWN
        ? {
            fitting_note: `${SECTIONS_SHOWN} of ${leadFitting.length} fitting sections shown.`,
          }
        : {}),
      ...(fits ? {} : { blocked: leadM.blocked.slice(0, SECTIONS_SHOWN) }),
      ...(outside > 0 ? { outside_filters: outside } : {}),
      ...(placeholders > 0 ? { placeholders_skipped: placeholders } : {}),
    };
    byKey.set(key, u);
    units.push(u);
  }
  return {
    snapshotDate,
    units,
    unknownCrns: keepers.filter((c) => !found.has(c)),
    graduate,
    placeholdersOnly,
    coreqsUnchecked: catalog === null,
  };
}

/** "2 courses can be added: …" — the count a model relays, computed here. */
export function canAddText(canAdd: string[], arranged: string[]): string {
  if (canAdd.length === 0)
    return "No course can be added around the kept CRNs.";
  const list = canAdd
    .map((c) =>
      arranged.includes(c) ? `${c} (arranged, no set meeting times)` : c,
    )
    .join(", ");
  return `${canAdd.length} course${canAdd.length === 1 ? "" : "s"} can be added: ${list}.`;
}
