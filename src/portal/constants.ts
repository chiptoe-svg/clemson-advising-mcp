// Portal timing constants. ONE source of truth, on purpose.
//
// THE TWO CLOCKS MEASURE DIFFERENT THINGS, and this is the thing to understand
// before changing either:
//
//   PIN_TTL_HOURS    bounds ONE DELIVERY ATTEMPT. Short is correct; the
//                    resend button is the relief valve.
//   CLAIM_TTL_HOURS  bounds AN UNREDEEMED AUTHORIZATION. It must OUTLIVE the
//                    delivery attempts, or resend is decorative.
//
// THE HOLE AS CURRENTLY CONFIGURED — read this before "tidying" anything here.
// With both at 24h and resend deliberately non-extending, the resend button
// cannot rescue the case it exists for:
//
//     roster sent   Fri 17:00Z
//     PIN expires   Sat 17:00Z     -> resend fixes this
//     CLAIM expires Sat 17:00Z     -> resend CANNOT fix this
//     person opens  Mon 09:00Z     -> back to Chip, for nearly everyone
//
// The justification for a 24h PIN was "workable because a fresh code needs no
// new approval". That holds for the PIN. It does NOT hold once the claim
// expires with it, because a new code is then a key to a capability that no
// longer exists. It is the same failure identified with a 30-minute PIN, moved
// down one layer.
//
// An earlier version of this comment said the equality was deliberate and
// safe. It was neither — it was load-bearing in a way that disables resend,
// and asserting "same on purpose" would have made that harder to spot rather
// than easier. Recorded because a confident comment that is wrong is worse
// than no comment (see the department-policy doc, 2026-09-11).
//
// STATUS: PIN at 24h is settled by the owner (2026-09-13). The claim window is
// under review with him; the gc_alumni session is raising the scenario above
// directly. Both repos currently carry 24h so they cannot silently disagree.
// The likely resting place is PIN 24h, CLAIM 7-14 days, resend still capped
// and still non-extending — which keeps every property wanted (a short
// delivery key, a bounded unredeemed capability, no extension by clicking)
// and makes the Friday roster work.
//
// HISTORY, so the number is not re-litigated from memory a fifth time: 30
// minutes sketched (wrong for bulk), 72 hours agreed across repos, 24 hours
// settled by the owner.
export const PIN_TTL_HOURS = 24;
export const CLAIM_TTL_HOURS = 24;

/**
 * Codes a person may request for one claim before they must ask a human.
 * Bounded because an unbounded resend form is an email-sending oracle; the
 * resend path is also non-disclosing (it never confirms whether a grant
 * exists for an address) and never extends CLAIM_TTL_HOURS.
 */
export const MAX_PIN_RESENDS = 5;

/** Digits in an emailed PIN. Matches mailcal's send-on-decision contract (6-8). */
export const PIN_DIGITS = 6;
