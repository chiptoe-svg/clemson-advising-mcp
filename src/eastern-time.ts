// Timestamps that reach the advising model must be unambiguous. Snapshots
// store fetched_at as UTC ISO ("…T09:02:12Z"); a model reading that string
// told an advisor "updated at 9:02 AM" when it was 5:02 AM Eastern
// (2026-08-26). Rendering the same instant with an explicit Eastern offset
// ("…T05:02:12.177-04:00") stays ISO 8601 / Date.parse-able and cannot be
// misread as a local clock time.
const EASTERN = "America/New_York";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Same instant as `iso`, written as ISO 8601 with the Eastern (America/New_York) offset. Unparseable input is returned unchanged. */
export function toEasternIso(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return iso;
  const p = Object.fromEntries(
    PARTS.formatToParts(d).map((x) => [x.type, x.value]),
  );
  const hour = p.hour === "24" ? "00" : p.hour;
  const local = `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}`;
  // Offset = (wall-clock instant read as UTC) − (true instant), in minutes.
  const asUtc = Date.UTC(
    +p.year,
    +p.month - 1,
    +p.day,
    +hour,
    +p.minute,
    +p.second,
  );
  const offsetMin = Math.round(
    (asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000,
  );
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `${local}.${ms}${sign}${hh}:${mm}`;
}
