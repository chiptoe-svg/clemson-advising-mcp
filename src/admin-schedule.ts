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
