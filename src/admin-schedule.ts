// src/admin-schedule.ts
// The logic behind the admin scheduling tools (2026-10-28): roll a term's
// department schedule forward as a draft, check a draft, find slots and free
// rooms. Pure functions over a base term's sections; the tool layer
// (src/mcp-tools/admin-schedule.ts) opens snapshots and shapes answers.
//
// "Free" here only ever means "no class booked in the base term": Banner's
// public data shows class meetings, not events, exams or meetings.
//
// Stacked sections: honors cross-lists (a cap-2 "002" beside its lecture) and
// 4xxx/6xxx undergraduate/graduate pairs meet together — same meetings, same
// room, same instructor. They are one meeting: never a double booking, and
// the room-size check uses their combined caps (Chip, 2026-10-28).

import type Database from "better-sqlite3";

import { roomCapacity } from "./clemson-room-capacity.js";
import { minsToHHMM } from "./clemson-schedule-db.js";
import { searchCombinations } from "./section-combinations.js";

export interface DraftMeeting {
  days: string; // MTWRFSU, R = Thursday
  start: string; // HHMM
  end: string; // HHMM
  /** Set when this meeting is in a different room from the section's own. */
  building?: string | null;
  room?: string | null;
}

export interface DraftSection {
  id: string; // page-chosen; rollover uses CRNs joined by "+"
  course: string; // "GC 4400"
  sections: string[];
  crns: string[];
  meetings: DraftMeeting[];
  building: string | null;
  room: string | null;
  instructors: string[]; // emails when known, else names
  cap: number | null;
}

export interface BaseSection extends DraftSection {
  subject: string;
  title: string;
  enrollment: number;
  waitCount: number;
  roomCapacity: number | null;
}

const DAY_ORDER = "MTWRFSU";
const PLACEHOLDER_BUILDINGS = new Set([
  "no building assigned",
  "exam",
  "online",
  "tba",
]);
const PLACEHOLDER_ROOMS = new Set(["tba", "room", "course", "online"]);

/** Banner's stand-ins for "no room": never a room a class can be put in. */
export function isPlaceholderRoom(
  building: string | null,
  room: string | null,
): boolean {
  if (!building || !room) return true;
  return (
    PLACEHOLDER_BUILDINGS.has(building.trim().toLowerCase()) ||
    PLACEHOLDER_ROOMS.has(room.trim().toLowerCase())
  );
}

/**
 * The term the checks compare against when none is given: the target term's
 * own snapshot when Banner has published it (it holds other departments' real
 * bookings), else the same season a year earlier. Null when neither exists.
 */
export function defaultBaseTerm(
  target: string,
  available: readonly string[],
): { term: string; reason: string } | null {
  if (available.includes(target))
    return { term: target, reason: `the target term ${target}'s own snapshot` };
  const prior = String(Number(target) - 100);
  if (available.includes(prior))
    return {
      term: prior,
      reason: `${target} has no snapshot yet, so the same season a year earlier (${prior})`,
    };
  return null;
}

export function sameInstructor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function displayCourse(subjectCourse: string): string {
  return subjectCourse
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/^([A-Z]+)(\d)/, "$1 $2");
}

function sortDays(days: Iterable<string>): string {
  return [...new Set(days)]
    .sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b))
    .join("");
}

/** One row per CRN, unstacked. Callers stack with stackSections. */
export function loadBaseSections(
  db: Database.Database,
  term: string,
): BaseSection[] {
  const rows = db
    .prepare(
      `SELECT crn, subject_course, section, title, enrollment, max_enrollment,
              wait_count
         FROM sections WHERE term = ? ORDER BY subject_course, section`,
    )
    .all(term) as {
    crn: string;
    subject_course: string;
    section: string;
    title: string;
    enrollment: number;
    max_enrollment: number;
    wait_count: number;
  }[];
  const meetings = db
    .prepare(
      `SELECT crn, day, start_min, end_min, building, room
         FROM meetings WHERE term = ?`,
    )
    .all(term) as {
    crn: string;
    day: string;
    start_min: number | null;
    end_min: number | null;
    building: string | null;
    room: string | null;
  }[];
  const instructors = db
    .prepare(
      `SELECT crn, name, email FROM instructors WHERE term = ?
        ORDER BY primary_i DESC, name`,
    )
    .all(term) as { crn: string; name: string; email: string | null }[];

  const meetsBy = new Map<string, typeof meetings>();
  for (const m of meetings)
    meetsBy.set(m.crn, [...(meetsBy.get(m.crn) ?? []), m]);
  const instBy = new Map<string, string[]>();
  for (const i of instructors) {
    const who = i.email || i.name;
    const list = instBy.get(i.crn) ?? [];
    if (!list.some((w) => sameInstructor(w, who))) list.push(who);
    instBy.set(i.crn, list);
  }

  return rows.map((r) => {
    const ms = (meetsBy.get(r.crn) ?? []).filter(
      (m) => m.start_min != null && m.end_min != null,
    );
    const home =
      ms.find((m) => !isPlaceholderRoom(m.building, m.room)) ?? ms[0];
    const building = home?.building ?? null;
    const room = home?.room ?? null;
    const byKey = new Map<string, { days: string[]; m: (typeof ms)[number] }>();
    for (const m of ms) {
      const key = `${m.start_min}-${m.end_min}-${m.building}|${m.room}`;
      const e = byKey.get(key) ?? { days: [], m };
      e.days.push(m.day);
      byKey.set(key, e);
    }
    const draftMeetings: DraftMeeting[] = [...byKey.values()].map(
      ({ days, m }) => ({
        days: sortDays(days),
        start: minsToHHMM(m.start_min!),
        end: minsToHHMM(m.end_min!),
        ...(m.building !== building || m.room !== room
          ? { building: m.building, room: m.room }
          : {}),
      }),
    );
    const course = displayCourse(r.subject_course);
    return {
      id: r.crn,
      course,
      sections: [r.section],
      crns: [r.crn],
      meetings: draftMeetings,
      building,
      room,
      instructors: instBy.get(r.crn) ?? [],
      cap: r.max_enrollment,
      subject: course.split(" ")[0]!,
      title: r.title,
      enrollment: r.enrollment,
      waitCount: r.wait_count,
      roomCapacity: roomCapacity(building, room),
    };
  });
}

function stackKey(s: DraftSection): string | null {
  if (s.meetings.length === 0 || isPlaceholderRoom(s.building, s.room))
    return null;
  const meets = s.meetings
    .map(
      (m) =>
        `${m.days} ${m.start}-${m.end} ${m.building ?? ""}|${m.room ?? ""}`,
    )
    .sort()
    .join(";");
  const who = s.instructors
    .map((i) => i.toLowerCase())
    .sort()
    .join(",");
  return `${meets}#${s.building}|${s.room}#${who}`;
}

/**
 * Merge sections that meet together (identical meetings, room and
 * instructors) into one, across course numbers. Sections with no meeting
 * time or no real room never stack.
 */
export function stackSections<T extends DraftSection>(
  sections: readonly T[],
): T[] {
  const out: T[] = [];
  const byKey = new Map<string, T>();
  for (const s of sections) {
    const key = stackKey(s);
    const into = key ? byKey.get(key) : undefined;
    if (!into) {
      const copy = { ...s, sections: [...s.sections], crns: [...s.crns] };
      out.push(copy);
      if (key) byKey.set(key, copy);
      continue;
    }
    into.crns.push(...s.crns);
    into.sections.push(...s.sections);
    into.id = into.crns.join("+");
    into.cap =
      into.cap == null || s.cap == null
        ? (into.cap ?? s.cap)
        : into.cap + s.cap;
    if (s.course !== into.course && !into.course.includes(s.course))
      into.course = `${into.course} / ${s.course}`;
  }
  return out;
}

// --- Draft checks -------------------------------------------------------------

export interface CourseGroup {
  name: string;
  needs: string[][]; // each need = alternative course codes ("GC 3400")
  unresolved: string[]; // plan placeholders ("Elective"), informational
  source: "generated" | "saved";
}

export type ProblemKind =
  | "room_double_booked"
  | "room_used_by_other_department"
  | "instructor_double_booked"
  | "group_clash"
  | "room_too_small"
  | "room_unknown"
  | "no_meeting_time";

export interface Problem {
  id: string;
  kind: ProblemKind;
  detail: string;
  with: string[];
}

interface Interval {
  day: string;
  startMin: number;
  endMin: number;
  place: string | null; // "Building|Room", null for a placeholder
}

export function hhmmToMins(t: string): number {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(2));
}

function intervals(s: DraftSection): Interval[] {
  const out: Interval[] = [];
  for (const m of s.meetings) {
    const building = m.building !== undefined ? m.building : s.building;
    const room = m.room !== undefined ? m.room : s.room;
    const place = isPlaceholderRoom(building, room)
      ? null
      : `${building}|${room}`;
    for (const day of m.days)
      out.push({
        day,
        startMin: hhmmToMins(m.start),
        endMin: hhmmToMins(m.end),
        place,
      });
  }
  return out;
}

function overlap(a: Interval, b: Interval): boolean {
  return a.day === b.day && a.startMin < b.endMin && b.startMin < a.endMin;
}

function describe(s: DraftSection): string {
  const when = s.meetings
    .map((m) => `${m.days} ${m.start}–${m.end}`)
    .join(", ");
  return `${s.course}-${s.sections.join("/")}${when ? ` (${when})` : ""}`;
}

/**
 * Name → email for every instructor the base term lists with both, so a
 * draft naming someone by email still matches a record that has only their
 * name (and the reverse).
 */
export function loadInstructorAliases(
  db: Database.Database,
  term: string,
): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT name, email FROM instructors
        WHERE term = ? AND email IS NOT NULL AND email != ''`,
    )
    .all(term) as { name: string; email: string }[];
  return new Map(
    rows.map((r) => [r.name.trim().toLowerCase(), r.email.toLowerCase()]),
  );
}

function canon(who: string, aliases: ReadonlyMap<string, string>): string {
  const k = who.trim().toLowerCase();
  return k.includes("@") ? k : (aliases.get(k) ?? k);
}

function courseCodes(s: DraftSection): string[] {
  return s.course.split(" / ").map((c) => displayCourse(c));
}

/**
 * Problems in a draft schedule, per draft section. "Others" are the base
 * term's sections outside `subject`: their rooms and their instructors'
 * teaching are fixed commitments. The base term's own `subject` sections are
 * what the draft replaces, so they are ignored. Callers stack the draft.
 */
export function checkDraft(
  draft: readonly DraftSection[],
  base: readonly BaseSection[],
  subject: string,
  groups: readonly CourseGroup[],
  aliases: ReadonlyMap<string, string> = new Map(),
): {
  problems: Problem[];
  groupsChecked: {
    name: string;
    combinations: number | null;
    missing: string[];
  }[];
} {
  const others = base.filter((b) => b.subject !== subject.toUpperCase());
  const iv = new Map(draft.map((s) => [s.id, intervals(s)]));
  const otherIv = others.map((o) => ({ o, iv: intervals(o) }));
  const who = (s: DraftSection) =>
    new Set(s.instructors.map((i) => canon(i, aliases)));

  const found = new Map<string, Problem[]>();
  const add = (
    id: string,
    kind: ProblemKind,
    detail: string,
    w: string[] = [],
  ) => {
    const list = found.get(id) ?? [];
    const same = list.find((p) => p.kind === kind);
    if (same) {
      for (const x of w) if (!same.with.includes(x)) same.with.push(x);
      if (!same.detail.includes(detail)) same.detail += `; ${detail}`;
    } else list.push({ id, kind, detail, with: [...w] });
    found.set(id, list);
  };

  for (const s of draft) {
    const mine = iv.get(s.id)!;
    if (s.meetings.length === 0) {
      add(
        s.id,
        "no_meeting_time",
        `${describe(s)} has no meeting time, so nothing was checked for it`,
      );
      continue;
    }
    if (mine.every((m) => m.place === null))
      add(
        s.id,
        "room_unknown",
        `${describe(s)} has no real room, so rooms were not checked`,
      );
    const myWho = who(s);

    for (const t of draft) {
      if (t.id === s.id) continue;
      const theirs = iv.get(t.id)!;
      const roomClash = mine.find((a) =>
        theirs.some((b) => a.place && a.place === b.place && overlap(a, b)),
      );
      if (roomClash)
        add(
          s.id,
          "room_double_booked",
          `${roomClash.place!.replace("|", " ")} also holds ${describe(t)}`,
          [t.id],
        );
      const shared = [...who(t)].filter((x) => myWho.has(x));
      if (
        shared.length > 0 &&
        mine.some((a) => theirs.some((b) => overlap(a, b)))
      )
        add(
          s.id,
          "instructor_double_booked",
          `${shared.join(", ")} also teaches ${describe(t)}`,
          [t.id],
        );
    }

    for (const { o, iv: theirs } of otherIv) {
      const roomClash = mine.find((a) =>
        theirs.some((b) => a.place && a.place === b.place && overlap(a, b)),
      );
      if (roomClash)
        add(
          s.id,
          "room_used_by_other_department",
          `${roomClash.place!.replace("|", " ")} is booked by ${describe(o)}`,
        );
      const shared = o.instructors
        .map((i) => canon(i, aliases))
        .filter((x) => myWho.has(x));
      if (
        shared.length > 0 &&
        mine.some((a) => theirs.some((b) => overlap(a, b)))
      )
        add(
          s.id,
          "instructor_double_booked",
          `${shared.join(", ")} teaches ${describe(o)}`,
        );
    }

    const capacity = roomCapacity(s.building, s.room);
    if (capacity != null && s.cap != null && s.cap > capacity)
      add(
        s.id,
        "room_too_small",
        `${s.building} ${s.room} seats ${capacity}; the section caps at ${s.cap}`,
      );
  }

  const groupsChecked = groups.map((g) => {
    const needs = g.needs.map((alts) => {
      const codes = alts.map(displayCourse);
      const inDraft = draft.filter((s) =>
        courseCodes(s).some((c) => codes.includes(c)),
      );
      // A course outside the subject (MKT 3010 in a GC group) isn't in the
      // draft: its base-term sections are the fixed times students face.
      return {
        label: codes.join("/"),
        sections:
          inDraft.length > 0
            ? inDraft
            : others.filter((s) =>
                courseCodes(s).some((c) => codes.includes(c)),
              ),
      };
    });
    const present = needs.filter((n) => n.sections.length > 0);
    const missing = needs
      .filter((n) => n.sections.length === 0)
      .map((n) => n.label);
    if (present.length < 2)
      return { name: g.name, combinations: null, missing };
    const r = searchCombinations({
      groups: present.map((n) => ({
        label: n.label,
        sections: n.sections.map((s) => ({
          crn: s.id,
          meetings: iv.get(s.id) ?? intervals(s),
        })),
      })),
      fixed: [],
      busy: [],
    });
    if (r.count === 0 && r.complete) {
      const why = r.blocking.map((b) => b.reason).join("; ");
      const draftIds = new Set(draft.map((s) => s.id));
      for (const n of present)
        for (const s of n.sections.filter((x) => draftIds.has(x.id)))
          add(
            s.id,
            "group_clash",
            `group "${g.name}": ${why}`,
            present
              .flatMap((p) => p.sections.map((x) => x.id))
              .filter((x) => x !== s.id && draftIds.has(x)),
          );
    }
    return { name: g.name, combinations: r.complete ? r.count : null, missing };
  });

  return {
    problems: draft.flatMap((s) => found.get(s.id) ?? []),
    groupsChecked,
  };
}

// --- Patterns, free rooms, slots ---------------------------------------------

function patternKey(meetings: readonly DraftMeeting[]): string {
  return meetings
    .map((m) => `${m.days} ${m.start}-${m.end}`)
    .sort()
    .join(",");
}

/**
 * The base term's most common meeting patterns (each a whole set of meetings,
 * e.g. MW 1115–1400), counted over sections in real rooms. Derived from the
 * data rather than a hard-coded list, so it follows Clemson's actual grid.
 */
export function standardPatterns(
  base: readonly BaseSection[],
  limit = 12,
): DraftMeeting[][] {
  const counts = new Map<string, { n: number; meetings: DraftMeeting[] }>();
  for (const s of base) {
    if (s.meetings.length === 0 || isPlaceholderRoom(s.building, s.room))
      continue;
    const meetings = s.meetings.map(({ days, start, end }) => ({
      days,
      start,
      end,
    }));
    const key = patternKey(meetings);
    const e = counts.get(key) ?? { n: 0, meetings };
    e.n++;
    counts.set(key, e);
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((e) => e.meetings);
}

export interface FreeRoom {
  building: string;
  room: string;
  capacity: number | null;
}

/** The sections that hold rooms and instructors: the draft replaces the
 *  subject's own base sections when one is given. */
function occupants(
  base: readonly BaseSection[],
  draft: readonly DraftSection[] | null,
  subject: string | undefined,
): DraftSection[] {
  if (!draft) return [...base];
  const subj = subject?.toUpperCase();
  return [...base.filter((b) => !subj || b.subject !== subj), ...draft];
}

/**
 * Rooms with no class booked in the window. "Rooms" are the real rooms the
 * base term's meetings use — a room no class used is invisible here.
 */
export function freeRooms(
  base: readonly BaseSection[],
  draft: readonly DraftSection[] | null,
  meetings: readonly DraftMeeting[],
  opts: { building?: string; minCapacity?: number; subject?: string } = {},
): FreeRoom[] {
  const known = new Map<string, FreeRoom>();
  for (const s of base)
    for (const iv of intervals(s))
      if (iv.place && !known.has(iv.place)) {
        const [building, room] = iv.place.split("|") as [string, string];
        known.set(iv.place, {
          building,
          room,
          capacity: roomCapacity(building, room),
        });
      }
  const want = intervals({
    id: "",
    course: "",
    sections: [],
    crns: [],
    meetings: [...meetings],
    building: null,
    room: null,
    instructors: [],
    cap: null,
  });
  const busy = new Set<string>();
  for (const s of occupants(base, draft, opts.subject))
    for (const iv of intervals(s))
      if (iv.place && want.some((w) => overlap(w, iv))) busy.add(iv.place);
  const pref = opts.building?.toLowerCase();
  return [...known.entries()]
    .filter(([place]) => !busy.has(place))
    .map(([, r]) => r)
    .filter(
      (r) =>
        opts.minCapacity == null ||
        (r.capacity != null && r.capacity >= opts.minCapacity),
    )
    .sort(
      (a, b) =>
        Number(b.building.toLowerCase() === pref) -
          Number(a.building.toLowerCase() === pref) ||
        (a.capacity ?? Infinity) - (b.capacity ?? Infinity) ||
        `${a.building} ${a.room}`.localeCompare(`${b.building} ${b.room}`),
    );
}

export interface SlotOption {
  meetings: DraftMeeting[];
  rooms: FreeRoom[];
  instructorsFree: string[];
  instructorsBusy: string[];
}

/**
 * Meeting patterns a course could take without breaking the courses students
 * take with it: a pattern survives when some choice of one section of each
 * avoid-course still fits around it (searchCombinations), and at least one
 * room is free. Instructors are split into free and busy for each slot.
 */
export function findSlots(args: {
  base: readonly BaseSection[];
  draft: readonly DraftSection[] | null;
  subject: string;
  avoidCourses: string[];
  instructors: string[];
  preferredBuilding: string;
  minCapacity?: number;
  patterns?: DraftMeeting[][];
  aliases?: ReadonlyMap<string, string>;
}): { slots: SlotOption[]; patternsUsed: DraftMeeting[][] } {
  const aliases = args.aliases ?? new Map<string, string>();
  const patterns = args.patterns ?? standardPatterns(args.base);
  const pool = occupants(args.base, args.draft, args.subject);
  const avoid = args.avoidCourses.map(displayCourse);
  const avoidGroups = avoid
    .map((code) => ({
      label: code,
      sections: pool
        .filter((s) => courseCodes(s).includes(code))
        .map((s) => ({ crn: s.id, meetings: intervals(s) })),
    }))
    .filter((g) => g.sections.length > 0);

  const slots: SlotOption[] = [];
  for (const meetings of patterns) {
    const slotIv = intervals({
      id: "slot",
      course: "",
      sections: [],
      crns: [],
      meetings,
      building: null,
      room: null,
      instructors: [],
      cap: null,
    });
    if (avoidGroups.length > 0) {
      const r = searchCombinations({
        groups: avoidGroups,
        fixed: [],
        busy: [{ label: "this slot", meetings: slotIv }],
      });
      if (r.count === 0) continue;
    }
    const rooms = freeRooms(args.base, args.draft, meetings, {
      building: args.preferredBuilding,
      minCapacity: args.minCapacity,
      subject: args.subject,
    });
    if (rooms.length === 0) continue;
    const busy = args.instructors.filter((who) => {
      const k = canon(who, aliases);
      return pool.some(
        (s) =>
          s.instructors.some((i) => canon(i, aliases) === k) &&
          intervals(s).some((a) => slotIv.some((b) => overlap(a, b))),
      );
    });
    slots.push({
      meetings,
      rooms,
      instructorsFree: args.instructors.filter((w) => !busy.includes(w)),
      instructorsBusy: busy,
    });
  }
  return { slots, patternsUsed: patterns };
}
