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
// A course and its corequisites (lecture + lab; catalog coreq_parsed) are one
// UNIT. It fits when some choice of one section per member clears every kept
// CRN and the chosen sections clear each other. A lab shared by alternative
// lectures (BIOL 1200 with BIOL 1220 OR 1230) joins each lecture's unit; it
// never makes the lectures require each other. A member the student already
// keeps is satisfied: the verdict is about the rest. Sections with no meeting
// times never clash; a unit whose fitting choices are all untimed is
// "arranged". The lead — the course reported — is the credit-bearing course,
// never the lab.

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

type Relation = CoreqCatalogEntry & { inferred?: true };

/** Why a unit does not fit — the summary bucket follows from it. */
export type Failure =
  | "conflicts" // every section of a member clashes with kept CRNs
  | "halves_clash" // members fit alone, never together
  | "filters" // no section (or no choice's credit total) passes the filters
  | "not_offered"
  | "placeholders_only"
  | "unpaired_lab" // a 0-credit lab whose lecture cannot be determined
  | "no_other_section"; // its only sections are kept or being dropped

interface Member {
  code: string;
  role: string;
  all: EngineSection[];
  real: EngineSection[];
  passing: EngineSection[];
  fitting: EngineSection[];
  blocked: {
    crn: string;
    course: string;
    meetings: EngineMeeting[];
    blocked_by: string[];
  }[];
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
const creditsOf = (e: Relation | undefined) =>
  Number.parseFloat(e?.credits ?? "") || 0;
const LAB_TITLE = /\blab\b|laborator/i;
/** A title without its lab words, for matching a lab to its lecture. */
const titleKey = (t: string) =>
  (
    t
      .replace(/&amp;/g, "&")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  )
    .filter((w) => w !== "lab" && w !== "laboratory")
    .join(" ");

function creditTotal(choice: EngineSection[]): number | null {
  const known = choice.filter((s) => s.creditHours !== null);
  return known.length
    ? known.reduce((n, s) => n + (s.creditHours ?? 0), 0)
    : null;
}

export interface UnitVerdict {
  course: string;
  title?: string;
  pairing_note?: string;
  with?: string[];
  requested_as?: string[];
  offered: boolean;
  already_kept?: string[];
  /** Kept members cover part of the unit: these are what she would add. */
  adds?: string[];
  replaced_section?: string;
  fits: boolean;
  how?: "timed" | "arranged";
  failure?: Failure;
  reason?: string;
  /** Every section choice that fits, the lead's section first. */
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
  /** The lead's own fitting sections (courses mode has always returned these). */
  fitting_count: number;
  fitting?: EngineSection[];
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
  unpairedLabs: string[];
  /** A kept course tied to the course being dropped (its lab, say). */
  orphans: { kept: string; with: string }[];
  coreqsUnchecked: boolean;
}

/**
 * Verdicts for `codes` (courses mode) or for every course in `subject`
 * (subject mode: graduate courses, courses with only placeholder sections and
 * labs whose lecture cannot be determined are set aside, and named).
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
  const subjectMode = opts.subject !== undefined;
  const { credits, ...memberFilters } = opts.filters;
  const timeFilter =
    memberFilters.days !== undefined ||
    (memberFilters.excludeDays?.length ?? 0) > 0 ||
    memberFilters.noMeetingBefore !== undefined ||
    memberFilters.noMeetingAfter !== undefined;
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
  // filters (credits aside — they apply to a whole choice's total).
  const bySubject = new Map<
    string,
    { all: Map<string, EngineSection[]>; passing: Map<string, EngineSection[]> }
  >();
  let snapshotDate: string | null = null;
  let failed: { error: string } | null = null;
  const sectionsOf = (
    code: string,
  ): { all: EngineSection[]; passing: EngineSection[] } => {
    const subject = code.split(" ")[0]!;
    let got = bySubject.get(subject);
    if (!got) {
      const base = { term, subject, excludeCrns, unpaged: true };
      const all = querySectionsEngine(base);
      const passing = querySectionsEngine({
        ...base,
        ...memberFilters,
        excludeCrns,
      });
      if ("error" in all || "error" in passing) {
        failed ??= "error" in all ? all : (passing as { error: string });
        return { all: [], passing: [] };
      }
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
    sectionsOf(`${opts.subject} 0`);
    if (failed) return failed;
    codes = [...bySubject.get(opts.subject)!.all.keys()].sort();
  }
  const catalog = coreqCatalog(codes);
  const rel = new Map<string, Relation>(catalog ?? []);

  // A 0-credit lab the catalog does not pair (the catalog holds undergraduate
  // courses only) is paired with the course numbered one below when every
  // lab section's title is that course's title plus "Lab"/"Laboratory"
  // (PKSC 6301 with PKSC 6300). Anything looser is not guessed: a Creative
  // Inquiry lab belongs to one topic of its course, not to every section.
  const zeroCreditLab = (c: string) => {
    const all = sectionsOf(c).all;
    return (
      all.length > 0 &&
      all.every((s) => s.creditHours === 0) &&
      all.some((s) => LAB_TITLE.test(s.title))
    );
  };
  const below = (c: string) => {
    const [subj, num] = c.split(" ");
    return /^\d+$/.test(num ?? "") && Number(num) > 0
      ? `${subj} ${String(Number(num) - 1).padStart(num!.length, "0")}`
      : null;
  };
  const candidateLabs = new Set<string>();
  for (const c of codes) {
    candidateLabs.add(c);
    const [subj, num] = c.split(" ");
    if (/^\d+$/.test(num ?? ""))
      candidateLabs.add(
        `${subj} ${String(Number(num) + 1).padStart(num!.length, "0")}`,
      );
  }
  const unpairedLab = new Set<string>();
  for (const lab of candidateLabs) {
    if ((rel.get(lab)?.coreqs.length ?? 0) > 0 || !zeroCreditLab(lab)) continue;
    const lecture = below(lab);
    const labTitles = new Set(
      sectionsOf(lab).all.map((s) => titleKey(s.title)),
    );
    const lecSections = lecture ? sectionsOf(lecture).all : [];
    const lecTitles = new Set(lecSections.map((s) => titleKey(s.title)));
    const lecRel = lecture ? rel.get(lecture) : undefined;
    if (
      lecture &&
      lecSections.length > 0 &&
      (lecRel?.coreqs.length ?? 0) === 0 &&
      labTitles.size === 1 &&
      lecTitles.size === 1 &&
      [...labTitles][0] === [...lecTitles][0]
    ) {
      rel.set(lab, {
        title: sectionsOf(lab).all[0]!.title,
        credits: "0",
        lab: true,
        coreqs: [lecture],
        inferred: true,
      });
      rel.set(lecture, {
        title: lecRel?.title ?? lecSections[0]!.title,
        credits: lecRel?.credits ?? String(lecSections[0]!.creditHours ?? ""),
        lab: false,
        coreqs: [lab],
        inferred: true,
      });
    } else unpairedLab.add(lab);
  }
  if (failed) return failed;

  const isLab = (c: string) => rel.get(c)?.lab ?? false;
  /** The credit-bearing course(s) a code is reported under. */
  const leadsFor = (code: string, seen = new Set([code])): string[] => {
    const e = rel.get(code);
    if (!e?.lab || e.coreqs.length === 0) return [code];
    const out: string[] = [];
    for (const c of e.coreqs)
      if (!seen.has(c)) {
        seen.add(c);
        for (const l of leadsFor(c, seen)) if (!out.includes(l)) out.push(l);
      }
    return out.length ? out : [code];
  };
  /** The lead and what it must be taken with: a shared lab's other
   *  lectures are alternatives, never added (BIOL 1200's 1220 vs 1230). */
  const unitOf = (lead: string): string[] => {
    const members = new Set([lead]);
    const todo: [string, string | null][] = [[lead, null]];
    while (todo.length) {
      const [node, parent] = todo.pop()!;
      const coreqs = rel.get(node)?.coreqs ?? [];
      for (const c of coreqs) {
        if (members.has(c)) continue;
        if (parent !== null && coreqs.length > 1 && isLab(c) === isLab(parent))
          continue;
        members.add(c);
        todo.push([c, node]);
      }
    }
    const rank = (c: string) =>
      [isLab(c) ? 1 : 0, -creditsOf(rel.get(c))] as const;
    const sorted = [...members].sort((a, b) => {
      const [la, ca] = rank(a);
      const [lb, cb] = rank(b);
      return la - lb || ca - cb || a.localeCompare(b);
    });
    return [sorted[0]!, ...sorted.slice(1).sort()];
  };

  const units: UnitVerdict[] = [];
  const byKey = new Map<string, UnitVerdict | null>();
  const graduate: string[] = [];
  const placeholdersOnly: string[] = [];
  const unpairedLabs: string[] = [];
  for (const code of codes) {
    if (unpairedLab.has(code) && leadsFor(code)[0] === code) {
      if (subjectMode) {
        if (
          !keptBy.has(code) &&
          (opts.includeGraduate || courseNumber(code) < GRADUATE_FROM)
        )
          unpairedLabs.push(code);
        continue;
      }
      units.push({
        course: code,
        offered: true,
        fits: false,
        failure: "unpaired_lab",
        reason:
          `${code} is a lab whose lecture could not be determined; find the ` +
          "lecture it goes with and check that course instead.",
        fitting_count: 0,
      });
      continue;
    }
    for (const leadCode of leadsFor(code)) {
      const memberCodes = unitOf(leadCode);
      const lead = memberCodes[0]!;
      const key = [...memberCodes].sort().join("+");
      if (byKey.has(key)) {
        const seen = byKey.get(key);
        if (
          seen &&
          !subjectMode &&
          code !== lead &&
          !seen.requested_as?.includes(code)
        )
          (seen.requested_as ??= []).push(code);
        continue;
      }
      if (
        subjectMode &&
        !opts.includeGraduate &&
        courseNumber(lead) >= GRADUATE_FROM
      ) {
        graduate.push(lead);
        byKey.set(key, null);
        continue;
      }
      const u = judge(code, memberCodes);
      if (!u) {
        placeholdersOnly.push(lead);
        byKey.set(key, null);
        continue;
      }
      byKey.set(key, u);
      units.push(u);
    }
  }
  if (failed) return failed;

  /** One unit's verdict; null when (subject mode) it has only placeholders. */
  function judge(asked: string, memberCodes: string[]): UnitVerdict | null {
    const lead = memberCodes[0]!;
    const kept = memberCodes.flatMap((c) => keptBy.get(c) ?? []);
    const keptMembers = memberCodes.filter((c) => keptBy.has(c));
    // Kept members are satisfied; the rest is what she would add. A unit she
    // keeps whole is judged as switching sections, as before.
    const adding =
      keptMembers.length === memberCodes.length
        ? memberCodes
        : memberCodes.filter((c) => !keptBy.has(c));
    const replaced = memberCodes.map((c) => replacedBy.get(c)).find(Boolean);
    const members: Member[] = adding.map((mc) => {
      const got = sectionsOf(mc);
      const real = got.all.filter((s) => s.maxEnrollment > 0);
      let passing = got.passing.filter((s) => s.maxEnrollment > 0);
      // A time window rules out a section with no times for the course she
      // chose, but a lab with arranged hours fits any window — still subject
      // to the seat filter.
      if (mc !== lead && timeFilter)
        passing = [
          ...passing,
          ...real.filter(
            (s) =>
              s.meetings.length === 0 &&
              !passing.includes(s) &&
              (!memberFilters.openSeatsOnly || s.seatsAvailable > 0),
          ),
        ];
      const fitting: EngineSection[] = [];
      const blocked: Member["blocked"] = [];
      for (const s of passing) {
        const by = blockers(s, anchors);
        if (by.length === 0) fitting.push(s);
        else
          blocked.push({
            crn: s.crn,
            course: mc,
            meetings: s.meetings,
            blocked_by: by,
          });
      }
      return {
        code: mc,
        role: isLab(mc) ? "required lab" : "corequisite",
        all: got.all,
        real,
        passing,
        fitting,
        blocked,
      };
    });
    const leadAll = sectionsOf(lead).all;
    if (
      subjectMode &&
      !kept.length &&
      leadAll.length > 0 &&
      !leadAll.some((s) => s.maxEnrollment > 0)
    )
      return null;

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
    const matching =
      credits === undefined
        ? combos
        : combos.filter((c) => {
            const t = creditTotal(c);
            return t !== null && Math.abs(t - credits) < 0.01;
          });
    const fits = matching.length > 0;

    let failure: Failure | undefined;
    let reason: string | undefined;
    let blocked: Member["blocked"] = [];
    if (!fits) {
      const failing = members.find((m) => m.fitting.length === 0);
      if (combos.length > 0) {
        failure = "filters";
        reason = `no choice of sections totals ${credits} credit hours`;
      } else if (!failing) {
        failure = "halves_clash";
        reason =
          `the fitting ${members.map((m) => m.code).join(" and ")} sections ` +
          "conflict with each other";
      } else {
        const what =
          failing.code === lead
            ? failing.code
            : `${failing.role} ${failing.code}`;
        blocked = failing.blocked;
        const by = [...new Set(failing.blocked.flatMap((b) => b.blocked_by))];
        if (
          failing.all.length === 0 &&
          (replacedBy.has(failing.code) || keptBy.has(failing.code))
        ) {
          failure = "no_other_section";
          reason = replacedBy.has(failing.code)
            ? `${what} has no section other than the one being dropped`
            : `${what} has no section other than the one she keeps`;
        } else if (failing.all.length === 0 && !keptBy.has(failing.code)) {
          failure = "not_offered";
          reason = `${what} is not offered this term`;
        } else if (failing.real.length === 0) {
          failure = "placeholders_only";
          reason = `${what} has only zero-capacity placeholder sections`;
        } else if (failing.passing.length === 0) {
          failure = "filters";
          reason = `no ${what} section passes the filters`;
        } else {
          failure = "conflicts";
          reason =
            `every ${what} section conflicts with kept CRN` +
            `${by.length > 1 ? "s" : ""} ${by.join(", ")}`;
        }
      }
    }
    const timed = matching.some((c) => c.some((s) => s.meetings.length > 0));
    const first = members[0]!;
    const firstFitting = first.fitting.filter((s) =>
      matching.some((c) => c[0] === s),
    );
    const outside = first.real.length - first.passing.length;
    const placeholders = members.reduce(
      (n, m) => n + (m.all.length - m.real.length),
      0,
    );
    const partlyKept =
      keptMembers.length > 0 && keptMembers.length < memberCodes.length;
    return {
      course: lead,
      title: rel.get(lead)?.title ?? leadAll[0]?.title,
      ...(memberCodes.some((c) => rel.get(c)?.inferred)
        ? {
            pairing_note:
              "Not in the catalog: the lab pairing is read from the " +
              "schedule (a 0-credit lab titled like the course, numbered " +
              "one above it).",
          }
        : {}),
      ...(memberCodes.length > 1 ? { with: memberCodes.slice(1) } : {}),
      ...(!subjectMode && asked !== lead ? { requested_as: [asked] } : {}),
      offered: leadAll.length > 0 || kept.length > 0 || replaced !== undefined,
      ...(kept.length ? { already_kept: kept } : {}),
      ...(partlyKept ? { adds: adding } : {}),
      ...(replaced ? { replaced_section: replaced } : {}),
      fits,
      ...(fits
        ? {
            how: timed ? ("timed" as const) : ("arranged" as const),
            options_count: matching.length,
            options: matching.slice(0, SECTIONS_SHOWN).map((c) => ({
              crns: c.map((s) => s.crn),
              credit_hours: creditTotal(c),
              sections: c.map((s) => ({
                crn: s.crn,
                course: spaced(s.subjectCourse),
                credit_hours: s.creditHours,
                seats_available: s.seatsAvailable,
                meetings: s.meetings,
              })),
            })),
            ...(matching.length > SECTIONS_SHOWN
              ? {
                  options_note:
                    `${SECTIONS_SHOWN} of ${matching.length}` +
                    `${tried >= MAX_COMBINATIONS ? "+" : ""} section choices shown.`,
                }
              : {}),
          }
        : { failure, reason }),
      fitting_count: firstFitting.length,
      // Subject mode answers with options alone: listing the same sections
      // twice made a big subject's answer 100+ KB.
      ...(subjectMode
        ? {}
        : {
            fitting: firstFitting.slice(0, SECTIONS_SHOWN),
            ...(firstFitting.length > SECTIONS_SHOWN
              ? {
                  fitting_note: `${SECTIONS_SHOWN} of ${firstFitting.length} fitting sections shown.`,
                }
              : {}),
          }),
      ...(fits ? {} : { blocked: blocked.slice(0, SECTIONS_SHOWN) }),
      ...(outside > 0 ? { outside_filters: outside } : {}),
      ...(placeholders > 0 ? { placeholders_skipped: placeholders } : {}),
    };
  }

  return {
    snapshotDate,
    units,
    unknownCrns: keepers.filter((c) => !found.has(c)),
    graduate,
    placeholdersOnly,
    unpairedLabs,
    orphans: [...replacedBy.keys()].flatMap((dropped) =>
      leadsFor(dropped)
        .flatMap(unitOf)
        .filter((c) => c !== dropped && keptBy.has(c))
        .map((kept) => ({ kept, with: dropped })),
    ),
    coreqsUnchecked: catalog === null,
  };
}

/** What a fitting unit adds, as the summary names it. */
export function addedName(u: UnitVerdict): string {
  return u.adds ? u.adds.join(" + ") : u.course;
}

/** "2 courses can be added: …" — the count a model relays, computed here. */
export function canAddText(adds: UnitVerdict[]): string {
  if (adds.length === 0) return "No course can be added around the kept CRNs.";
  const list = adds
    .map((u) => {
      const extra = [
        ...(u.adds
          ? [
              `to go with kept ${[u.course, ...(u.with ?? [])]
                .filter((c) => !u.adds!.includes(c))
                .join(" + ")}`,
            ]
          : []),
        ...(u.how === "arranged" ? ["arranged, no set meeting times"] : []),
      ];
      return extra.length
        ? `${addedName(u)} (${extra.join("; ")})`
        : addedName(u);
    })
    .join(", ");
  return `${adds.length} course${adds.length === 1 ? "" : "s"} can be added: ${list}.`;
}
