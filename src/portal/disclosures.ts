// FALLBACK disclosure text. The claim endpoint is AUTHORITATIVE.
//
// gc_alumni's /claim returns `disclosure` in its 200 payload, computed on the
// side that owns the data and asserted against the database it actually serves
// (tests/test_disclosure_figures.py there recomputes the counts from
// db/alumni.db — not the published copy, which would pass while describing the
// wrong surface). So the page renders WHAT IT IS GIVEN; these strings exist
// only for the case where a response arrives without one.
//
// WHY A FALLBACK AT ALL, given the claim IS the mint and an unreachable
// endpoint means no token to show. Not for an outage — for a 200 that omits
// the field: an older build, a serialisation slip, a key renamed. Without a
// fallback, a missing disclosure renders as NO WARNING, and no warning reads
// as "nothing here needs one". That is the defect this project keeps meeting,
// and it would land on the one page where the holder learns what they hold.
//
// These will drift. That is acceptable and bounded: they are used only when
// the authoritative value is absent, and the owning repo has a test that fails
// when its figures stop matching the database. A stale fallback that names the
// right categories beats silence.
//
// The gc_alumni text deliberately OMITS one sentence the owning repo retains:
//   "It also returns graduates who asked to be left out of the student-facing
//    directory."
// Removed by the owner, 2026-09-13 — not lost in copying. It is kept on their
// side as OPT_OUT_SENTENCE with a test asserting it is absent from the default
// text, so restoring it here would reverse a decision rather than repair
// damage. Both repos record that.
export const FALLBACK_DISCLOSURE: Record<string, string> = {
  gc_alumni:
    "This token reads the complete alumni record for 3,135 Clemson Graphic " +
    "Communications graduates: email for 2,162 of them, phone for 2,318, " +
    "Clemson ID (CUID) for 896, plus full job history, LinkedIn profiles and " +
    "photographs. This is departmental data. Do not paste it into anything " +
    "that leaves Clemson, and do not share this token.",
  gc_careers:
    "This token reads published career data: aggregate graduate outcomes, " +
    "occupation and salary reference, and named graduates at companies and in " +
    "cities. It holds no email, no phone, no Clemson ID and no individual " +
    "salary figures, and it excludes graduates who opted out of the directory.",
};

/**
 * Servers whose grants must NEVER render without a disclosure. A missing one
 * is silence, and silence on this page reads as "nothing to warn about".
 */
export const DISCLOSURE_REQUIRED = Object.keys(FALLBACK_DISCLOSURE);

/** The authoritative value if given, else the fallback, else null. */
export function resolveDisclosure(
  server: string,
  returned?: string,
): string | null {
  if (returned && returned.trim()) return returned;
  return FALLBACK_DISCLOSURE[server] ?? null;
}
