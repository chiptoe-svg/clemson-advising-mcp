// One-off: add Banner's cross-list labels to term snapshots written before
// they were kept (2026-10-30). Fetches each term once (~22 requests) and
// changes nothing but the label column: past terms stay frozen otherwise.
//
//   npm run clemson:backfill-cross-list -- 202601 202508
import { fetchCrossListLabels } from "../src/clemson-classes.js";
import { backfillCrossList } from "../src/clemson-schedule-db.js";

const terms = process.argv.slice(2).filter((a) => /^\d{6}$/.test(a));
if (terms.length === 0) {
  console.error("Give one or more term codes, e.g. 202601 202508.");
  process.exit(2);
}

let failed = false;
for (const term of terms) {
  const labels = await fetchCrossListLabels(term);
  if (!labels) {
    console.log(`${term}: Banner scan incomplete — snapshot left unchanged.`);
    failed = true;
    continue;
  }
  const r = backfillCrossList(term, labels);
  if (r.ok)
    console.log(
      `${term}: ${r.labeled} cross-listed section(s) labeled; ` +
        `${r.unknownCrns} Banner CRN(s) not in the snapshot, ignored.`,
    );
  else {
    console.log(`${term}: not written (${r.reason}).`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
