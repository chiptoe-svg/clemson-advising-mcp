// src/refresh-plan.ts
// What the schedule refresh job does on one launchd firing. launchd fires it
// at 05:00 and hourly 08:00–17:00 every day; this decides, in Eastern time.
//
// Registration mode (Chip, 2026-10-28): inside a window from
// deploy/registration-windows.json, only that window's term is refreshed —
// hourly on weekdays 08–17, plus the nightly — which is what stops the
// current semester for the month. Outside every window: the nightly only,
// all live terms (selectRefreshTerms), as before. The nightly is "the first
// run of the Eastern day", so a 05:00 firing missed while the Mac slept still
// runs as the nightly when launchd fires it late.

export interface RegistrationWindow {
  term: string; // Banner term code, e.g. "202701"
  start: string; // YYYY-MM-DD, Eastern, inclusive
  end: string; // YYYY-MM-DD, Eastern, inclusive
}

export interface RefreshPlan {
  run: "nightly" | "hourly" | "skip";
  mode: "registration" | "normal";
  /** "live" = Banner's live terms (selectRefreshTerms); else these codes. */
  terms: "live" | string[];
  /** The Eastern date this run belongs to (recorded after a good nightly). */
  date: string;
}

function eastern(now: Date): { date: string; hour: number; weekday: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: parts.weekday,
  };
}

export function planRefresh(
  now: Date,
  windows: readonly RegistrationWindow[],
  lastNightlyDate: string | null,
): RefreshPlan {
  const { date, hour, weekday } = eastern(now);
  const win = windows.find((w) => w.start <= date && date <= w.end);
  const mode = win ? "registration" : "normal";
  const terms = win ? [win.term] : ("live" as const);
  if (lastNightlyDate !== date) return { run: "nightly", mode, terms, date };
  const weekdayHours =
    !["Sat", "Sun"].includes(weekday) && hour >= 8 && hour <= 17;
  if (win && weekdayHours) return { run: "hourly", mode, terms, date };
  return { run: "skip", mode, terms, date };
}
