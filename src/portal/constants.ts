// Portal timing constants. ONE source of truth, on purpose.
//
// THE TWO CLOCKS MEASURE DIFFERENT THINGS, and the INEQUALITY BETWEEN THEM IS
// DELIBERATE. Do not "tidy" them to the same value.
//
//   PIN_TTL_HOURS    bounds ONE DELIVERY ATTEMPT. Short is correct; the
//                    resend button is the relief valve.
//   CLAIM_TTL_HOURS  bounds AN UNREDEEMED AUTHORIZATION. It must OUTLIVE the
//                    delivery attempts, or resend is decorative.
//
// WHY, concretely — this is what a brief period of equality broke:
//
//     roster sent   Fri 17:00Z
//     PIN expires   Sat 17:00Z     -> resend fixes this
//     CLAIM expires Sat 17:00Z     -> resend CANNOT fix this
//     person opens  Mon 09:00Z     -> back to Chip, for nearly everyone
//
// The justification for a 24h PIN is that a fresh code needs no new approval.
// That holds for the PIN and collapses the moment the claim expires alongside
// it, because a new code is then a key to a capability that no longer exists.
// A 7-day claim is what makes the 24h PIN safe to keep.
//
// An earlier version of this comment asserted the equality was deliberate and
// safe. It was neither — it was load-bearing in a way that disabled resend,
// and a confident comment saying "same on purpose" would have made that harder
// to find rather than easier. Kept as a note because a wrong comment outlives
// the code it describes (cf. the department policy doc, 2026-09-11).
//
// Owner decisions, 2026-09-13: PIN 24 hours, CLAIM 7 days. The gc_alumni repo
// carries CLAIM_TTL_S = 7*24*3600 and the same scenario beside it, so the two
// halves cannot silently disagree and neither can be "corrected" alone.
//
// HISTORY, so the number is not re-litigated from memory a fifth time: 30
// minutes sketched (wrong for the bulk case), 72 hours agreed across repos,
// 24 hours for both (broke resend), now 24 and 168.
export const PIN_TTL_HOURS = 24;
export const CLAIM_TTL_HOURS = 7 * 24;

/**
 * Codes a person may request for one claim before they must ask a human.
 * Bounded because an unbounded resend form is an email-sending oracle; the
 * resend path is also non-disclosing (it never confirms whether a grant
 * exists for an address) and never extends CLAIM_TTL_HOURS.
 */
export const MAX_PIN_RESENDS = 5;

/** Digits in an emailed PIN. Matches mailcal's send-on-decision contract (6-8). */
export const PIN_DIGITS = 6;
