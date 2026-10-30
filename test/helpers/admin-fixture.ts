// Builders for admin-scheduling fixtures: one Banner-shaped section per call,
// written into a temp STATE_DIR snapshot by the tests that use them.
export interface Meet {
  days: string;
  begin: string;
  end: string;
  building?: string | null;
  room?: string | null;
}

export function sec(
  crn: string,
  subjectCourse: string,
  section: string,
  meets: Meet[],
  opts: {
    instructor?: { name: string; email?: string | null } | null;
    cap?: number;
    enrollment?: number;
    crossList?: string | null;
  } = {},
) {
  const cap = opts.cap ?? 30;
  const enrollment = opts.enrollment ?? 0;
  return {
    crn,
    subjectCourse,
    section,
    title: subjectCourse,
    campus: "C",
    scheduleType: "Lecture",
    instructionalMethod: "F",
    partOfTerm: "1",
    crossList: opts.crossList ?? null,
    creditHours: 3,
    enrollment,
    maxEnrollment: cap,
    seatsAvailable: cap - enrollment,
    waitCount: 0,
    waitCapacity: 0,
    open: true,
    meetings: meets.map((m) => ({
      days: m.days,
      beginTime: m.begin,
      endTime: m.end,
      building: m.building === undefined ? "Godfrey Hall" : m.building,
      room: m.room === undefined ? "201" : m.room,
      type: "Class",
    })),
    instructors:
      opts.instructor === null
        ? []
        : [
            {
              name: opts.instructor?.name ?? "Pat Example",
              email:
                opts.instructor?.email === undefined
                  ? "pexample@clemson.edu"
                  : opts.instructor.email,
              primary: true,
            },
          ],
  };
}

export function snapshot(term: string, sections: ReturnType<typeof sec>[]) {
  return {
    term,
    termDescription: term,
    fetchedAt: "2026-10-28T09:00:00.000Z",
    sectionCount: sections.length,
    sections,
  };
}
