// Refresh of Clemson per-term class snapshots, run by launchd at 05:00 and
// hourly 08:00–17:00. src/refresh-plan.ts decides what each firing does: the
// nightly (first run of the Eastern day) refreshes the live terms, and inside
// a registration window from deploy/registration-windows.json only that
// window's term is refreshed, hourly on weekdays too (Chip, 2026-10-28).
//
// Discovers the terms to refresh via Banner's getTerms: every non-View-Only
// (registering) term plus any published FUTURE term Banner still labels
// "(View Only)" (e.g. Spring 2027 before registration opens), and writes a
// full-section snapshot for each. Past "(View Only)" terms are skipped (they
// never change). See selectRefreshTerms in src/clemson-classes.ts. Run via
//   npm run clemson:refresh
// or the launchd job deploy/launchd/edu.clemson.advising-mcp.refresh.plist.

import fs from "node:fs";
import path from "node:path";

import {
  refreshLiveClemsonSnapshots,
  refreshClemsonSnapshot,
  type ClemsonRefreshResult,
} from "../src/clemson-classes.js";
import { STATE_DIR } from "../src/config-mcp.js";
import { planRefresh, type RegistrationWindow } from "../src/refresh-plan.js";

const WINDOWS_FILE = path.join(
  import.meta.dirname,
  "..",
  "deploy",
  "registration-windows.json",
);
const LAST_NIGHTLY = path.join(STATE_DIR, "clemson", "last-nightly");

function readWindows(): RegistrationWindow[] {
  try {
    const raw = JSON.parse(fs.readFileSync(WINDOWS_FILE, "utf8")) as unknown;
    const ok = (w: unknown): w is RegistrationWindow => {
      const x = w as Record<string, unknown>;
      return (
        /^\d{6}$/.test(String(x?.term)) &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(x?.start)) &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(x?.end))
      );
    };
    if (Array.isArray(raw) && raw.every(ok)) return raw;
    console.error(
      `${WINDOWS_FILE}: not a list of {term,start,end}; normal mode`,
    );
  } catch (e) {
    console.error(`${WINDOWS_FILE}: unreadable (${String(e)}); normal mode`);
  }
  return [];
}

function readLastNightly(): string | null {
  try {
    return fs.readFileSync(LAST_NIGHTLY, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function main() {
  // Explicit terms (e.g. `npm run clemson:refresh -- 202601 202505`) refresh
  // exactly those, regardless of View-Only status — used to backfill stable past
  // semesters that the live-term discovery deliberately skips. No args = the
  // normal daily job (discover + refresh the live/registering terms).
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (explicit.length > 0) {
    let failed = false;
    for (const term of explicit) {
      const snap = await refreshClemsonSnapshot(term);
      if (!snap) failed = true;
      console.log(
        `${term}: ${
          snap
            ? `${snap.sectionCount} sections (${snap.termDescription})`
            : "FAILED (snapshot left unchanged)"
        }`,
      );
    }
    if (failed) process.exitCode = 1;
    return;
  }

  const plan = planRefresh(new Date(), readWindows(), readLastNightly());
  console.log(
    `${new Date().toISOString()} refresh plan: ${plan.run}, ${plan.mode} mode, ` +
      `terms ${plan.terms === "live" ? "live" : plan.terms.join(",")} (${plan.date} ET)`,
  );
  if (plan.run === "skip") return;

  let results: ClemsonRefreshResult[];
  if (plan.terms === "live") {
    results = await refreshLiveClemsonSnapshots();
  } else {
    results = [];
    for (const term of plan.terms) {
      const snap = await refreshClemsonSnapshot(term);
      results.push({
        term,
        description: snap?.termDescription ?? term,
        sections: snap?.sectionCount ?? null,
      });
    }
  }
  // Only a nightly that refreshed every term counts: otherwise the next
  // firing (hourly) runs as the nightly again — a retry, not a skipped day.
  if (
    plan.run === "nightly" &&
    results.length > 0 &&
    results.every((r) => r.sections !== null)
  ) {
    fs.mkdirSync(path.dirname(LAST_NIGHTLY), { recursive: true });
    fs.writeFileSync(LAST_NIGHTLY, plan.date);
  }
  if (results.length === 0) {
    console.log("No live terms found (getTerms unavailable?).");
    return;
  }
  for (const r of results) {
    console.log(
      `${r.term} ${r.description}: ${
        r.sections === null
          ? "FAILED (snapshot left unchanged)"
          : `${r.sections} sections`
      }`,
    );
  }
  if (results.some((r) => r.sections === null)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
