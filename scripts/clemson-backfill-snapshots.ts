// One-off: correct past-term snapshots from Banner (2026-10-30) — add the
// cross-list labels (not kept before) and fix credit hours (variable-credit
// sections were stored at the course minimum before 3e8c25a). Fetches each
// term once (~22 requests) and changes those two columns only: past terms
// stay frozen otherwise.
//
//   npm run clemson:backfill -- 202601 202508
//
// SLOW BY DESIGN: Banner shuts out clients that send too many requests
// (Chip). Pages are 4 s apart, terms 3 minutes apart, and the run stops at
// the first failure of any kind — a failed scan may be throttling, and the
// answer to throttling is to stop, not to retry. Nothing is fetched for a
// term with no snapshot to correct, or for one the nightly still refreshes
// (written in the last week): its next refresh corrects it, and writing
// over it here could race that refresh.
import { fetchBackfillFields } from "../src/clemson-classes.js";
import {
  backfillBannerFields,
  getScheduleDbMeta,
  openScheduleDb,
} from "../src/clemson-schedule-db.js";

const BETWEEN_TERMS_MS = 3 * 60 * 1000;
const LIVE_IF_WRITTEN_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

const terms = process.argv.slice(2).filter((a) => /^\d{6}$/.test(a));
if (terms.length === 0) {
  console.error("Give one or more term codes, e.g. 202601 202508.");
  process.exit(2);
}

/** Why a term is skipped without a request, or null to fetch it. */
function skipReason(term: string): { stop: boolean; why: string } | null {
  const db = openScheduleDb(term);
  if (!db) return { stop: true, why: "no snapshot to correct" };
  try {
    const written = Date.parse(getScheduleDbMeta(db).fetchedAt);
    if (Date.now() - written < LIVE_IF_WRITTEN_WITHIN_MS)
      return {
        stop: false,
        why: "still refreshed nightly; its next refresh corrects it",
      };
    return null;
  } finally {
    db.close();
  }
}

let fetchedBefore = false;
let failed = false;
for (const term of terms) {
  const skip = skipReason(term);
  if (skip) {
    console.log(`${term}: skipped (${skip.why}).`);
    if (skip.stop) {
      failed = true;
      break;
    }
    continue;
  }
  if (fetchedBefore) {
    console.log(`Waiting ${BETWEEN_TERMS_MS / 60000} min before ${term}...`);
    await new Promise((r) => setTimeout(r, BETWEEN_TERMS_MS));
  }
  fetchedBefore = true;
  const fields = await fetchBackfillFields(term);
  if (!fields) {
    console.log(
      `${term}: Banner scan incomplete — snapshot left unchanged. ` +
        "Stopping here (possible throttling); rerun the remaining terms later.",
    );
    failed = true;
    break;
  }
  const r = backfillBannerFields(term, fields);
  if (!r.ok) {
    console.log(`${term}: not written (${r.reason}). Stopping here.`);
    failed = true;
    break;
  }
  console.log(
    `${term}: ${r.labeled} cross-listed section(s) labeled, ` +
      `${r.creditsChanged} credit-hour value(s) corrected; ` +
      `${r.unknownCrns} Banner CRN(s) not in the snapshot, ignored.`,
  );
  if (!r.recorded)
    console.log(
      `${term}: ${r.missingFromFetch} snapshot section(s) were not in ` +
        "Banner's answer, so their labels stay unknown and the snapshot " +
        "does not claim complete labels (tools keep their warning).",
    );
}
process.exit(failed ? 1 : 0);
