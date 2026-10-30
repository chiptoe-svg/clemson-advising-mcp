// src/mcp-tools/admin-schedule.ts
// Admin scheduling tools (2026-10-28) — for building a department's semester
// schedule, not for advising students. They sit in the "admin" category under
// the clemson.admin scope, so the student advisor's short tool list never
// carries them. Chip's workflow: roll last year's same semester forward,
// lay it out as a calendar, move sections, and check each move against the
// courses students take together, room bookings and instructors' teaching.
//
// Every answer names its base term (the snapshot "everyone else" comes from)
// and says that free means only "no class booked": Banner's public data shows
// class meetings, not events or exams.

import {
  checkDraft,
  defaultBaseTerm,
  findSlots,
  freeRooms,
  hhmmToMins,
  loadBaseSections,
  loadInstructorAliases,
  findConflicts,
  hasCrossListLabels,
  stackSections,
  displayCourse,
  type CourseGroup,
  type DraftMeeting,
  type DraftSection,
  type RoomNeed,
} from "../admin-schedule.js";
import { capacityOverrides } from "../clemson-room-capacity.js";
import {
  crossListRecorded,
  getScheduleDbMeta,
  openScheduleDb,
} from "../clemson-schedule-db.js";
import { listCourseGroups, loadSavedGroups } from "../course-groups.js";
import {
  loadInstructorPreferences,
  type InstructorPreference,
} from "../instructor-preferences.js";
import { listSnapshotTerms, parseTermCode } from "../term-resolve.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const FREE_NOTE =
  "Free means no CLASS is booked there in the base term — Banner's public " +
  "schedule does not show events, exams or meetings, and a room no class " +
  "used that term is not listed.";
const MAX_SLOTS = 15;

const TERM_PROP = {
  type: "string",
  description:
    'The term being planned: a code (202708) or a name ("Fall 2027").',
};
const BASE_PROP = {
  type: "string",
  description:
    "The term whose other-department room use and instructor teaching to " +
    "check against. Default: the target term's own snapshot if Banner has " +
    "published it, else the same season a year earlier.",
};
const MEETING_ITEMS = {
  type: "object",
  properties: {
    days: { type: "string", description: "MTWRFSU, R = Thursday." },
    start: { type: "string", description: "24-hour HHMM." },
    end: { type: "string", description: "24-hour HHMM." },
  },
  required: ["days", "start", "end"],
};

// --- shared input handling ----------------------------------------------------

type Base = {
  term: string;
  reason: string;
  db: NonNullable<ReturnType<typeof openScheduleDb>>;
};

function openBase(targetArg: unknown, baseArg: unknown): Base | string {
  const target = parseTermCode(
    typeof targetArg === "string" ? targetArg : undefined,
  );
  if ("error" in target) return target.error;
  let term: string;
  let reason: string;
  if (typeof baseArg === "string" && baseArg.trim()) {
    const b = parseTermCode(baseArg);
    if ("error" in b) return b.error;
    term = b.term;
    reason = `base term ${term}, as asked`;
  } else {
    const d = defaultBaseTerm(target.term, listSnapshotTerms());
    if (!d)
      return (
        `No snapshot for ${target.term} or for the same season a year ` +
        `earlier (${Number(target.term) - 100}). Pass base_term. Available: ` +
        listSnapshotTerms().join(", ")
      );
    term = d.term;
    reason = d.reason;
  }
  const db = openScheduleDb(term);
  if (!db) return `No snapshot for base term ${term}.`;
  return { term, reason, db };
}

function parseMeeting(m: unknown, where: string): DraftMeeting | string {
  const x = (m ?? {}) as Record<string, unknown>;
  const days = String(x.days ?? "").toUpperCase();
  const start = String(x.start ?? "");
  const end = String(x.end ?? "");
  if (!/^[MTWRFSU]+$/.test(days))
    return `${where}.days must use the letters MTWRFSU (R = Thursday)`;
  const ok = (t: string) =>
    /^\d{4}$/.test(t) && Number(t.slice(0, 2)) < 24 && Number(t.slice(2)) < 60;
  if (!ok(start) || !ok(end) || hhmmToMins(start) >= hhmmToMins(end))
    return `${where} needs start and end as 24-hour HHMM, start before end`;
  const out: DraftMeeting = { days, start, end };
  if ("building" in x) out.building = (x.building as string | null) ?? null;
  if ("room" in x) out.room = (x.room as string | null) ?? null;
  return out;
}

function parseDraft(raw: unknown): DraftSection[] | string {
  if (!Array.isArray(raw)) return "draft must be a list of sections";
  const out: DraftSection[] = [];
  for (const [i, r] of raw.entries()) {
    const x = (r ?? {}) as Record<string, unknown>;
    if (typeof x.id !== "string" || !x.id)
      return `draft[${i}] needs an id the page can match problems back to`;
    if (out.some((o) => o.id === x.id))
      return `draft[${i}] has a duplicate id "${x.id}" — every section needs its own id (a copied block keeps its source's id)`;
    if (typeof x.course !== "string" || !x.course)
      return `draft[${i}] needs a course, e.g. "GC 3400"`;
    const meetings: DraftMeeting[] = [];
    for (const [j, m] of (Array.isArray(x.meetings)
      ? x.meetings
      : []
    ).entries()) {
      const p = parseMeeting(m, `draft[${i}].meetings[${j}]`);
      if (typeof p === "string") return p;
      meetings.push(p);
    }
    out.push({
      id: x.id,
      course: x.course
        .split("/")
        .map((c) => displayCourse(c.trim()))
        .join(" / "),
      sections: Array.isArray(x.sections) ? x.sections.map(String) : [],
      crns: Array.isArray(x.crns) ? x.crns.map(String) : [],
      meetings,
      building: typeof x.building === "string" ? x.building : null,
      room: typeof x.room === "string" ? x.room : null,
      instructors: Array.isArray(x.instructors)
        ? x.instructors.map(String)
        : [],
      cap: typeof x.cap === "number" ? x.cap : null,
      expected: typeof x.expected === "number" ? x.expected : null,
      crossList:
        typeof x.crossList === "string" && x.crossList ? x.crossList : null,
    });
  }
  return out;
}

/** check-schedule-draft `courses`: per-course room needs, keyed by course. */
function parseCourses(raw: unknown): Map<string, RoomNeed> | string {
  const out = new Map<string, RoomNeed>();
  if (raw === undefined) return out;
  if (!Array.isArray(raw))
    return "courses must be a list of {course, rooms?, min_size?}";
  for (const [i, r] of raw.entries()) {
    const x = (r ?? {}) as Record<string, unknown>;
    if (typeof x.course !== "string" || !x.course.trim())
      return `courses[${i}] needs a course, e.g. "GC 4061"`;
    const need: RoomNeed = {};
    if (x.rooms !== undefined) {
      if (
        !Array.isArray(x.rooms) ||
        !x.rooms.every(
          (v) => typeof v === "string" && /^\S.*\s+\S+$/.test(v.trim()),
        )
      )
        return `courses[${i}].rooms must be a list of "Building Room", e.g. ["Godfrey Hall 101C"]`;
      need.rooms = (x.rooms as string[]).map((v) => v.trim());
    }
    if (x.min_size !== undefined) {
      if (typeof x.min_size !== "number" || !(x.min_size > 0))
        return `courses[${i}].min_size must be a positive number of seats`;
      need.minSize = x.min_size;
    }
    out.set(displayCourse(x.course.trim()), need);
  }
  return out;
}

async function resolveGroups(
  raw: unknown,
  program: unknown,
  catalogYear: unknown,
): Promise<CourseGroup[] | string> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "groups must be a list";
  let known: CourseGroup[] | null = null;
  const knownGroups = async (): Promise<CourseGroup[]> => {
    if (known) return known;
    known =
      typeof program === "string" && program
        ? (
            await listCourseGroups(
              program,
              typeof catalogYear === "string" ? catalogYear : undefined,
            )
          ).groups
        : loadSavedGroups();
    return known;
  };
  const out: CourseGroup[] = [];
  for (const g of raw) {
    if (typeof g === "string") {
      const all = await knownGroups();
      const hit = all.find((k) => k.name === g);
      if (!hit)
        return (
          `No course group named "${g}". Known: ` +
          (all.map((k) => `"${k.name}"`).join(", ") || "none") +
          (typeof program === "string"
            ? ""
            : " (pass program to include groups generated from its catalog plan)")
        );
      out.push(hit);
    } else {
      const x = (g ?? {}) as Record<string, unknown>;
      if (typeof x.name !== "string" || !Array.isArray(x.courses))
        return "an inline group needs a name and a courses list";
      out.push({
        name: x.name,
        needs: x.courses.map((c) =>
          (Array.isArray(c) ? c : [c]).map((v) => displayCourse(String(v))),
        ),
        unresolved: [],
        source: "saved",
      });
    }
  }
  return out;
}

function subjectOf(arg: unknown): string {
  return (typeof arg === "string" && arg.trim() ? arg : "GC")
    .trim()
    .toUpperCase();
}

function guard(op: string) {
  try {
    assertMcpOperation(op);
    return null;
  } catch (e) {
    return permissionErr(e);
  }
}

// --- tools --------------------------------------------------------------------

const rollover: McpToolDefinition = {
  operation: "clemson.admin_rollover",
  category: "admin",
  tool: {
    name: "get-department-draft",
    description:
      "A department's whole schedule for one term, as an editable draft — " +
      "the starting calendar for planning a future semester (roll the same " +
      "semester of last year forward). Every section, never truncated: " +
      "course, days/times, room and its capacity, instructors, seat cap, " +
      "enrollment and waitlist, and `expected` (enrollment + waitlist: the " +
      "class size a room must hold). Cross-listed sections that meet together " +
      "(honors pairs, 4xxx/6xxx pairs) come back as ONE entry with combined " +
      "caps; keep them as one when you send the draft to check-schedule-draft. " +
      "crossList is Banner's cross-list group code (null: none recorded).",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description: 'The term to roll from: a code or a name ("Fall 2026").',
        },
        subject: { type: "string", description: 'Subject code. Default "GC".' },
      },
      required: ["term"],
    },
  },
  async handler(args) {
    const denied = guard("clemson.admin_rollover");
    if (denied) return denied;
    const t = parseTermCode(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in t) return err(t.error);
    const db = openScheduleDb(t.term);
    if (!db)
      return err(
        `No snapshot for ${t.term}. Available: ${listSnapshotTerms().join(", ")}`,
      );
    try {
      const subject = subjectOf(args.subject);
      const all = loadBaseSections(db, t.term);
      const sections = stackSections(
        all.filter((s) => s.subject === subject),
        hasCrossListLabels(all),
      );
      return okJson({
        base_term: t.term,
        snapshot_date: getScheduleDbMeta(db).fetchedAt,
        subject,
        count: sections.length,
        sections,
        note:
          sections.length === 0
            ? `The ${t.term} snapshot lists no ${subject} sections.`
            : "Each entry's id is its CRNs joined by '+'; send entries back unchanged except for what you move.",
      });
    } finally {
      db.close();
    }
  },
};

const checkDraftTool: McpToolDefinition = {
  operation: "clemson.admin_check_draft",
  category: "admin",
  tool: {
    name: "check-schedule-draft",
    description:
      "Check a proposed department schedule (meeting times that need not " +
      "exist in Banner yet) and list problems per section: a room booked " +
      "twice in the draft, a room another department uses then, an " +
      "instructor booked twice (including their teaching in other " +
      "departments), a room smaller than the seat cap or than the expected " +
      "class size, and course groups " +
      "(courses students take together) with NO workable combination of one " +
      "section each. Cross-listed sections (Banner's cross-list label, or an " +
      "unlabeled 4xxx/6xxx pair at the same times with the same instructor) " +
      "that overlap are reported as meets_together, not as double bookings; " +
      "any other overlap is a double booking. Room capacities include department overrides " +
      "(state/room-capacity-overrides.yaml). Instructor preferences " +
      "(state/instructor-preferences.yaml: days to avoid, not before/after, " +
      "max sections) and per-course room needs (`courses`) are reported as " +
      "instructor_preference and room_need. Re-run after every change. Problems carry the draft " +
      "section's id. Build the draft from get-department-draft.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target_term: TERM_PROP,
        base_term: BASE_PROP,
        subject: { type: "string", description: 'Default "GC".' },
        draft: {
          type: "array",
          description:
            "Sections: {id, course, meetings:[{days,start,end}], building, room, instructors:[email or name], cap, expected, crossList?}. expected = students expected (rollover: last enrollment + waitlist). crossList = Banner's cross-list code (from get-department-draft; looked up by CRN when absent). Cross-listed sections that overlap are meets_together, not a double booking; so is an unlabeled 4xxx/6xxx pair at the same times with the same instructor. Any other overlap of a room or an instructor is a double booking.",
          items: { type: "object" },
        },
        groups: {
          type: "array",
          description:
            'Course groups to enforce: a saved/generated group name, or {name, courses:["GC 3400", ["STAT 2220","STAT 2300"]]}. A list inside courses is one need any of them satisfies.',
          items: {},
        },
        program: {
          type: "string",
          description:
            "Program whose catalog-plan groups a group NAME may refer to (see list-course-groups).",
        },
        catalog_year: { type: "string", description: "Default: newest." },
        courses: {
          type: "array",
          description:
            'Room needs per course: {course, rooms?:["Godfrey Hall 101C"], min_size?}. A section outside its course\'s rooms, or in a room seating fewer than min_size, is a room_need problem.',
          items: { type: "object" },
        },
      },
      required: ["target_term", "draft"],
    },
  },
  async handler(args) {
    const denied = guard("clemson.admin_check_draft");
    if (denied) return denied;
    const draft = parseDraft(args.draft);
    if (typeof draft === "string") return err(draft);
    const roomNeeds = parseCourses(args.courses);
    if (typeof roomNeeds === "string") return err(roomNeeds);
    let preferences: Map<string, InstructorPreference>;
    try {
      preferences = loadInstructorPreferences();
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
    let groups: CourseGroup[] | string;
    try {
      groups = await resolveGroups(
        args.groups,
        args.program,
        args.catalog_year,
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
    if (typeof groups === "string") return err(groups);
    const base = openBase(args.target_term, args.base_term);
    if (typeof base === "string") return err(base);
    try {
      const r = checkDraft(
        draft,
        loadBaseSections(base.db, base.term),
        subjectOf(args.subject),
        groups,
        loadInstructorAliases(base.db, base.term),
        { preferences, roomNeeds },
      );
      return okJson({
        base_term: base.term,
        base_reason: base.reason,
        snapshot_date: getScheduleDbMeta(base.db).fetchedAt,
        sections_checked: draft.length,
        problem_count: r.problems.length,
        problems: r.problems,
        groups_checked: r.groupsChecked,
        note:
          (r.problems.length === 0
            ? "No problems found in the checks listed. "
            : "") +
          (capacityOverrides().error
            ? `Room capacity overrides were NOT applied: ${capacityOverrides().error}. `
            : "") +
          (preferences.size > 0
            ? `Checked preferences for ${preferences.size} instructor${preferences.size === 1 ? "" : "s"}. `
            : "") +
          FREE_NOTE,
      });
    } finally {
      base.db.close();
    }
  },
};

const findSlotsTool: McpToolDefinition = {
  operation: "clemson.admin_find_slots",
  category: "admin",
  tool: {
    name: "find-offering-slots",
    description:
      "Where could a course be scheduled? Returns standard meeting patterns " +
      "(the base term's most common ones) that keep the courses students " +
      "take with it workable, each with the rooms free then (preferred " +
      "building first, default Godfrey Hall; rooms hold expected_size, " +
      "closest fit first) and which of the given " +
      "instructors are free or busy. Pass the courses to avoid directly or " +
      "as a course group; pass a draft to check against a schedule being " +
      "built instead of the base term's own.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target_term: TERM_PROP,
        base_term: BASE_PROP,
        course: {
          type: "string",
          description: 'The course to place, e.g. "GC 3400".',
        },
        avoid_courses: { type: "array", items: { type: "string" } },
        group: {
          type: "string",
          description: "A course-group name whose other courses to avoid.",
        },
        program: { type: "string" },
        catalog_year: { type: "string" },
        instructors: { type: "array", items: { type: "string" } },
        building: { type: "string", description: 'Default "Godfrey Hall".' },
        min_capacity: { type: "number" },
        expected_size: {
          type: "number",
          description:
            "Students expected in the section; rooms must hold this many. Default: the course's largest base-term section demand (enrollment + waitlist).",
        },
        subject: { type: "string" },
        draft: { type: "array", items: { type: "object" } },
        exclude_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Draft section ids to leave out, e.g. the section being moved, so its own room and instructor count as free. Needs draft.",
        },
      },
      required: ["target_term", "course"],
    },
  },
  async handler(args) {
    const denied = guard("clemson.admin_find_slots");
    if (denied) return denied;
    if (typeof args.course !== "string" || !args.course.trim())
      return err('course is required, e.g. "GC 3400"');
    const course = displayCourse(args.course);
    let draft: DraftSection[] | null = null;
    if (args.draft !== undefined) {
      const d = parseDraft(args.draft);
      if (typeof d === "string") return err(d);
      draft = d;
    }
    let excluded: string[] = [];
    if (args.exclude_ids !== undefined) {
      if (
        !Array.isArray(args.exclude_ids) ||
        !args.exclude_ids.every((x) => typeof x === "string")
      )
        return err("exclude_ids must be a list of draft section ids");
      if (!draft) return err("exclude_ids needs a draft to leave them out of");
      excluded = args.exclude_ids as string[];
      const unknown = excluded.filter((x) => !draft!.some((s) => s.id === x));
      if (unknown.length > 0)
        return err(
          `exclude_ids not in the draft: ${unknown.map((x) => `"${x}"`).join(", ")}`,
        );
      draft = draft.filter((s) => !excluded.includes(s.id));
    }
    let avoid = Array.isArray(args.avoid_courses)
      ? args.avoid_courses.map((c) => displayCourse(String(c)))
      : [];
    if (typeof args.group === "string") {
      let g: CourseGroup[] | string;
      try {
        g = await resolveGroups([args.group], args.program, args.catalog_year);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      if (typeof g === "string") return err(g);
      avoid = [
        ...avoid,
        ...g[0]!.needs.filter((n) => !n.includes(course)).map((n) => n[0]!),
      ];
    }
    avoid = [...new Set(avoid)].filter((c) => c !== course);
    const base = openBase(args.target_term, args.base_term);
    if (typeof base === "string") return err(base);
    try {
      const sections = loadBaseSections(base.db, base.term);
      const known = new Set(sections.map((s) => s.course));
      if (
        !known.has(course) &&
        !(draft ?? []).some((s) => s.course.includes(course))
      )
        return err(
          `${course} has no sections in base term ${base.term}${draft ? " or the draft" : ""}. Check the code, or pass base_term.`,
        );
      const expectedSize =
        typeof args.expected_size === "number"
          ? args.expected_size
          : Math.max(
              0,
              ...stackSections(sections, hasCrossListLabels(sections))
                .filter((s) => s.course.split(" / ").includes(course))
                .map((s) => s.expected ?? 0),
            ) || undefined;
      const r = findSlots({
        course,
        expectedSize,
        base: sections,
        draft,
        subject: subjectOf(args.subject),
        avoidCourses: avoid,
        instructors: Array.isArray(args.instructors)
          ? args.instructors.map(String)
          : [],
        preferredBuilding:
          typeof args.building === "string" ? args.building : "Godfrey Hall",
        minCapacity:
          typeof args.min_capacity === "number" ? args.min_capacity : undefined,
        aliases: loadInstructorAliases(base.db, base.term),
      });
      const cut = r.slots.length > MAX_SLOTS;
      return okJson({
        base_term: base.term,
        base_reason: base.reason,
        snapshot_date: getScheduleDbMeta(base.db).fetchedAt,
        course,
        expected_size: expectedSize ?? null,
        avoided: avoid,
        ...(excluded.length > 0 ? { excluded } : {}),
        slot_count: r.slots.length,
        slots: r.slots.slice(0, MAX_SLOTS),
        patterns_considered: r.patternsUsed.length,
        note:
          (cut
            ? `Showing ${MAX_SLOTS} of ${r.slots.length} slots, most common patterns first. `
            : "") +
          (r.slots.length === 0
            ? `No standard pattern keeps ${avoid.join(", ") || "the avoided courses"} workable with a free room. `
            : "") +
          FREE_NOTE,
      });
    } finally {
      base.db.close();
    }
  },
};

const freeRoomsTool: McpToolDefinition = {
  operation: "clemson.admin_free_rooms",
  category: "admin",
  tool: {
    name: "find-free-rooms",
    description:
      "Rooms with no class booked in a time window (days + start/end), with " +
      "seating capacity, the preferred building first. Optional minimum " +
      "capacity; pass a draft to count a schedule being built instead of the " +
      "base term's own department sections.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target_term: TERM_PROP,
        base_term: BASE_PROP,
        ...MEETING_ITEMS.properties,
        building: {
          type: "string",
          description: 'Preferred building, default "Godfrey Hall".',
        },
        min_capacity: { type: "number" },
        subject: { type: "string" },
        draft: { type: "array", items: { type: "object" } },
      },
      required: ["target_term", "days", "start", "end"],
    },
  },
  async handler(args) {
    const denied = guard("clemson.admin_free_rooms");
    if (denied) return denied;
    const m = parseMeeting(args, "the window");
    if (typeof m === "string") return err(m);
    let draft: DraftSection[] | null = null;
    if (args.draft !== undefined) {
      const d = parseDraft(args.draft);
      if (typeof d === "string") return err(d);
      draft = d;
    }
    const base = openBase(args.target_term, args.base_term);
    if (typeof base === "string") return err(base);
    try {
      const rooms = freeRooms(
        loadBaseSections(base.db, base.term),
        draft,
        [m],
        {
          building:
            typeof args.building === "string" ? args.building : "Godfrey Hall",
          minCapacity:
            typeof args.min_capacity === "number"
              ? args.min_capacity
              : undefined,
          subject: subjectOf(args.subject),
        },
      );
      return okJson({
        base_term: base.term,
        base_reason: base.reason,
        snapshot_date: getScheduleDbMeta(base.db).fetchedAt,
        window: `${m.days} ${m.start}–${m.end}`,
        room_count: rooms.length,
        rooms,
        note:
          (rooms.length === 0 ? "No known room is free in that window. " : "") +
          FREE_NOTE,
      });
    } finally {
      base.db.close();
    }
  },
};

const courseGroupsTool: McpToolDefinition = {
  operation: "clemson.admin_course_groups",
  category: "admin",
  tool: {
    name: "list-course-groups",
    description:
      "The course groups (courses students take in the same semester) for a " +
      "program: one per semester of its catalog plan, with corequisite labs " +
      "included, plus department-saved groups, which override a generated " +
      "group of the same name. Plan placeholders (electives, requirement " +
      "slots) are listed as unresolved. Use a group's name in " +
      "check-schedule-draft or find-offering-slots.",
    inputSchema: {
      type: "object" as const,
      properties: {
        program: {
          type: "string",
          description: 'e.g. "Graphic Communications, BS".',
        },
        catalog_year: { type: "string", description: "Default: newest." },
      },
      required: ["program"],
    },
  },
  async handler(args) {
    const denied = guard("clemson.admin_course_groups");
    if (denied) return denied;
    if (typeof args.program !== "string" || !args.program.trim())
      return err("program is required");
    try {
      const r = await listCourseGroups(
        args.program,
        typeof args.catalog_year === "string" ? args.catalog_year : undefined,
      );
      return okJson({
        program: args.program,
        catalog_year: r.catalogYear,
        groups: r.groups,
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

/**
 * find-schedule-conflicts: a published term's rooms and instructors booked
 * twice outside cross-listed classes, plus the unlabeled 4xxx/6xxx pairs to
 * get labeled in Banner (Chip, 2026-10-30).
 */
const conflictsTool: McpToolDefinition = {
  operation: "clemson.admin_conflicts",
  category: "admin",
  tool: {
    name: "find-schedule-conflicts",
    description:
      "Report a department's double bookings in a published term: a room " +
      "holding two classes at once, an instructor teaching two at once, or " +
      "another department's class in the department's room. Cross-listed " +
      "sections (Banner's cross-list label: honors 002, 4xxx/6xxx, 1990-4990 " +
      "seminars) are one class and never reported. An unlabeled 4xxx/6xxx " +
      "pair at the same times with the same instructor counts as one class " +
      "too, and is listed in unlabeled_cross_lists so the label gets fixed in " +
      "Banner. A double booking with identical meetings, room and instructor " +
      "is marked likely_missing_label. Class meetings only — Banner's public " +
      "data has no events or exams.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: TERM_PROP,
        subject: { type: "string", description: 'Default "GC".' },
      },
    },
  },
  async handler(args) {
    const denied = guard("clemson.admin_conflicts");
    if (denied) return denied;
    const t = parseTermCode(
      typeof args.term === "string" ? args.term : undefined,
    );
    if ("error" in t) return err(t.error);
    const db = openScheduleDb(t.term);
    if (!db)
      return err(
        `No snapshot for ${t.term}. Available: ${listSnapshotTerms().join(", ")}`,
      );
    try {
      const subject = subjectOf(args.subject);
      const { doubleBookings, unlabeled } = findConflicts(
        loadBaseSections(db, t.term),
        subject,
        loadInstructorAliases(db, t.term),
      );
      const labels = crossListRecorded(db);
      return okJson({
        term: t.term,
        subject,
        snapshot_date: getScheduleDbMeta(db).fetchedAt,
        labels_recorded: labels,
        double_booking_count: doubleBookings.length,
        double_bookings: doubleBookings,
        unlabeled_cross_lists: unlabeled,
        note: labels
          ? "Checked class meetings only; cross-listed sections are one class."
          : "This snapshot predates Banner's cross-list labels, so labeled " +
            "cross-listings (honors pairs, seminars) may show as double " +
            "bookings here. Run the snapshot backfill for this term first.",
      });
    } finally {
      db.close();
    }
  },
};

export const __adminTools = {
  rollover,
  checkDraft: checkDraftTool,
  findSlots: findSlotsTool,
  freeRooms: freeRoomsTool,
  courseGroups: courseGroupsTool,
  findConflicts: conflictsTool,
};

registerTools(Object.values(__adminTools));
