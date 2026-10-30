// One-off: correct past-term snapshots from Banner (2026-10-30) — add the
// cross-list labels (not kept before) and fix credit hours (variable-credit
// sections were stored at the course minimum before 3e8c25a). Fetches each
// term once (~22 requests) and changes those two columns only: past terms
// stay frozen otherwise.
//
// SLOW BY DESIGN: Banner shuts out clients that send too many requests
// (Chip). Pages are 4 s apart, terms 3 minutes apart, and the run stops at
// the first term whose scan fails — a failure may be throttling, and the
// answer to throttling is to stop, not to retry.
//
//   npm run clemson:backfill -- 202601 202508
import { fetchBackfillFields } from "../src/clemson-classes.js";
import { backfillBannerFields } from "../src/clemson-schedule-db.js";

const terms = process.argv.slice(2).filter((a) => /^\d{6}$/.test(a));
if (terms.length === 0) {
  console.error("Give one or more term codes, e.g. 202601 202508.");
  process.exit(2);
}

const BETWEEN_TERMS_MS = 3 * 60 * 1000;
let failed = false;
for (const [i, term] of terms.entries()) {
  if (i > 0) {
    console.log(`Waiting ${BETWEEN_TERMS_MS / 60000} min before ${term}...`);
    await new Promise((r) => setTimeout(r, BETWEEN_TERMS_MS));
  }
  const labels = await fetchBackfillFields(term);
  if (!labels) {
    console.log(
      `${term}: Banner scan incomplete — snapshot left unchanged. ` +
        "Stopping here (possible throttling); rerun the remaining terms later.",
    );
    failed = true;
    break;
  }
  const r = backfillBannerFields(term, labels);
  if (r.ok)
    console.log(
      `${term}: ${r.labeled} cross-listed section(s) labeled, ` +
        `${r.creditsChanged} credit-hour value(s) corrected; ` +
        `${r.unknownCrns} Banner CRN(s) not in the snapshot, ignored.`,
    );
  else {
    console.log(`${term}: not written (${r.reason}).`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
