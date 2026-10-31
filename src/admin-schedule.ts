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
//
// Cross-listed means Banner's cross-list label, or an unlabeled 4xxx/6xxx
// pair at the same times with the same instructor (src/cross-list.ts). Any
// other overlap is a double booking, even in one room with one instructor
// (Chip, 2026-10-30).

import type Database from "better-sqlite3";

import { roomCapacity } from "./clemson-room-capacity.js";
import { minsToHHMM } from "./clemson-schedule-db.js";
import type { InstructorPreference } from "./instructor-preferences.js";
import { searchCombinations } from "./section-combinations.js";
import { crossListRecorded } from "./clemson-schedule-db.js";
import {
  isGradPairCourses,
  isUnlabeledGradPair,
  slotSignature,
  type ClassKey,
} from "./cross-list.js";

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
  /**
   * Expected class size — what the room must actually hold. Rollover sets it
   * to the base term's enrollment plus waitlist (demand, not the seat limit);
   * a forecast can replace it later. Absent = unknown.
   */
  expected?: number | null;
  /** Banner's cross-list group ("GC3"). Absent: looked up by CRN in the
   *  base term, so a page need not carry it. */
  crossList?: string | null;
}

export interface BaseSection extends DraftSection {
  expected: number;
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

/** One row per CRN, unstacked. Callers stack with stackSections. Banner's
 *  cross-list labels are read only from a snapshot that records them all:
 *  a few labels (a slice write-back, a partial backfill) would switch the
 *  term to the labels rule while most pairs' labels are unknown. */
export function loadBaseSections(
  db: Database.Database,
  term: string,
): BaseSection[] {
  const rows = db
    .prepare(
      `SELECT crn, subject_course, section, title, enrollment, max_enrollment,
              wait_count,
              ${crossListRecorded(db) ? "cross_list" : "NULL AS cross_list"}
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
    cross_list: string | null;
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
      expected: r.enrollment + r.wait_count,
      subject: course.split(" ")[0]!,
      title: r.title,
      enrollment: r.enrollment,
      waitCount: r.wait_count,
      roomCapacity: roomCapacity(building, room),
      crossList: r.cross_list,
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

/** Whether a term's sections carry Banner's cross-list labels at all: a
 *  snapshot written before they were kept has none. */
export function hasCrossListLabels(base: readonly DraftSection[]): boolean {
  return base.some((b) => !!b.crossList);
}

/**
 * Merge sections that meet together (identical meetings, room and
 * instructors) into one, across course numbers. Sections with no meeting
 * time or no real room never stack. With Banner's labels known
 * (`labelsKnown`), identical sections stack only when they are one class —
 * the same label, or an unlabeled 4xxx/6xxx pair — so an unlabeled clash
 * stays two entries the checker can see (2026-10-30). Without labels (older
 * snapshots), identical is enough, or every honors pair would read as a
 * clash.
 */
export function stackSections<T extends DraftSection>(
  sections: readonly T[],
  labelsKnown = false,
): T[] {
  const out: T[] = [];
  const byKey = new Map<string, T[]>();
  // An unlabeled entry takes only its one 4xxx/6xxx partner: once it is a
  // pair, an identical third section is a clash, not more of the class.
  const oneClass = (a: T, b: T) =>
    !labelsKnown ||
    (a.crossList
      ? a.crossList === b.crossList
      : !b.crossList &&
        a.crns.length === 1 &&
        isGradPairCourses(a.course, displayCourse(b.course)));
  for (const s of sections) {
    const key = stackKey(s);
    const into = key
      ? (byKey.get(key) ?? []).find((e) => oneClass(e, s))
      : undefined;
    if (!into) {
      const copy = { ...s, sections: [...s.sections], crns: [...s.crns] };
      out.push(copy);
      if (key) byKey.set(key, [...(byKey.get(key) ?? []), copy]);
      continue;
    }
    into.crns.push(...s.crns);
    into.sections.push(...s.sections);
    into.crossList ??= s.crossList;
    into.id = into.crns.join("+");
    into.cap =
      into.cap == null || s.cap == null
        ? (into.cap ?? s.cap)
        : into.cap + s.cap;
    if (into.expected != null || s.expected != null)
      into.expected = (into.expected ?? 0) + (s.expected ?? 0);
    if (s.course !== into.course && !into.course.includes(s.course))
      into.course = `${into.course} / ${s.course}`;
  }
  return out;
}

/** The subjects a draft owns: one code, or several comma-separated
 *  ("GC,PKSC") when departments plan together. */
export function subjectSet(subject: string): Set<string> {
  return new Set(
    subject
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * The base term's sections outside `subject` — other departments' fixed
 * commitments — minus any that meet together with one of the subject's own
 * sections (a cross-listing like GC 4900 with PKSC 4900): those move with
 * the subject's section, so they are not someone else's booking.
 */
export function othersOf(
  base: readonly BaseSection[],
  subject: string,
): BaseSection[] {
  const subjs = subjectSet(subject);
  const mine = base.filter((b) => subjs.has(b.subject));
  // Without Banner labels, an identical section is taken as a partner (the
  // old rule); with them, only a shared label is (2026-10-30).
  const own = new Set(
    hasCrossListLabels(base)
      ? []
      : mine.map(stackKey).filter((k): k is string => k !== null),
  );
  // A cross-listing partner (Banner label) moves with the subject's section.
  const ownLabels = new Set(
    mine.map((b) => b.crossList).filter((c): c is string => !!c),
  );
  return base.filter((b) => {
    if (subjs.has(b.subject)) return false;
    if (b.crossList && ownLabels.has(b.crossList)) return false;
    const k = stackKey(b);
    return !k || !own.has(k);
  });
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
  | "room_too_small_for_expected"
  | "meets_together"
  | "room_unknown"
  | "no_meeting_time"
  | "instructor_preference"
  | "room_need";

/** A course's room needs (check-schedule-draft `courses`): allowed rooms as
 *  "Building Room", and/or a minimum seat count. */
export interface RoomNeed {
  rooms?: string[];
  minSize?: number;
}

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

/** "Godfrey Hall 101C" → "godfrey hall|101c", the lowercased place key. */
function roomKey(name: string): string {
  const m = /^(.*\S)\s+(\S+)$/.exec(name.trim());
  return (m ? `${m[1]}|${m[2]}` : name.trim()).toLowerCase();
}

export function courseCodes(s: DraftSection): string[] {
  return s.course.split(" / ").map((c) => displayCourse(c));
}

/**
 * Whether two sections are one class (Chip, 2026-10-30): the same Banner
 * cross-list label — a section's own crossList, else the base term's by CRN,
 * so a page that drops the field still gets them — or an unlabeled
 * 4xxx/6xxx pair at the same times with the same instructor. Null: two
 * classes, so any overlap between them is a double booking.
 */
export function crossListJudge(
  base: readonly BaseSection[],
  aliases: ReadonlyMap<string, string>,
): (a: DraftSection, b: DraftSection) => { label: string | null } | null {
  const labelByCrn = new Map<string, string>();
  for (const b of base)
    if (b.crossList) for (const c of b.crns) labelByCrn.set(c, b.crossList);
  const labelsOf = (s: DraftSection) => {
    const out = new Set<string>();
    if (s.crossList) out.add(s.crossList);
    for (const c of s.crns) {
      const l = labelByCrn.get(c);
      if (l) out.add(l);
    }
    return out;
  };
  const classKey = (s: DraftSection, course: string): ClassKey => ({
    course,
    crossList: null,
    slots: slotSignature(
      s.meetings.flatMap((m) =>
        [...m.days].map((day) => ({ day, start: m.start, end: m.end })),
      ),
    ),
    instructors: s.instructors.map((i) => canon(i, aliases)),
  });
  // A pair is two single sections: a stacked entry already holds its
  // partner, so an identical third section is a clash, not part of it.
  const single = (s: DraftSection) =>
    s.crns.length <= 1 && courseCodes(s).length === 1;
  return (a, b) => {
    const mine = labelsOf(a);
    const theirs = labelsOf(b);
    for (const l of theirs) if (mine.has(l)) return { label: l };
    // A labeled section already says which class it belongs to.
    if (mine.size || theirs.size || !single(a) || !single(b)) return null;
    return isUnlabeledGradPair(
      classKey(a, courseCodes(a)[0]!),
      classKey(b, courseCodes(b)[0]!),
    )
      ? { label: null }
      : null;
  };
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
  extra: {
    preferences?: ReadonlyMap<string, InstructorPreference>;
    /** Keyed by course code ("GC 4061"); a stacked block meets all of its
     *  courses' needs. */
    roomNeeds?: ReadonlyMap<string, RoomNeed>;
  } = {},
): {
  problems: Problem[];
  groupsChecked: {
    name: string;
    combinations: number | null;
    missing: string[];
  }[];
} {
  const others = othersOf(base, subject);
  const iv = new Map(draft.map((s) => [s.id, intervals(s)]));
  const otherIv = others.map((o) => ({ o, iv: intervals(o) }));
  const who = (s: DraftSection) =>
    new Set(s.instructors.map((i) => canon(i, aliases)));

  const judge = crossListJudge(base, aliases);
  /** Why `a` and `b` are one class, or null when they are two. */
  const oneClass = (a: DraftSection, b: DraftSection): string | null => {
    const j = judge(a, b);
    if (!j) return null;
    return j.label
      ? `cross-listed with ${describe(b)} (Banner cross-list ${j.label}) — one class`
      : `meets with ${describe(b)}: a 4xxx/6xxx pair counted as one class, but not labeled as cross-listed in Banner`;
  };

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

  // Preferences keyed by canonical identity, so a file naming someone by
  // name matches a draft naming them by email (and the reverse).
  const prefs = new Map(
    [...(extra.preferences ?? [])].map(([k, p]) => [
      canon(k, aliases),
      { who: k, p },
    ]),
  );
  for (const [key, { who: name, p }] of prefs) {
    if (p.maxSections === undefined) continue;
    const theirs = draft.filter((s) => who(s).has(key));
    // A cross-listed group counts once (Chip, 2026-10-30).
    // Joins only a group it is one class with in full — no chaining.
    const classes: DraftSection[][] = [];
    for (const s of theirs) {
      const g = classes.find((g) => g.every((t) => oneClass(s, t)));
      if (g) g.push(s);
      else classes.push([s]);
    }
    if (classes.length > p.maxSections)
      for (const s of theirs)
        add(
          s.id,
          "instructor_preference",
          `${name} teaches ${classes.length} sections in this draft (a cross-listed group counts once); their limit is ${p.maxSections}`,
          theirs.filter((t) => t !== s).map((t) => t.id),
        );
  }

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
      const shared = [...who(t)].filter((x) => myWho.has(x));
      const timeOverlap = mine.some((a) => theirs.some((b) => overlap(a, b)));
      const together = timeOverlap ? oneClass(s, t) : null;
      if (together) add(s.id, "meets_together", together, [t.id]);
      else {
        if (roomClash)
          add(
            s.id,
            "room_double_booked",
            `${roomClash.place!.replace("|", " ")} also holds ${describe(t)}`,
            [t.id],
          );
        if (shared.length > 0 && timeOverlap)
          add(
            s.id,
            "instructor_double_booked",
            `${shared.join(", ")} also teaches ${describe(t)}`,
            [t.id],
          );
      }
    }

    for (const { o, iv: theirs } of otherIv) {
      const roomClash = mine.find((a) =>
        theirs.some((b) => a.place && a.place === b.place && overlap(a, b)),
      );
      const shared = o.instructors
        .map((i) => canon(i, aliases))
        .filter((x) => myWho.has(x));
      const together = mine.some((a) => theirs.some((b) => overlap(a, b)))
        ? oneClass(s, o)
        : null;
      if (together) add(s.id, "meets_together", together);
      else {
        if (roomClash)
          add(
            s.id,
            "room_used_by_other_department",
            `${roomClash.place!.replace("|", " ")} is booked by ${describe(o)}`,
          );
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
    }

    for (const key of myWho) {
      const hit = prefs.get(key);
      if (!hit) continue;
      const { who: name, p } = hit;
      for (const m of s.meetings) {
        const days = [...m.days].filter((x) => p.avoidDays?.includes(x));
        if (days.length > 0)
          add(
            s.id,
            "instructor_preference",
            `${name} avoids ${p.avoidDays}; ${describe(s)} meets ${days.join("")}`,
          );
        if (p.notBefore && hhmmToMins(m.start) < hhmmToMins(p.notBefore))
          add(
            s.id,
            "instructor_preference",
            `${name} prefers nothing before ${p.notBefore}; ${describe(s)} starts at ${m.start}`,
          );
        if (p.notAfter && hhmmToMins(m.end) > hhmmToMins(p.notAfter))
          add(
            s.id,
            "instructor_preference",
            `${name} prefers nothing after ${p.notAfter}; ${describe(s)} ends at ${m.end}`,
          );
      }
    }

    const places = [
      ...new Set(mine.map((m) => m.place).filter((x): x is string => !!x)),
    ];
    for (const code of courseCodes(s)) {
      const need = extra.roomNeeds?.get(code);
      if (!need) continue;
      if (need.rooms && need.rooms.length > 0) {
        const allowed = new Set(need.rooms.map(roomKey));
        for (const place of places)
          if (!allowed.has(place.toLowerCase()))
            add(
              s.id,
              "room_need",
              `${place.replace("|", " ")} is not one of ${code}'s rooms (${need.rooms.join(", ")})`,
            );
      }
      if (need.minSize !== undefined)
        for (const place of places) {
          const [b, r] = place.split("|") as [string, string];
          const seats = roomCapacity(b, r);
          if (seats != null && seats < need.minSize)
            add(
              s.id,
              "room_need",
              `${b} ${r} seats ${seats}; ${code} needs at least ${need.minSize}`,
            );
        }
    }

    const capacity = roomCapacity(s.building, s.room);
    if (capacity != null) {
      const expected = s.expected ?? null;
      if (s.cap != null && s.cap > capacity)
        add(
          s.id,
          "room_too_small",
          `${s.building} ${s.room} seats ${capacity}; the section caps at ${s.cap}`,
        );
      else if (expected != null && expected > capacity)
        add(
          s.id,
          "room_too_small_for_expected",
          `${s.building} ${s.room} seats ${capacity}; about ${expected} students are expected`,
        );
    }
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
    // Draft sections are keyed by their id; base sections by a "base:" CRN,
    // since a draft id (a CRN from another term) can equal one of them.
    const draftSet = new Set<DraftSection>(draft);
    const key = (x: DraftSection) => (draftSet.has(x) ? x.id : `base:${x.id}`);
    const r = searchCombinations({
      groups: present.map((n) => ({
        label: n.label,
        sections: n.sections.map((x) => ({
          crn: key(x),
          meetings: draftSet.has(x) ? iv.get(x.id)! : intervals(x),
        })),
      })),
      fixed: [],
      busy: [],
    });
    if (r.count === 0 && r.complete) {
      const why = r.blocking.map((b) => b.reason).join("; ");
      const inDraft = present.flatMap((p) =>
        p.sections.filter((x) => draftSet.has(x)),
      );
      for (const x of inDraft)
        add(
          x.id,
          "group_clash",
          `group "${g.name}": ${why}`,
          inDraft.filter((y) => y !== x).map((y) => y.id),
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

/** A meeting pattern's weekly minutes and meetings per week. */
export function patternLength(meetings: readonly DraftMeeting[]): {
  weekly_minutes: number;
  meetings_per_week: number;
} {
  let weekly = 0;
  let count = 0;
  for (const m of meetings) {
    weekly += (hhmmToMins(m.end) - hhmmToMins(m.start)) * m.days.length;
    count += m.days.length;
  }
  return { weekly_minutes: weekly, meetings_per_week: count };
}

/** Longest a meeting runs and still counts as a lecture-grid meeting
 *  (50 and 75 minutes; a lab's 165 does not). */
const LECTURE_MEETING_MAX = 80;

/**
 * The base term's patterns as long as one of `shapes`: weekly minutes within
 * 10%, and the same meetings per week — except that lecture-grid patterns
 * (every meeting at most 80 minutes) may trade MWF 50s for TR 75s. So a
 * 165-minute lab is never offered a 50-minute slot or two 75s, while a
 * lecture can still change grids. Each shape itself comes first (a section's
 * own time is an option the slot cap must never cut), then the most common.
 */
export function patternsLike(
  base: readonly BaseSection[],
  shapes: readonly DraftMeeting[][],
  limit = 12,
): DraftMeeting[][] {
  const lectureGrid = (p: readonly DraftMeeting[]) =>
    p.every(
      (m) => hhmmToMins(m.end) - hhmmToMins(m.start) <= LECTURE_MEETING_MAX,
    );
  const refs = shapes.map((sh) => ({
    ...patternLength(sh),
    grid: lectureGrid(sh),
  }));
  const like = (p: readonly DraftMeeting[]) => {
    const l = patternLength(p);
    const grid = lectureGrid(p);
    return refs.some(
      (r) =>
        Math.abs(l.weekly_minutes - r.weekly_minutes) <=
          0.1 * r.weekly_minutes &&
        (l.meetings_per_week === r.meetings_per_week || (grid && r.grid)),
    );
  };
  const out: DraftMeeting[][] = [];
  const seen = new Set<string>();
  for (const sh of shapes) {
    const k = patternKey(sh);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(sh.map(({ days, start, end }) => ({ days, start, end })));
  }
  for (const p of standardPatterns(base, Infinity).filter(like)) {
    if (out.length >= shapes.length + limit) break;
    const k = patternKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
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
  return [...(subject ? othersOf(base, subject) : base), ...draft];
}

/**
 * Rooms with no class booked in the window. "Rooms" are the real rooms the
 * base term's meetings use — a room no class used is invisible here.
 */
export function freeRooms(
  base: readonly BaseSection[],
  draft: readonly DraftSection[] | null,
  meetings: readonly DraftMeeting[],
  opts: {
    building?: string;
    minCapacity?: number;
    subject?: string;
    /** A course whose own sections are being moved, so free their rooms. */
    ignoreCourse?: string;
  } = {},
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
  const ignore = opts.ignoreCourse ? displayCourse(opts.ignoreCourse) : null;
  for (const s of occupants(base, draft, opts.subject)) {
    if (ignore && courseCodes(s).includes(ignore)) continue;
    for (const iv of intervals(s))
      if (iv.place && want.some((w) => overlap(w, iv))) busy.add(iv.place);
  }
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
  avoidCourses?: string[];
  /** Needs to keep workable, each a list of alternative courses (from a
   *  course group); avoidCourses are added as single-course needs. */
  avoidNeeds?: string[][];
  instructors: string[];
  preferredBuilding: string;
  minCapacity?: number;
  /** Rooms must hold this many (combined with minCapacity, the larger wins). */
  expectedSize?: number;
  /** The course being placed: its own current sections don't occupy rooms
   *  or instructors, since they are what is being moved. */
  course?: string;
  patterns?: DraftMeeting[][];
  aliases?: ReadonlyMap<string, string>;
}): { slots: SlotOption[]; patternsUsed: DraftMeeting[][] } {
  const aliases = args.aliases ?? new Map<string, string>();
  const patterns = args.patterns ?? standardPatterns(args.base);
  // Without a draft, the placed course's base sections are what's being
  // moved. With a draft, the draft already says where its sections are.
  const self = args.course && !args.draft ? displayCourse(args.course) : null;
  const pool = occupants(args.base, args.draft, args.subject).filter(
    (s) => !self || !courseCodes(s).includes(self),
  );
  const needs = [
    ...(args.avoidNeeds ?? []).map((n) => n.map(displayCourse)),
    ...(args.avoidCourses ?? []).map((c) => [displayCourse(c)]),
  ];
  const avoidGroups = needs
    .map((codes) => ({
      label: codes.join("/"),
      sections: pool
        .filter((s) => courseCodes(s).some((c) => codes.includes(c)))
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
      minCapacity:
        Math.max(args.minCapacity ?? 0, args.expectedSize ?? 0) || undefined,
      subject: args.subject,
      ignoreCourse: self ?? undefined,
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

// --- Conflict report (2026-10-30) -------------------------------------------

/** One section in a conflict report. */
export interface ReportSection {
  crn: string;
  course: string;
  section: string;
  meetings: DraftMeeting[];
  building: string | null;
  room: string | null;
  instructors: string[];
}

export interface DoubleBooking {
  kind: "room" | "instructor" | "room_used_by_other_department";
  sections: ReportSection[];
  detail: string;
  /** Identical meetings, room and instructors: probably a cross-listing
   *  missing its Banner label rather than a real clash. */
  likely_missing_label?: true;
}

export interface UnlabeledPair {
  sections: ReportSection[];
  note: string;
}

/**
 * A published term's double bookings for one subject, outside cross-listed
 * classes, and its unlabeled 4xxx/6xxx pairs (Chip, 2026-10-30). Sections are
 * compared one CRN at a time — never stacked first, since stacking would hide
 * two unlabeled sections that only look alike — against each other and
 * against other departments' sections. Each clash is reported once per pair.
 */
export function findConflicts(
  base: readonly BaseSection[],
  subject: string,
  aliases: ReadonlyMap<string, string> = new Map(),
): { doubleBookings: DoubleBooking[]; unlabeled: UnlabeledPair[] } {
  const subjs = subjectSet(subject);
  const own = base.filter((b) => subjs.has(b.subject));
  const others = othersOf(base, subject);
  const judge = crossListJudge(base, aliases);
  const iv = new Map(base.map((s) => [s.id, intervals(s)]));
  const who = (s: DraftSection) =>
    new Set(s.instructors.map((i) => canon(i, aliases)));
  const out = (s: BaseSection): ReportSection => ({
    crn: s.crns[0]!,
    course: s.course,
    section: s.sections[0]!,
    meetings: s.meetings,
    building: s.building,
    room: s.room,
    instructors: s.instructors,
  });

  const doubleBookings: DoubleBooking[] = [];
  const unlabeled: UnlabeledPair[] = [];
  const compare = (a: BaseSection, b: BaseSection, otherDept: boolean) => {
    const ia = iv.get(a.id)!;
    const ib = iv.get(b.id)!;
    if (!ia.some((x) => ib.some((y) => overlap(x, y)))) return;
    const j = judge(a, b);
    if (j) {
      if (j.label === null)
        unlabeled.push({
          sections: [out(a), out(b)],
          note:
            "Same instructor and times, counted as one class, but not " +
            "labeled as cross-listed in Banner: ask for the cross-list label.",
        });
      return;
    }
    const likely =
      stackKey(a) !== null && stackKey(a) === stackKey(b)
        ? { likely_missing_label: true as const }
        : {};
    const clash = ia.find((x) =>
      ib.some((y) => x.place && x.place === y.place && overlap(x, y)),
    );
    if (clash)
      doubleBookings.push({
        kind: otherDept ? "room_used_by_other_department" : "room",
        sections: [out(a), out(b)],
        detail: `${clash.place!.replace("|", " ")} holds both at overlapping times`,
        ...likely,
      });
    const shared = [...who(a)].filter((x) => who(b).has(x));
    if (shared.length)
      doubleBookings.push({
        kind: "instructor",
        sections: [out(a), out(b)],
        detail: `${shared.join(", ")} teach${shared.length === 1 ? "es" : ""} both at overlapping times`,
        ...likely,
      });
  };
  for (const [i, a] of own.entries()) {
    for (const b of own.slice(i + 1)) compare(a, b, false);
    for (const o of others) compare(a, o, true);
  }
  return { doubleBookings, unlabeled };
}
