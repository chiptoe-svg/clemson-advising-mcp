// src/mcp-tools/clemson-schedule.ts
// Deterministic schedule-conflict tools backed by the per-term SQLite snapshot.
import {
  listSnapshotTerms,
  parseTermCode,
  resolveTerm,
} from "../term-resolve.js";
import {
  openScheduleDb,
  getScheduleDbMeta,
  getMeetingsForCrns,
  getSectionsByCrn,
  resolveCrns,
  matchInstructors,
  findInstructorMeetings,
  findInstructorSections,
  teachingLoadRows,
  type TeachingLoadRow,
  crossListRecorded,
  findConflicts,
  type ConflictPair,
  type SnapshotSection,
  minsToHHMM,
} from "../clemson-schedule-db.js";
import {
  searchCombinations,
  type CombinationMeeting,
  type CombinationSection,
} from "../section-combinations.js";
import { enrollmentHistory } from "../clemson-enrollment-history.js";
import { sameClass, slotSignature, type ClassKey } from "../cross-list.js";
import {
  openOfferingsDb,
  observedTerms,
  offeringsFor,
  seasonRollup,
  type SeasonRollup,
} from "../clemson-offerings-db.js";
import {
  loadOfferingDecisions,
  applyDecisions,
  type OfferingDecision,
} from "../offering-decisions.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

// find-section-combinations (2026-10-28). find-conflict-free-schedule (retired the
// same day) checked every candidate against every other, so alternative sections of one course
// rule each other out and "which sections of A and B fit together" came back
// empty — read by the advisor as "impossible". Here each group is one need
// with alternative sections, and a zero always carries its reason.
const MAX_GROUPS = 8;
const MAX_BUSY = 10;
const DAY_ORDER = "MTWRFSU";

/** "MW 1115–1400 Godfrey 205; F 0900–0950 Online" */
function describeMeetings(s: SnapshotSection): string {
  const byKey = new Map<string, string[]>();
  for (const m of s.meetings) {
    if (m.start_min == null || m.end_min == null) continue;
    const where = [m.building, m.room].filter(Boolean).join(" ");
    const key = `${minsToHHMM(m.start_min)}–${minsToHHMM(m.end_min)}${where ? " " + where : ""}`;
    byKey.set(key, [...(byKey.get(key) ?? []), m.day]);
  }
  if (byKey.size === 0) return "no meeting time (TBA/online)";
  return [...byKey]
    .map(
      ([key, days]) =>
        `${[...new Set(days)].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b)).join("")} ${key}`,
    )
    .join("; ");
}

function toCombination(s: SnapshotSection): CombinationSection {
  return {
    crn: s.crn,
    meetings: s.meetings
      .filter((m) => m.start_min != null && m.end_min != null)
      .map((m) => ({ day: m.day, startMin: m.start_min!, endMin: m.end_min! })),
  };
}

function hhmmToMins(t: string): number | null {
  if (!/^\d{4}$/.test(t)) return null;
  const h = Number(t.slice(0, 2));
  const m = Number(t.slice(2));
  return h < 24 && m < 60 ? h * 60 + m : null;
}

const findSectionCombinations: McpToolDefinition = {
  operation: "clemson.find_section_combinations",
  category: "scheduling",
  tool: {
    name: "find-section-combinations",
    description:
      "Which sections of several courses can be taken TOGETHER: pick one " +
      "section per group so nothing overlaps. Each group is one course (or a " +
      "list of alternative CRNs); sections in the same group are alternatives " +
      "and are never compared with each other. Optional fixed_crns (already " +
      "registered) and busy blocks (work hours, or a HYPOTHETICAL meeting time " +
      "such as a course proposed to move) remove the sections they overlap. " +
      "Returns every conflict-free combination (count, up to 20 listed) and, " +
      "when there are none, `blocking` — the reason: a course emptied by the " +
      "fixed/busy times, two courses with no compatible pair, or no choice " +
      "fitting all at once. Use this for every 'can these fit together / is " +
      "there a conflict-free combination' question, especially before saying " +
      "no. Reads the daily Banner snapshot; seats are not considered.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            'Term: a code (202701) or a name ("Spring 2027"). Defaults to the current registration term.',
        },
        fixed_crns: {
          type: "array",
          items: { type: "string" },
          description:
            "CRNs already locked in; every pick must fit around them.",
        },
        groups: {
          type: "array",
          description: `One entry per course needed (1–${MAX_GROUPS}). One section is chosen from each.`,
          items: {
            type: "object",
            properties: {
              course: {
                type: "string",
                description:
                  'A course code ("GC 4061"): all its sections in the term.',
              },
              crns: {
                type: "array",
                items: { type: "string" },
                description: "Alternative CRNs instead of a course code.",
              },
              label: {
                type: "string",
                description: "Optional name for the group.",
              },
            },
          },
        },
        busy: {
          type: "array",
          description: `Times no section may overlap (up to ${MAX_BUSY}).`,
          items: {
            type: "object",
            properties: {
              days: {
                type: "string",
                description:
                  'Day letters from MTWRFSU, R = Thursday, e.g. "MW" or "TR".',
              },
              start: {
                type: "string",
                description: "24-hour HHMM, e.g. 1415.",
              },
              end: { type: "string", description: "24-hour HHMM, e.g. 1700." },
              label: {
                type: "string",
                description: 'e.g. "GC 3401 (proposed)" or "work".',
              },
            },
            required: ["days", "start", "end"],
          },
        },
      },
      required: ["groups"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.find_section_combinations");
    } catch (e) {
      return permissionErr(e);
    }
    const rawGroups = args.groups;
    if (
      !Array.isArray(rawGroups) ||
      rawGroups.length === 0 ||
      rawGroups.length > MAX_GROUPS
    )
      return err(`groups must be a list of 1–${MAX_GROUPS} entries`);
    const fixedCrns = args.fixed_crns ?? [];
    if (
      !Array.isArray(fixedCrns) ||
      !fixedCrns.every((c) => typeof c === "string")
    )
      return err("fixed_crns must be a list of CRN strings");
    const rawBusy = args.busy ?? [];
    if (!Array.isArray(rawBusy) || rawBusy.length > MAX_BUSY)
      return err(`busy must be a list of at most ${MAX_BUSY} blocks`);

    const busy: { label: string; meetings: CombinationMeeting[] }[] = [];
    for (const [i, b] of rawBusy.entries()) {
      const x = (b ?? {}) as Record<string, unknown>;
      const days = String(x.days ?? "").toUpperCase();
      const start = hhmmToMins(String(x.start ?? ""));
      const end = hhmmToMins(String(x.end ?? ""));
      if (!/^[MTWRFSU]+$/.test(days))
        return err(
          `busy[${i}].days must use the letters MTWRFSU (R = Thursday)`,
        );
      if (start == null || end == null || start >= end)
        return err(
          `busy[${i}] needs start and end as 24-hour HHMM, start before end`,
        );
      busy.push({
        label:
          typeof x.label === "string" && x.label
            ? x.label
            : `busy ${days} ${x.start}–${x.end}`,
        meetings: [...new Set(days)].map((day) => ({
          day,
          startMin: start,
          endMin: end,
        })),
      });
    }

    const groupSpecs: { label: string; course?: string; crns?: string[] }[] =
      [];
    for (const [i, g] of rawGroups.entries()) {
      const x = (g ?? {}) as Record<string, unknown>;
      const hasCourse = typeof x.course === "string" && x.course.trim() !== "";
      const hasCrns =
        Array.isArray(x.crns) &&
        x.crns.length > 0 &&
        x.crns.every((c) => typeof c === "string");
      if (hasCourse === hasCrns)
        return err(
          `groups[${i}] needs exactly one of course or a non-empty crns list`,
        );
      const course = hasCourse
        ? (x.course as string)
            .trim()
            .toUpperCase()
            .replace(/^([A-Z]+)\s*(\d)/, "$1 $2")
        : undefined;
      groupSpecs.push({
        label:
          typeof x.label === "string" && x.label
            ? x.label
            : (course ?? `group ${i + 1}`),
        course,
        crns: hasCrns ? (x.crns as string[]) : undefined,
      });
    }

    const resolved = resolveTerm(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in resolved) return err(resolved.error);
    const { term } = resolved;
    const db = openScheduleDb(term);
    if (!db)
      return err(
        `No snapshot available for term ${term}. Run the daily refresh or try again after 05:00.`,
      );
    try {
      const courseStmt = db.prepare(
        `SELECT crn FROM sections
          WHERE term = ? AND UPPER(REPLACE(subject_course, ' ', '')) = ?
          ORDER BY section`,
      );
      const notes: string[] = [];
      const groupCrns = groupSpecs.map((g) => {
        if (g.crns) return [...new Set(g.crns)];
        const rows = courseStmt.all(term, g.course!.replace(/\s+/g, "")) as {
          crn: string;
        }[];
        if (rows.length === 0)
          notes.push(`The ${term} snapshot lists no sections of ${g.course}.`);
        return rows.map((r) => r.crn);
      });

      const { sections, notFound } = getSectionsByCrn(db, term, [
        ...fixedCrns,
        ...groupCrns.flat(),
      ]);
      const byCrn = new Map(sections.map((s) => [s.crn, s]));
      if (notFound.length > 0)
        notes.push(
          `Not in the ${term} snapshot (left out): ${notFound.join(", ")}.`,
        );

      const fixed = fixedCrns
        .filter((c) => byCrn.has(c))
        .map((c) => byCrn.get(c)!);
      for (const c of findConflicts(
        getMeetingsForCrns(
          db,
          term,
          fixed.map((s) => s.crn),
        ),
      ))
        notes.push(
          `Fixed CRNs ${c.crn_a} and ${c.crn_b} already overlap each other (${c.day} ${c.overlap_start}–${c.overlap_end}).`,
        );

      const groups = groupSpecs.map((g, i) => ({
        label: g.label,
        sections: groupCrns[i]!.filter((c) => byCrn.has(c)).map((c) =>
          toCombination(byCrn.get(c)!),
        ),
      }));
      const tba = groups
        .flatMap((g) => g.sections)
        .filter((s) => s.meetings.length === 0)
        .map((s) => s.crn);
      if (tba.length > 0)
        notes.push(
          `No meeting time (TBA/online), so they fit anything — not a guarantee: ${[...new Set(tba)].join(", ")}.`,
        );

      const r = searchCombinations({
        groups,
        fixed: fixed.map(toCombination),
        busy,
      });
      if (!r.complete)
        notes.push(
          "SEARCH INCOMPLETE: too many sections to check every combination. " +
            "The count is a lower bound; narrow the groups (fewer CRNs) or add fixed CRNs.",
        );

      const shown = new Set([
        ...fixed.map((s) => s.crn),
        ...groups.flatMap((g) => g.sections.map((s) => s.crn)),
      ]);
      return okJson({
        term,
        snapshot_date: getScheduleDbMeta(db).fetchedAt,
        fixed_crns: fixed.map((s) => s.crn),
        busy: busy.map((b) => b.label),
        combination_count: r.count,
        count_capped: r.countCapped,
        search_complete: r.complete,
        combinations: r.combinations,
        blocking: r.blocking,
        groups: r.groups,
        sections: Object.fromEntries(
          [...shown].map((c) => {
            const s = byCrn.get(c)!;
            return [
              c,
              {
                course: s.subject_course.replace(/^([A-Z]+)(\d)/, "$1 $2"),
                section: s.section,
                title: s.title,
                meets: describeMeetings(s),
              },
            ];
          }),
        ),
        notes,
      });
    } finally {
      db.close();
    }
  },
};

// get-schedule-freshness — moved here from clemson-advising.ts (2026-08-26): it
// reads only the Banner snapshot's meta row, so it belongs with the schedule
// tools on the public server, beside list-clemson-terms.
// Report when a term's Banner snapshot was last ingested — the "data as of"
// for every seat/section/time/room answer. Reads only the snapshot's meta row,
// so it puts no load on Banner and is safe to call freely.
export const scheduleFreshness: McpToolDefinition = {
  operation: "clemson.schedule_freshness",
  category: "meta",
  tool: {
    name: "get-schedule-freshness",
    description:
      "Report when the Banner class-schedule snapshot for a term was last " +
      "ingested — the 'data as of' time behind every seat count, section, " +
      "meeting time, and room this assistant reports. Read-only and cheap: it " +
      "reads only the snapshot's metadata, with NO Banner load. Use it to tell " +
      "an advisor how current the seat numbers are, or to check whether a term " +
      "has been ingested yet. The current registration term's snapshot refreshes " +
      "automatically each morning (~05:00 Eastern); other terms are ingested on " +
      "demand. Returns has_snapshot:false for a term not yet ingested.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            'Term: a code (202608) or a name ("Fall 2026"). Defaults to the current registration term.',
        },
      },
      required: ["term"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.schedule_freshness");
    } catch (e) {
      return permissionErr(e);
    }

    // Parse but do NOT require a snapshot: reporting that a term has none is
    // this tool's entire job. What it must not do is report a term it failed
    // to understand as a term that was never ingested.
    const parsedTerm = parseTermCode(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in parsedTerm) return err(parsedTerm.error);
    const { term } = parsedTerm;

    const schedDb = openScheduleDb(term);
    if (!schedDb) {
      return okJson({
        term,
        has_snapshot: false,
        note:
          `No Banner snapshot for term ${term} yet. The current registration ` +
          `term refreshes each morning (~05:00 Eastern); other terms are ` +
          `ingested on demand.`,
      });
    }

    try {
      const meta = getScheduleDbMeta(schedDb);
      const parsed = meta.fetchedAt ? Date.parse(meta.fetchedAt) : NaN;
      const ageHours = Number.isNaN(parsed)
        ? null
        : Math.max(0, Math.round((Date.now() - parsed) / 3_600_000));
      return okJson({
        term,
        term_description: meta.termDescription,
        has_snapshot: true,
        data_as_of: meta.fetchedAt,
        age_hours: ageHours,
        _source: `Banner schedule ${meta.fetchedAt}`,
      });
    } finally {
      schedDb.close();
    }
  },
};

/**
 * Authoritative section rows by CRN, straight from the term snapshot.
 *
 * WHY IT EXISTS (2026-08-28). The advisor performs a host-side check that every
 * CRN in a model-proposed schedule is real before that schedule is rendered
 * into a printable document — the one artifact that leaves the building. A
 * model that fabricates a CRN believes it is correct, so the check cannot be
 * delegated back to the model; it has to be made against the snapshot. That
 * check used to read state/clemson/<term>.db off local disk, which works only
 * while the advisor and this server share a filesystem.
 *
 * The tools that already accept a CRN cannot serve it: get-course-details
 * returns Banner catalog prose (description, prerequisites, restrictions) and
 * check-conflicts returns only overlap windows. Neither returns the fields a
 * verification compares.
 *
 * NOT_FOUND IS THE LOAD-BEARING HALF of the response. A fabricated CRN that
 * came back as merely an absent row would be indistinguishable from a section
 * with no meetings, and that conflation is the exact failure the caller is
 * trying to catch.
 */
const sectionsByCrn: McpToolDefinition = {
  operation: "clemson.sections_by_crn",
  category: "scheduling",
  tool: {
    name: "get-sections-by-crn",
    description:
      "Look up one or more CRNs in a term's Banner snapshot and return what " +
      "the snapshot actually records for each: subject and course, section " +
      "number, credit hours, and every meeting (day, start/end time, building, " +
      "room). Use it to CONFIRM sections you already have CRNs for — checking a " +
      'proposed schedule against reality, or answering "what is CRN 81185". ' +
      "CRNs with no row come back in `not_found`, which is authoritative: the " +
      "snapshot was read and has no such CRN. For catalog prose (description, " +
      "prerequisites, restrictions) use get-course-details instead; for whether " +
      "sections clash, use check-conflicts. Read-only, no Banner load.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            'Term: a code (202608) or a name ("Fall 2026"). Defaults to the current registration term.',
        },
        crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs to look up. Duplicates are collapsed.",
        },
      },
      required: ["term", "crns"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        term: { type: "string" },
        has_snapshot: {
          type: "boolean",
          description:
            "False when this term has not been ingested. Distinct from an empty " +
            "result: no snapshot means NOTHING was checked, so `not_found` is " +
            "empty rather than listing every CRN as fake.",
        },
        snapshot_date: {
          type: ["string", "null"],
          description: "When the snapshot was ingested.",
        },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              crn: { type: "string" },
              subject_course: { type: "string" },
              section: { type: "string" },
              title: { type: "string" },
              credit_hours: {
                type: ["number", "null"],
                description:
                  "Null means the snapshot does not record it — not zero.",
              },
              meetings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    day: { type: "string", description: "M T W R F S U." },
                    start_min: {
                      type: ["number", "null"],
                      description:
                        "Minutes past midnight; null for an untimed meeting.",
                    },
                    end_min: { type: ["number", "null"] },
                    building: { type: ["string", "null"] },
                    room: { type: ["string", "null"] },
                  },
                  required: ["day"],
                },
              },
            },
            required: ["crn", "subject_course", "section", "title", "meetings"],
          },
        },
        not_found: {
          type: "array",
          items: { type: "string" },
          description:
            "CRNs the snapshot has no row for. AUTHORITATIVE when has_snapshot " +
            "is true: the snapshot was read and does not contain them.",
        },
      },
      required: ["term", "has_snapshot", "sections", "not_found"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.sections_by_crn");
    } catch (e) {
      return permissionErr(e);
    }
    // "Fall 2026" must resolve to 202608, not fall through to
    // has_snapshot:false — which reads as "that term was never ingested" about
    // a term whose snapshot was fetched this morning. Reproduced 2026-08-28.
    // Parse only: an absent snapshot is still reported, never implied.
    const parsedTerm = parseTermCode(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in parsedTerm) return err(parsedTerm.error);
    const { term } = parsedTerm;
    const crns = Array.isArray(args.crns)
      ? args.crns
          .filter((c): c is string => typeof c === "string")
          .map((c) => c.trim())
          .filter(Boolean)
      : [];
    if (crns.length === 0)
      return err("crns is required and must contain at least one CRN.");

    const db = openScheduleDb(term);
    if (!db) {
      // NOT an empty not_found list of every CRN. A term with no snapshot means
      // nothing was checked; saying otherwise would mark every real CRN fake.
      return okJson({
        term,
        has_snapshot: false,
        snapshot_date: null,
        sections: [],
        not_found: [],
        _note: `No snapshot for term ${term}, so no CRN could be checked.`,
      });
    }
    try {
      const meta = getScheduleDbMeta(db);
      const { sections, notFound } = getSectionsByCrn(db, term, crns);
      return okJson({
        term,
        has_snapshot: true,
        snapshot_date: meta.fetchedAt,
        sections,
        not_found: notFound,
      });
    } finally {
      db.close();
    }
  },
};

/**
 * CRNs for course + section pairs. The companion to get-sections-by-crn, for
 * the case where the caller has no CRN to look up: a Clemson Navigator
 * schedule export lists course and section but omits the CRN entirely.
 *
 * NULL MEANS "NO SINGLE MATCH" — nothing matched, or more than one did.
 * Ambiguity is reported as a null and never resolved by picking one, because
 * guessing between two sections silently places a student in a class they may
 * not be in.
 */
const resolveCrnsTool: McpToolDefinition = {
  operation: "clemson.resolve_crns",
  category: "scheduling",
  tool: {
    name: "resolve-crns",
    description:
      "Find the CRN for each course+section pair in a term's snapshot — for " +
      "schedule data that names courses and sections but carries no CRNs (a " +
      "Clemson Navigator export, a student typing their schedule out). Course " +
      'codes match with or without the space ("GC 3400" = "GC3400"). ' +
      "Results are aligned BY INDEX with the input. A null means NO SINGLE " +
      "match — either nothing matched or several did; it never guesses between " +
      "candidates. Read-only, no Banner load.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            'Term: a code (202608) or a name ("Fall 2026"). Defaults to the current registration term.',
        },
        sections: {
          type: "array",
          description:
            "Course + section pairs, in the order results should come back.",
          items: {
            type: "object",
            properties: {
              subject_course: {
                type: "string",
                description: 'e.g. "GC 3400" or "GC3400".',
              },
              section: { type: "string", description: 'e.g. "001".' },
            },
            required: ["subject_course", "section"],
          },
        },
      },
      required: ["term", "sections"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        term: { type: "string" },
        has_snapshot: {
          type: "boolean",
          description:
            "False when the term has not been ingested — nothing was resolved.",
        },
        crns: {
          type: "array",
          items: { type: ["string", "null"] },
          description:
            "Aligned by index with the input. Null = no single match (none, or ambiguous).",
        },
      },
      required: ["term", "has_snapshot", "crns"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.resolve_crns");
    } catch (e) {
      return permissionErr(e);
    }
    const parsedTerm = parseTermCode(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in parsedTerm) return err(parsedTerm.error);
    const { term } = parsedTerm;
    const raw = Array.isArray(args.sections) ? args.sections : [];
    const wanted = raw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({
        subjectCourse:
          typeof r.subject_course === "string" ? r.subject_course : "",
        section: typeof r.section === "string" ? r.section : "",
      }));
    if (wanted.length === 0) {
      return err(
        "sections is required and must contain at least one {subject_course, section}.",
      );
    }

    const db = openScheduleDb(term);
    if (!db) {
      return okJson({
        term,
        has_snapshot: false,
        crns: wanted.map(() => null),
        _note: `No snapshot for term ${term}, so no CRN could be resolved.`,
      });
    }
    try {
      return okJson({
        term,
        has_snapshot: true,
        crns: resolveCrns(db, term, wanted),
      });
    } finally {
      db.close();
    }
  },
};

/** Test-only handle on the tool definitions, so a test can drive a handler
 *  without standing up a server. */
/** "HHMM" -> minutes past midnight, or null when unparseable. */
function hhmmToMin(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{4}$/.test(v)) return null;
  const h = Number(v.slice(0, 2));
  const m = Number(v.slice(2, 4));
  return h > 23 || m > 59 ? null : h * 60 + m;
}

/**
 * Who on a list has a TEACHING conflict in a time window — "which of these
 * faculty teach Friday 11-12?" as one deterministic call instead of a guessed
 * search per person (search-classes requires a subject scope, so it cannot
 * answer "everything this person teaches" at all).
 *
 * THREE-STATE PER PERSON, because the failure this exists to avoid is a model
 * reading silence as availability: "free" means the snapshot has their
 * sections and none overlap; "not_teaching" means the snapshot has NO sections
 * for them this term — which says nothing about other commitments; an
 * ambiguous name returns the candidates rather than guessing a person.
 */
const instructorClasses: McpToolDefinition = {
  operation: "clemson.instructor_classes",
  category: "admin",
  tool: {
    name: "get-instructor-classes",
    description:
      "Everything each given instructor TEACHES in a term — the primitive " +
      'behind "what does Chip Tonkin teach?", "I want Tonkin\'s GC 4800", ' +
      'and, with the optional day/window filter, "who has a teaching ' +
      'conflict Friday 11-12?". Each entry may be an email, a name, or ' +
      "'Name <email>' (emails match exactly; names match when every word appears, in any order, and " +
      "an ambiguous name returns the candidates instead of guessing). Every " +
      "matched person gets their full section list with meetings, including " +
      "untimed sections (internships etc.: meetings [], timed: false — " +
      "listed, but never 'busy'). Statuses " +
      "are explicit: 'teaching' / 'not_teaching' without a filter; 'busy' " +
      "(with the overlapping meetings) / 'free' with one. 'not_teaching' " +
      "means no sections in this term's snapshot — NOT the same as free, and " +
      "it says nothing about non-teaching commitments. Snapshot-backed, " +
      "read-only, no Banner load.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            'Term: a code (202608) or a name ("Fall 2026"). Defaults to the current registration term.',
        },
        instructors: {
          type: "array",
          items: { type: "string" },
          description:
            'People to check: "Name <email>", a bare email, or a name. ' +
            "Semicolon-separated pastes should be split into entries first.",
        },
        days: {
          type: "string",
          description:
            "Optional day pattern using M T W R F S U, e.g. 'F'. With it, " +
            "each person is also classified busy/free against the day(s) " +
            "(and window, if given). Omit it to just list what they teach.",
        },
        window_start: {
          type: "string",
          description:
            "HHMM, e.g. '1100'. Omit both bounds to check the whole day(s).",
        },
        window_end: {
          type: "string",
          description: "HHMM, e.g. '1200'.",
        },
      },
      required: ["instructors"],
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.instructor_classes");
    } catch (e) {
      return permissionErr(e);
    }
    const parsedTerm = parseTermCode(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in parsedTerm) return err(parsedTerm.error);
    const { term } = parsedTerm;

    const rawList = Array.isArray(args.instructors)
      ? (args.instructors as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.trim() !== "",
        )
      : [];
    if (rawList.length === 0)
      return err(
        "instructors is required and must contain at least one entry.",
      );

    const daysRaw =
      typeof args.days === "string" ? args.days.toUpperCase() : "";
    const days = [...daysRaw].filter((d) => "MTWRFSU".includes(d));
    const filtering = args.days !== undefined;
    if (filtering && days.length === 0)
      return err("days must be a pattern of M T W R F S U, e.g. 'F'.");
    if (!filtering && args.window_start !== undefined)
      return err(
        "a window needs days too — pass days with window_start/window_end.",
      );

    const winStart = hhmmToMin(args.window_start);
    const winEnd = hhmmToMin(args.window_end);
    if ((args.window_start !== undefined) !== (args.window_end !== undefined))
      return err("window_start and window_end must be given together (HHMM).");
    if (
      args.window_start !== undefined &&
      (winStart === null || winEnd === null)
    )
      return err("window_start/window_end must be HHMM, e.g. '1100'.");

    const db = openScheduleDb(term);
    if (!db) {
      // Nothing was checked; claiming anyone free would be the exact failure
      // this tool exists to prevent.
      return okJson({
        term,
        has_snapshot: false,
        instructors: [],
        _note: `No snapshot for term ${term}, so no instructor could be checked.`,
      });
    }
    try {
      const meta = getScheduleDbMeta(db);
      const results = rawList.map((raw) => {
        // "Name <email>" -> prefer the email; else the raw string decides.
        const m = /<([^>]+@[^>]+)>/.exec(raw);
        const query = (m ? m[1] : raw).trim();
        const matches = matchInstructors(db, term, query);
        if (matches.length === 0) {
          return {
            query: raw,
            status: "not_teaching" as const,
            note:
              "No sections in this term's snapshot for this instructor — " +
              "NOT the same as free; other commitments are invisible here." +
              nameMissHint(query),
          };
        }
        if (matches.length > 1) {
          return {
            query: raw,
            status: "ambiguous" as const,
            candidates: matches,
            note: "Multiple instructors match — re-query with an exact email.",
          };
        }
        const who = matches[0];
        // The primitive: everything they teach, grouped by section.
        const allMeetings = findInstructorMeetings(
          db,
          term,
          who.email,
          who.name,
          ["M", "T", "W", "R", "F", "S", "U"],
          null,
          null,
        );
        const byCrn = new Map<
          string,
          {
            crn: string;
            subject_course: string;
            section: string;
            title: string;
            timed: boolean;
            meetings: {
              day: string;
              start_min: number | null;
              end_min: number | null;
              building: string | null;
              room: string | null;
            }[];
          }
        >();
        for (const m2 of allMeetings) {
          const e = byCrn.get(m2.crn) ?? {
            crn: m2.crn,
            subject_course: m2.subject_course,
            section: m2.section,
            title: m2.title,
            timed: false,
            meetings: [],
          };
          // Same rule as get-teaching-load: timed = has a meeting with times.
          if (m2.start_min !== null && m2.end_min !== null) e.timed = true;
          e.meetings.push({
            day: m2.day,
            start_min: m2.start_min,
            end_min: m2.end_min,
            building: m2.building,
            room: m2.room,
          });
          byCrn.set(m2.crn, e);
        }
        // Sections with no meeting rows never join above; list them too, or
        // an internship reads as "doesn't teach that course" (2026-10-07).
        for (const s2 of findInstructorSections(db, term, who.email, who.name))
          if (!byCrn.has(s2.crn))
            byCrn.set(s2.crn, { ...s2, timed: false, meetings: [] });
        const sections = [...byCrn.values()];
        if (!filtering) {
          return {
            query: raw,
            matched: who,
            status: "teaching" as const,
            sections,
          };
        }
        const conflicts = findInstructorMeetings(
          db,
          term,
          who.email,
          who.name,
          days,
          winStart,
          winEnd,
        );
        return {
          query: raw,
          matched: who,
          status: conflicts.length > 0 ? ("busy" as const) : ("free" as const),
          sections,
          conflicts,
        };
      });
      return okJson({
        term,
        has_snapshot: true,
        data_as_of: meta.fetchedAt,
        ...(filtering
          ? {
              days: days.join(""),
              ...(winStart !== null && winEnd !== null
                ? { window: { start_min: winStart, end_min: winEnd } }
                : {}),
              busy: results
                .filter((r) => r.status === "busy")
                .map((r) =>
                  "matched" in r
                    ? (r.matched as { name: string }).name
                    : r.query,
                ),
            }
          : {}),
        instructors: results,
        _source: `Banner schedule snapshot ${meta.fetchedAt} — teaching data only`,
      });
    } finally {
      db.close();
    }
  },
};

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

interface LoadSectionAgg {
  crn: string;
  subject_course: string;
  section: string;
  title: string;
  credit_hours: number | null;
  cross_list: string | null;
  slots: { day: string; start: number; end: number }[];
}

/** Weekly minutes a group's meetings cover, overlaps counted once. */
function unionMinutes(group: readonly LoadSectionAgg[]): number {
  const byDay = new Map<string, { start: number; end: number }[]>();
  for (const s of group)
    for (const t of s.slots) byDay.set(t.day, [...(byDay.get(t.day) ?? []), t]);
  let total = 0;
  for (const slots of byDay.values()) {
    slots.sort((a, b) => a.start - b.start);
    let { start, end } = slots[0]!;
    for (const t of slots.slice(1)) {
      if (t.start < end) end = Math.max(end, t.end);
      else {
        total += end - start;
        ({ start, end } = t);
      }
    }
    total += end - start;
  }
  return total;
}

/**
 * One person's sections -> classes: a cross-listed group (sameClass) is one
 * class (Chip, 2026-10-30). Anything else counts on its own, even at the
 * same time — that is a double booking, not a cross-listing. The lead is the
 * lowest course and section.
 */
function groupCrossListed(
  aggs: readonly LoadSectionAgg[],
  who: string,
): LoadSectionAgg[][] {
  const key = (s: LoadSectionAgg): ClassKey => ({
    course: s.subject_course,
    crossList: s.cross_list,
    slots: slotSignature(
      s.slots.map((t) => ({ day: t.day, start: t.start, end: t.end })),
    ),
    instructors: [who],
  });
  const groups: LoadSectionAgg[][] = [];
  for (const s of aggs) {
    const hits = groups.filter((g) => g.some((t) => sameClass(key(s), key(t))));
    for (const h of hits) groups.splice(groups.indexOf(h), 1);
    groups.push([s, ...hits.flat()]);
  }
  for (const g of groups)
    g.sort(
      (a, b) =>
        a.subject_course.localeCompare(b.subject_course) ||
        a.section.localeCompare(b.section),
    );
  return groups;
}

/**
 * Load rows -> per-person aggregates. Credit hours count once per SECTION no
 * matter how many meeting rows it has; contact minutes sum only timed rows;
 * a section with no timed meetings lands in untimed_sections instead of
 * silently contributing zero to a total that claims to describe it. A
 * cross-listed group counts once (groupCrossListed): its meetings' union, its
 * highest credit hours, the other sections under the lead's meets_with.
 */
function aggregateLoad(rows: TeachingLoadRow[]) {
  const people = new Map<
    string,
    { name: string; email: string | null; byCrn: Map<string, LoadSectionAgg> }
  >();
  for (const r of rows) {
    const key = `${r.name}|${r.email ?? ""}`;
    let p = people.get(key);
    if (!p) {
      p = { name: r.name, email: r.email, byCrn: new Map() };
      people.set(key, p);
    }
    let s = p.byCrn.get(r.crn);
    if (!s) {
      s = {
        crn: r.crn,
        subject_course: r.subject_course,
        section: r.section,
        title: r.title,
        credit_hours: r.credit_hours,
        cross_list: r.cross_list,
        slots: [],
      };
      p.byCrn.set(r.crn, s);
    }
    if (r.start_min !== null && r.end_min !== null)
      s.slots.push({ day: r.day ?? "", start: r.start_min, end: r.end_min });
  }
  return [...people.entries()].map(([who, p]) => {
    const classes = groupCrossListed([...p.byCrn.values()], who).map((g) => ({
      lead: g[0]!,
      others: g.slice(1),
      minutes: unionMinutes(g),
      timed: g.some((s) => s.slots.length > 0),
      credit: g.some((s) => s.credit_hours !== null)
        ? Math.max(...g.map((s) => s.credit_hours ?? 0))
        : null,
    }));
    const untimed = classes.filter((c) => !c.timed);
    // A variable-credit section with no credits set has no value to add;
    // counting it as 0 without saying so would understate the total.
    const unset = classes.filter((c) => c.credit === null);
    const totalMinutes = classes.reduce((a, c) => a + c.minutes, 0);
    return {
      name: p.name,
      email: p.email,
      sections_count: classes.length,
      contact_hours_weekly: round1(totalMinutes / 60),
      credit_hours: round1(classes.reduce((a, c) => a + (c.credit ?? 0), 0)),
      untimed_sections: {
        count: untimed.length,
        crns: untimed.map((c) => c.lead.crn),
      },
      ...(unset.length
        ? {
            credits_not_set: {
              count: unset.length,
              crns: unset.map((c) => c.lead.crn),
            },
          }
        : {}),
      sections: classes.map((c) => ({
        crn: c.lead.crn,
        subject_course: c.lead.subject_course,
        section: c.lead.section,
        title: c.lead.title,
        credit_hours: c.credit,
        weekly_contact_hours: round1(c.minutes / 60),
        timed: c.timed,
        ...(c.others.length
          ? {
              cross_list:
                c.lead.cross_list &&
                c.others.every((o) => o.cross_list === c.lead.cross_list)
                  ? c.lead.cross_list
                  : "unlabeled 4xxx/6xxx pair",
              meets_with: c.others.map((o) => ({
                crn: o.crn,
                subject_course: o.subject_course,
                section: o.section,
              })),
            }
          : {}),
      })),
    };
  });
}

/**
 * get-teaching-load: "how many contact hours do GC faculty have?" as one
 * deterministic call instead of meeting arithmetic across dozens of rows
 * in-model. Two load measures, both served and never conflated: weekly
 * contact hours (timed meeting durations) and credit hours (per section).
 * Untimed sections are reported SEPARATELY — folding them into a total would
 * be the silence-as-absence defect wearing a new face.
 */
const teachingLoad: McpToolDefinition = {
  operation: "clemson.teaching_load",
  category: "admin",
  tool: {
    name: "get-teaching-load",
    description:
      "Weekly teaching load per instructor, computed server-side from the " +
      "term snapshot — and the way to LIST everyone teaching a subject this " +
      'term ("who teaches GC?"). The primitive behind "how many contact hours does ' +
      'each GC faculty member have this semester?". Select by subject ' +
      "(e.g. 'GC': every instructor on that subject's sections, load counted " +
      "over those sections only) and/or by instructors ('Name <email>', a " +
      "bare email, or a name; emails match exactly, names when every word appears (any order), and " +
      "an ambiguous name returns candidates instead of guessing). Two " +
      "measures, kept separate: contact_hours_weekly sums timed meeting " +
      "durations; credit_hours sums section credit hours (a variable-credit " +
      "section with no credits set is listed in credits_not_set, not counted). " +
      "Sections with NO " +
      "timed meetings are NEVER folded into contact hours — they come back " +
      "in untimed_sections, so a total cannot silently hide an " +
      "online/arranged section. Co-taught sections attribute fully to each " +
      "listed instructor. Cross-listed sections one person teaches (Banner's " +
      "cross-list label: honors 002, 4xxx/6xxx, 1990-4990 seminars; or an " +
      "unlabeled 4xxx/6xxx pair at the same times) count ONCE, the others " +
      "under that section's meets_with. Other sections at the same time " +
      "count separately. Snapshot-backed, read-only, no Banner load.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            'Term: a code (202608) or a name ("Fall 2026"). Defaults to the current registration term.',
        },
        subject: {
          type: "string",
          description:
            "Subject code, e.g. 'GC'. Selects every instructor teaching " +
            "that subject's sections; load is then counted over those " +
            "sections only (the response's scope field says so).",
        },
        instructors: {
          type: "array",
          items: { type: "string" },
          description:
            'People to include: "Name <email>", a bare email, or a name. ' +
            "Combine with subject to scope their load to that subject.",
        },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.teaching_load");
    } catch (e) {
      return permissionErr(e);
    }
    const parsedTerm = parseTermCode(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in parsedTerm) return err(parsedTerm.error);
    const { term } = parsedTerm;

    const subject =
      typeof args.subject === "string"
        ? args.subject.trim().toUpperCase()
        : null;
    if (args.subject !== undefined && !/^[A-Z]{1,6}$/.test(subject ?? ""))
      return err("subject must be 1-6 letters, e.g. 'GC'.");
    const rawList = Array.isArray(args.instructors)
      ? (args.instructors as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.trim() !== "",
        )
      : [];
    if (!subject && rawList.length === 0)
      return err("Give a subject (e.g. 'GC'), a list of instructors, or both.");

    const db = openScheduleDb(term);
    if (!db) {
      // Nothing was computed; a zero here would be a lie.
      return okJson({
        term,
        has_snapshot: false,
        instructors: [],
        _note: `No snapshot for term ${term}, so no load could be computed.`,
      });
    }
    try {
      const meta = getScheduleDbMeta(db);
      let entries: unknown[];
      if (rawList.length === 0) {
        const all = aggregateLoad(
          teachingLoadRows(db, term, subject, null, null),
        );
        all.sort(
          (a, b) =>
            b.contact_hours_weekly - a.contact_hours_weekly ||
            a.name.localeCompare(b.name),
        );
        entries = all;
      } else {
        entries = rawList.map((raw) => {
          const m = /<([^>]+@[^>]+)>/.exec(raw);
          const query = (m ? m[1] : raw).trim();
          const matches = matchInstructors(db, term, query);
          if (matches.length === 0) {
            return {
              query: raw,
              status: "not_teaching" as const,
              note:
                "No sections in this term's snapshot for this instructor — " +
                "only published teaching is visible here, so this is not a " +
                "statement about their workload elsewhere." +
                nameMissHint(query),
            };
          }
          if (matches.length > 1) {
            return {
              query: raw,
              status: "ambiguous" as const,
              candidates: matches,
              note: "Multiple instructors match — re-query with an exact email.",
            };
          }
          const who = matches[0];
          const [load] = aggregateLoad(
            teachingLoadRows(db, term, subject, who.email, who.name),
          );
          if (!load) {
            // Reachable only with a subject filter: they teach this term,
            // just nothing under that subject.
            return {
              query: raw,
              matched: who,
              status: "teaching" as const,
              sections_count: 0,
              contact_hours_weekly: 0,
              credit_hours: 0,
              untimed_sections: { count: 0, crns: [] },
              sections: [],
              note: `Teaches this term, but no ${subject} sections — the subject scope excludes their other teaching.`,
            };
          }
          return {
            query: raw,
            matched: who,
            status: "teaching" as const,
            ...load,
          };
        });
      }
      return okJson({
        term,
        has_snapshot: true,
        data_as_of: meta.fetchedAt,
        ...(subject ? { subject } : {}),
        scope: subject
          ? `${subject} sections only — teaching outside ${subject} is NOT counted here`
          : "every section each matched instructor teaches this term",
        attribution:
          "Co-taught sections attribute fully to EACH listed instructor, so totals across people can exceed the section count. A cross-listed group counts once; see meets_with.",
        instructors: entries,
        ...(crossListRecorded(db)
          ? {}
          : {
              cross_list_note:
                "This snapshot predates Banner's cross-list labels, so only " +
                "unlabeled 4xxx/6xxx pairs were combined; honors and other " +
                "cross-listed sections may each count separately.",
            }),
        _source: `Banner schedule snapshot ${meta.fetchedAt} — teaching data only`,
      });
    } finally {
      db.close();
    }
  },
};

/**
 * get-course-offerings: when has a course actually RUN, from the per-term
 * Banner snapshots — the raw evidence a graduation planner derives offering
 * patterns from, served from a consolidated cache (clemson-offerings-db.ts)
 * that fingerprints the snapshot set and rebuilds itself when it changes —
 * frozen terms are precomputed, and the cache can never drift because its
 * source files are immutable once a term ends (Chip, 2026-09-06). The
 * three-state discipline is structural here: observed_terms says exactly
 * which terms were observed, so "no fall snapshot held" is distinguishable
 * from "observed a fall and the course did not run".
 */
/** Appended to not_teaching for a NAME query: agents read not_teaching as
 * definitive, so say what to try before concluding (2026-09-29). */
function nameMissHint(query: string): string {
  return query.includes("@")
    ? ""
    : " Names match when every word appears (any order); if a full name " +
        "finds nothing, try the surname alone or the email before concluding.";
}

const courseOfferings: McpToolDefinition = {
  operation: "clemson.course_offerings",
  category: "scheduling",
  tool: {
    name: "get-course-offerings",
    description:
      "Which terms each given course actually RAN, with section counts, " +
      "from every Banner term snapshot this deployment holds — the raw " +
      'evidence for offering patterns ("is GC 3400 a fall-only course?"). ' +
      "Batch-shaped: pass every course of a plan at once. Read " +
      "observed_terms first: a term absent there was NOT observed, so it is " +
      'UNKNOWN — never "not offered"; a term present there but missing ' +
      "from a course's offerings means the term was observed and the course " +
      "did not run. Each course also carries a seasons rollup per " +
      "fall/spring/summer: the evidence (offered/observed, recent, " +
      "consecutive_missed, last_offered) plus estimated_probability and a " +
      'student-communicable label for "will it run next spring?" — an ' +
      "era-aware recency-weighted estimate, never a commitment — unless a season carries known_decision, a RECORDED departmental decision that overrides the estimate (label: ruled out / confirmed). Course codes are matched as published per term, so a " +
      "renamed or retired course keeps its history under its old code. " +
      "Snapshot-backed, read-only, no Banner load.",
    inputSchema: {
      type: "object" as const,
      properties: {
        courses: {
          type: "array",
          items: { type: "string" },
          description:
            'Course codes, e.g. ["GC 3400", "MATH1060"] — spacing and case ' +
            "are normalized. Duplicates are collapsed.",
        },
      },
      required: ["courses"],
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.course_offerings");
    } catch (e) {
      return permissionErr(e);
    }
    const rawList = Array.isArray(args.courses)
      ? (args.courses as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.trim() !== "",
        )
      : [];
    if (rawList.length === 0)
      return err("courses is required and must contain at least one code.");
    if (rawList.length > 200)
      return err("At most 200 courses per call — split larger plans.");
    const codes = [
      ...new Set(rawList.map((c) => c.replace(/\s+/g, "").toUpperCase())),
    ];
    const bad = codes.filter((c) => !/^[A-Z]{1,6}\d{3,4}$/.test(c));
    if (bad.length > 0)
      return err(`Not course codes: ${bad.join(", ")} — e.g. "GC 3400".`);

    // Recorded decisions (state/offering-decisions.yaml): the third
    // provenance. Unreadable is an ERROR — an estimate that silently ignores
    // a recorded decision is the silence defect with a probability on it.
    let decisions: Map<string, OfferingDecision[]>;
    try {
      decisions = loadOfferingDecisions();
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
    // The consolidated cache: frozen terms precomputed, new snapshots
    // absorbed on the next open via the fingerprint check.
    const db = openOfferingsDb();
    let observed: ReturnType<typeof observedTerms>;
    let perCourse: ReturnType<typeof offeringsFor>;
    try {
      observed = observedTerms(db);
      perCourse = offeringsFor(db, codes);
    } finally {
      db.close();
    }
    if (observed.length === 0) {
      return okJson({
        observed_terms: [],
        courses: [],
        _note:
          "No term snapshots are held, so NOTHING was observed — this says nothing about any course's offerings.",
      });
    }
    return okJson({
      observed_terms: observed,
      seasons_note:
        "seasons carry BOTH the evidence (offered/observed whole-history, since_first_offered, recent = last 3, consecutive_missed, last_offered) AND estimated_probability with a label — an era-aware, recency-weighted estimate for the NEXT term of that season, clamped away from 0 and 1. Communicate it as an estimate from observed history, never as the registrar's commitment. EXCEPTION: a season carrying known_decision is a RECORDED DECISION and overrides the estimate — its label reads 'ruled out' or 'confirmed', and that, not the probability, is the answer to give.",
      courses: codes.map((code) => {
        const offerings = perCourse.get(code) ?? [];
        return {
          code,
          offerings,
          seasons: applyDecisions(
            seasonRollup(observed, offerings),
            decisions.get(code),
          ),
          ...(offerings.length === 0
            ? {
                note:
                  "Not seen in ANY held snapshot. Check observed_terms for " +
                  "coverage — a term with no snapshot is unknown, not " +
                  '"not offered".',
              }
            : {}),
        };
      }),
      _source:
        "Banner term snapshots held by this deployment — observed sections only, not a statement of intent",
    });
  },
};

/**
 * get-course-enrollment-history: section-level enrollment and capacity for a
 * course list across terms — the demand / capacity-planning read, and the
 * batch companion to get-course-offerings (which carries section COUNTS but no
 * enrollment).
 *
 * Exists because the same question was being asked as one search-classes call
 * per course per term: 196 calls, ~30 minutes. The server was 0.6% of that
 * (35 ms per round trip); the rest was one model generation per call. Batching
 * removes 195 inference round trips, not 7 seconds of I/O.
 */
const enrollmentHistoryTool: McpToolDefinition = {
  operation: "clemson.enrollment_history",
  category: "admin",
  tool: {
    name: "get-course-enrollment-history",
    description:
      "Section-level ENROLLMENT and CAPACITY per course per term, from the " +
      "held Banner snapshots — the read for demand and capacity planning. " +
      "Batch-shaped: pass every course and term at once (<=200 courses, <=50 " +
      "terms); omit terms to get every observed term. Per course-term: " +
      "section_count, total_enrollment, total_capacity, seats_available, " +
      "fill_rate, full_sections, max_section_enrollment, and (with " +
      "include_sections) the per-CRN rows. " +
      "READ observed_terms FIRST and heed each term's status: 'final' means " +
      "the snapshot was taken after the term ended so its numbers are " +
      "settled; 'in_term' means it was taken mid-term; 'pre_term' means it " +
      "was taken BEFORE the term began, so its enrollment reflects " +
      "registration in progress and is NOT comparable demand. A term absent " +
      "from observed_terms was never observed — UNKNOWN, never zero demand; " +
      "a term present there but absent from a course's list means the term " +
      "was observed and the course did not run. fill_rate can exceed 1.0 " +
      "(labs run over their listed cap); that is real, not an error. " +
      "Snapshot-backed, read-only, no Banner load.",
    inputSchema: {
      type: "object" as const,
      properties: {
        courses: {
          type: "array",
          items: { type: "string" },
          description:
            'Course codes, e.g. ["GC 3401", "gc3461"] — spacing and case are ' +
            "normalized, duplicates collapsed. At most 200.",
        },
        terms: {
          type: "array",
          items: { type: "string" },
          description:
            'Term codes, e.g. ["202508", "202608"]. Omit for every observed ' +
            "term. At most 50.",
        },
        include_sections: {
          type: "boolean",
          description:
            "Include the per-CRN rows behind each course-term aggregate " +
            "(default false). Aggregates are identical either way.",
        },
        section_size_threshold: {
          type: "number",
          description:
            "When set, each course-term also reports sections_at_threshold: " +
            "how many sections enrolled at or above this number. Use it for " +
            "a local capacity rule (e.g. a lab cap); there is no built-in " +
            "default, because the right threshold is a departmental fact.",
        },
      },
      required: ["courses"],
      additionalProperties: false,
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.enrollment_history");
    } catch (e) {
      return permissionErr(e);
    }
    const rawList = Array.isArray(args.courses)
      ? (args.courses as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.trim() !== "",
        )
      : [];
    if (rawList.length === 0)
      return err("courses is required and must contain at least one code.");
    if (rawList.length > 200)
      return err("At most 200 courses per call — split the request.");
    // Report the code the CALLER typed, not our normalized form — "NOT-A-CODE"
    // back at someone who wrote "not-a-code" reads like a second bug.
    const badRaw = rawList.filter(
      (c) => !/^[A-Z]{1,6}\d{3,4}$/.test(c.replace(/\s+/g, "").toUpperCase()),
    );
    if (badRaw.length > 0)
      return err(`Not course codes: ${badRaw.join(", ")} — e.g. "GC 3401".`);
    const codes = [
      ...new Set(rawList.map((c) => c.replace(/\s+/g, "").toUpperCase())),
    ];

    const allTerms = listSnapshotTerms();
    let terms = allTerms;
    if (args.terms !== undefined) {
      const rawTerms = Array.isArray(args.terms)
        ? (args.terms as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : [];
      if (rawTerms.length > 50)
        return err("At most 50 terms per call — split the request.");
      const badTerms = rawTerms.filter((t) => !/^\d{6}$/.test(t));
      if (badTerms.length > 0)
        return err(
          `Not term codes: ${badTerms.join(", ")} — six digits, e.g. "202508".`,
        );
      terms = [...new Set(rawTerms)];
    }

    const threshold =
      typeof args.section_size_threshold === "number"
        ? args.section_size_threshold
        : null;
    const { observed, byCourse } = enrollmentHistory(codes, terms, {
      includeSections: args.include_sections === true,
      sizeThreshold: threshold,
    });

    if (observed.length === 0) {
      return okJson({
        observed_terms: [],
        courses: [],
        _note:
          "None of the requested terms is held as a snapshot, so NOTHING was " +
          "observed — this says nothing about any course's enrollment.",
      });
    }
    const requestedNotHeld = terms.filter(
      (t: string) => !observed.some((o) => o.term === t),
    );
    return okJson({
      observed_terms: observed,
      ...(requestedNotHeld.length > 0
        ? { requested_terms_not_held: requestedNotHeld }
        : {}),
      status_note:
        "Each observed term carries a status: 'final' (snapshot taken after " +
        "the term ended — settled numbers), 'in_term' (taken during it), " +
        "'pre_term' (taken BEFORE it began — registration still in progress, " +
        "NOT comparable demand). Comparing a pre_term figure against final " +
        "ones shows a drop that is an artifact of when the snapshot was " +
        "taken, not a change in demand. Clemson's add/drop calendar is not " +
        "known here; judge an in_term figure with data_as_of.",
      courses: codes.map((code) => {
        const rows = byCourse.get(code) ?? [];
        return {
          course: code,
          terms: rows,
          ...(rows.length === 0
            ? {
                note:
                  "Not seen in ANY observed term. Check observed_terms for " +
                  'coverage — an unobserved term is unknown, not "no demand".',
              }
            : {}),
        };
      }),
      _source:
        "Banner term snapshots held by this deployment — enrollment as of each snapshot's data_as_of, not a registrar census",
    });
  },
};

export const __schedTools = {
  instructorClasses,
  teachingLoad,
  courseOfferings,
  findSectionCombinations,
  scheduleFreshness,
  sectionsByCrn,
  resolveCrns: resolveCrnsTool,
  enrollmentHistory: enrollmentHistoryTool,
};

registerTools([
  findSectionCombinations,
  scheduleFreshness,
  sectionsByCrn,
  resolveCrnsTool,
  instructorClasses,
  teachingLoad,
  courseOfferings,
  enrollmentHistoryTool,
]);
