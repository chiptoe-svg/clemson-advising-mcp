// src/cross-list.ts
// When two sections are one class (Chip, 2026-10-30): Banner labels a
// cross-listing with a group code, and sections sharing one meet as a single
// class (honors 002 beside its lecture, 4xxx/6xxx pairs, 1990-4990 seminars).
// An UNLABELED 4xxx/6xxx pair of one subject, taught by one person at the
// same times (GC 4900 006 + GC 6900 002), counts as one class too, and is
// reported so the label gets fixed in Banner. Anything else that overlaps is
// a double booking, never one class.

export interface ClassKey {
  course: string; // "GC 4900" or "GC4900"
  crossList: string | null;
  /** Meeting times as one string (slotSignature); "" when untimed. */
  slots: string;
  instructors: readonly string[]; // compared as given; callers canonicalize
}

/** Days and times, sorted, as one comparable string; "" when untimed. */
export function slotSignature(
  meetings: readonly {
    day: string;
    start: string | number;
    end: string | number;
  }[],
): string {
  return meetings
    .map((m) => `${m.day} ${m.start}-${m.end}`)
    .sort()
    .join(";");
}

function parts(course: string): { subject: string; number: string } | null {
  const m = /^([A-Z]+)\s*(\d{4})$/.exec(course.trim().toUpperCase());
  return m ? { subject: m[1]!, number: m[2]! } : null;
}

/** An unlabeled 4xxx/6xxx pair: one subject, numbers 4abc and 6abc, the same
 *  meeting times, a shared instructor, and no shared Banner label. */
export function isUnlabeledGradPair(a: ClassKey, b: ClassKey): boolean {
  if (a.crossList && a.crossList === b.crossList) return false;
  const pa = parts(a.course);
  const pb = parts(b.course);
  if (!pa || !pb || pa.subject !== pb.subject) return false;
  if (pa.number.slice(1) !== pb.number.slice(1)) return false;
  const levels = [pa.number[0], pb.number[0]].sort().join("");
  if (levels !== "46") return false;
  if (!a.slots || a.slots !== b.slots) return false;
  return a.instructors.some((x) => b.instructors.includes(x));
}

export function sameClass(a: ClassKey, b: ClassKey): boolean {
  if (a.crossList && a.crossList === b.crossList) return true;
  return isUnlabeledGradPair(a, b);
}
