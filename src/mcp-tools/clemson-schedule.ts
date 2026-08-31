// src/mcp-tools/clemson-schedule.ts
// Deterministic schedule-conflict tools backed by the per-term SQLite snapshot.
import { parseTermCode, resolveTerm } from "../term-resolve.js";
import {
  openScheduleDb,
  getScheduleDbMeta,
  getMeetingsForCrns,
  getSectionsByCrn,
  resolveCrns,
  matchInstructors,
  findInstructorMeetings,
  teachingLoadRows,
  type TeachingLoadRow,
  findConflicts,
  type ConflictPair,
} from "../clemson-schedule-db.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const findConflictFree: McpToolDefinition = {
  operation: "clemson.find_conflict_free_schedule",
  // A scheduling primitive, not curriculum: its own on-demand category so the
  // model doesn't have to load "curriculum-extras" to build a schedule.
  category: "scheduling",
  tool: {
    name: "find-conflict-free-schedule",
    description:
      "Given fixed CRNs (already committed) and candidate CRNs (options to " +
      "consider), returns which candidates can be added without time conflicts. " +
      "Each candidate is checked against every fixed CRN and against every " +
      "other candidate. Returns conflict_free candidates and details of any " +
      "conflicts for the rest. Reads the daily Banner snapshot. Do not use " +
      "this just to check a short, already-chosen CRN list — use " +
      "check-conflicts for that.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            'Term: a code (202608) or a name ("Fall 2026"). Defaults to the current registration term.',
        },
        fixed_crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs already locked in the schedule.",
        },
        candidate_crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs to evaluate.",
        },
      },
      required: ["term", "fixed_crns", "candidate_crns"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.find_conflict_free_schedule");
    } catch (e) {
      return permissionErr(e);
    }
    const fixedCrns = args.fixed_crns as string[] | undefined;
    const candidateCrns = args.candidate_crns as string[] | undefined;
    if (
      !Array.isArray(fixedCrns) ||
      !Array.isArray(candidateCrns) ||
      candidateCrns.length === 0
    )
      return err(
        "term, fixed_crns, and a non-empty candidate_crns array are required",
      );
    // This tool cannot answer without a snapshot, so the full resolver: it
    // names the available terms rather than failing bare.
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
      const allCrns = [...new Set([...fixedCrns, ...candidateCrns])];
      const meetings = getMeetingsForCrns(db, term, allCrns);
      const allConflicts = findConflicts(meetings);

      const fixedSet = new Set(fixedCrns);

      type CandidateResult = {
        crn: string;
        conflict_free: boolean;
        conflicts: ConflictPair[];
      };

      const results: CandidateResult[] = candidateCrns.map((crn) => {
        const conflicts = allConflicts.filter(
          (c) =>
            (c.crn_a === crn || c.crn_b === crn) &&
            (c.crn_a !== crn ||
              fixedSet.has(c.crn_b) ||
              candidateCrns.includes(c.crn_b)) &&
            (c.crn_b !== crn ||
              fixedSet.has(c.crn_a) ||
              candidateCrns.includes(c.crn_a)),
        );
        return { crn, conflict_free: conflicts.length === 0, conflicts };
      });

      return okJson({
        term,
        snapshot_date: getScheduleDbMeta(db).fetchedAt,
        fixed_crns: fixedCrns,
        candidates: results,
        conflict_free: results.filter((r) => r.conflict_free).map((r) => r.crn),
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
  category: "scheduling",
  tool: {
    name: "get-instructor-classes",
    description:
      "Everything each given instructor TEACHES in a term — the primitive " +
      'behind "what does Chip Tonkin teach?", "I want Tonkin\'s GC 4800", ' +
      'and, with the optional day/window filter, "who has a teaching ' +
      'conflict Friday 11-12?". Each entry may be an email, a name, or ' +
      "'Name <email>' (emails match exactly; names match by substring, and " +
      "an ambiguous name returns the candidates instead of guessing). Every " +
      "matched person gets their full section list with meetings. Statuses " +
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
              "NOT the same as free; other commitments are invisible here.",
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
            meetings: [],
          };
          e.meetings.push({
            day: m2.day,
            start_min: m2.start_min,
            end_min: m2.end_min,
            building: m2.building,
            room: m2.room,
          });
          byCrn.set(m2.crn, e);
        }
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
  minutes: number;
  timed: boolean;
}

/**
 * Load rows -> per-person aggregates. Credit hours count once per SECTION no
 * matter how many meeting rows it has; contact minutes sum only timed rows;
 * a section with no timed meetings lands in untimed_sections instead of
 * silently contributing zero to a total that claims to describe it.
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
        minutes: 0,
        timed: false,
      };
      p.byCrn.set(r.crn, s);
    }
    if (r.start_min !== null && r.end_min !== null) {
      s.minutes += r.end_min - r.start_min;
      s.timed = true;
    }
  }
  return [...people.values()].map((p) => {
    const aggs = [...p.byCrn.values()];
    const untimed = aggs.filter((s) => !s.timed);
    const totalMinutes = aggs.reduce((a, s) => a + s.minutes, 0);
    return {
      name: p.name,
      email: p.email,
      sections_count: aggs.length,
      contact_hours_weekly: round1(totalMinutes / 60),
      credit_hours: round1(aggs.reduce((a, s) => a + (s.credit_hours ?? 0), 0)),
      untimed_sections: {
        count: untimed.length,
        crns: untimed.map((s) => s.crn),
      },
      sections: aggs.map((s) => ({
        crn: s.crn,
        subject_course: s.subject_course,
        section: s.section,
        title: s.title,
        credit_hours: s.credit_hours,
        weekly_contact_hours: round1(s.minutes / 60),
        timed: s.timed,
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
  category: "scheduling",
  tool: {
    name: "get-teaching-load",
    description:
      "Weekly teaching load per instructor, computed server-side from the " +
      'term snapshot — the primitive behind "how many contact hours does ' +
      'each GC faculty member have this semester?". Select by subject ' +
      "(e.g. 'GC': every instructor on that subject's sections, load counted " +
      "over those sections only) and/or by instructors ('Name <email>', a " +
      "bare email, or a name; emails match exactly, names by substring, and " +
      "an ambiguous name returns candidates instead of guessing). Two " +
      "measures, kept separate: contact_hours_weekly sums timed meeting " +
      "durations; credit_hours sums section credit hours. Sections with NO " +
      "timed meetings are NEVER folded into contact hours — they come back " +
      "in untimed_sections, so a total cannot silently hide an " +
      "online/arranged section. Co-taught sections attribute fully to each " +
      "listed instructor. Snapshot-backed, read-only, no Banner load.",
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
                "statement about their workload elsewhere.",
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
          "Co-taught sections attribute fully to EACH listed instructor, so totals across people can exceed the section count.",
        instructors: entries,
        _source: `Banner schedule snapshot ${meta.fetchedAt} — teaching data only`,
      });
    } finally {
      db.close();
    }
  },
};

export const __schedTools = {
  instructorClasses,
  teachingLoad,
  findConflictFree,
  scheduleFreshness,
  sectionsByCrn,
  resolveCrns: resolveCrnsTool,
};

registerTools([
  findConflictFree,
  scheduleFreshness,
  sectionsByCrn,
  resolveCrnsTool,
  instructorClasses,
  teachingLoad,
]);
